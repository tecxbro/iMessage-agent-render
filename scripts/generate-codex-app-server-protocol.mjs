import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const target = join(
  repositoryRoot,
  "src",
  "agent",
  "codex-app-server",
  "generated",
);

export class GeneratedBindingsRollbackError extends AggregateError {
  constructor(replacementError, restoreError, targetDirectory, backupDirectory) {
    super(
      [replacementError, restoreError],
      `Could not install generated bindings or restore the prior bindings. Recover ${targetDirectory} from ${backupDirectory} before retrying.`,
    );
    this.name = "GeneratedBindingsRollbackError";
    this.backupDirectory = backupDirectory;
  }
}

function hasErrorCode(error, code) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export async function replaceGeneratedDirectory({
  targetDirectory,
  stagedDirectory,
  backupDirectory,
  renameDirectory = rename,
}) {
  try {
    await renameDirectory(targetDirectory, backupDirectory);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
    await renameDirectory(stagedDirectory, targetDirectory);
    return;
  }

  try {
    await renameDirectory(stagedDirectory, targetDirectory);
  } catch (replacementError) {
    try {
      await renameDirectory(backupDirectory, targetDirectory);
    } catch (restoreError) {
      throw new GeneratedBindingsRollbackError(
        replacementError,
        restoreError,
        targetDirectory,
        backupDirectory,
      );
    }
    throw new Error(
      `Could not install generated bindings at ${targetDirectory}; the prior bindings were restored.`,
      { cause: replacementError },
    );
  }
}

async function normalizeNodeNextImports(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await normalizeNodeNextImports(path);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) {
      continue;
    }
    const source = await readFile(path, "utf8");
    const normalized = source.replace(
      /(from\s+["'])(\.{1,2}\/[^"']+)(["'])/gu,
      (_match, prefix, specifier, suffix) => {
        const nodeSpecifier =
          specifier === "./v2"
            ? "./v2/index.js"
            : specifier.endsWith(".js")
              ? specifier
              : `${specifier}.js`;
        return `${prefix}${nodeSpecifier}${suffix}`;
      },
    );
    if (normalized !== source) {
      await writeFile(path, normalized, "utf8");
    }
  }
}

async function updateDirectoryDigest(hash, directory, relativeDirectory = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );

  for (const entry of entries) {
    const relativePath = join(relativeDirectory, entry.name);
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      hash.update(`directory\0${relativePath}\0`);
      await updateDirectoryDigest(hash, path, relativePath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Generated bindings contain an unsupported entry: ${path}`);
    }
    hash.update(`file\0${relativePath}\0`);
    hash.update(await readFile(path));
    hash.update("\0");
  }
}

async function directoryDigest(directory) {
  const hash = createHash("sha256");
  await updateDirectoryDigest(hash, directory);
  return hash.digest("hex");
}

async function generatedBindingsAreFresh(stagedDirectory, targetDirectory) {
  try {
    const [stagedDigest, targetDigest] = await Promise.all([
      directoryDigest(stagedDirectory),
      directoryDigest(targetDirectory),
    ]);
    return stagedDigest === targetDigest;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function main() {
  const argumentsList = process.argv.slice(2);
  const checkOnly = argumentsList.length === 1 && argumentsList[0] === "--check";
  if (argumentsList.length > 0 && !checkOnly) {
    throw new Error(
      "Unsupported arguments. Run without arguments to generate bindings or with --check to verify freshness.",
    );
  }

  const packageJson = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  const cliVersion = packageJson.dependencies?.["@openai/codex"];
  const sdkVersion = packageJson.dependencies?.["@openai/codex-sdk"];

  if (
    typeof cliVersion !== "string" ||
    typeof sdkVersion !== "string" ||
    cliVersion !== sdkVersion ||
    !/^\d+\.\d+\.\d+$/.test(cliVersion)
  ) {
    throw new Error(
      "@openai/codex and @openai/codex-sdk must use the same exact version before protocol generation.",
    );
  }

  const generationMetadata = await readFile(
    join(
      repositoryRoot,
      "src",
      "agent",
      "codex-app-server",
      "protocol-generation.ts",
    ),
    "utf8",
  );
  if (
    !generationMetadata.includes(
      `CODEX_APP_SERVER_PROTOCOL_VERSION = "${cliVersion}"`,
    )
  ) {
    throw new Error(
      "protocol-generation.ts must match the exact pinned Codex version.",
    );
  }

  const targetParent = dirname(target);
  await mkdir(targetParent, { recursive: true });
  const temporaryRoot = await mkdtemp(
    join(targetParent, ".generated-staging-"),
  );
  const temporaryOutput = join(temporaryRoot, "next");
  const backup = join(temporaryRoot, "previous");
  let preserveTemporaryRoot = false;
  const generatorEnvironment = {
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...(process.env.LANG === undefined ? {} : { LANG: process.env.LANG }),
    ...(process.env.LC_ALL === undefined ? {} : { LC_ALL: process.env.LC_ALL }),
    ...(process.env.LC_CTYPE === undefined
      ? {}
      : { LC_CTYPE: process.env.LC_CTYPE }),
  };

  try {
    const codexEntry = join(
      repositoryRoot,
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    const version = spawnSync(process.execPath, [codexEntry, "--version"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: generatorEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (
      version.status !== 0 ||
      version.stdout.trim() !== `codex-cli ${cliVersion}`
    ) {
      throw new Error(
        `Installed Codex CLI does not match package.json (${cliVersion}).`,
      );
    }
    const generated = spawnSync(
      process.execPath,
      [codexEntry, "app-server", "generate-ts", "--out", temporaryOutput],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: generatorEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (generated.status !== 0) {
      throw new Error(
        `Codex App Server protocol generation failed: ${generated.stderr.trim()}`,
      );
    }

    const requiredFiles = [
      "ClientRequest.ts",
      "ServerNotification.ts",
      "ServerRequest.ts",
      join("v2", "ThreadStartParams.ts"),
      join("v2", "TurnSteerParams.ts"),
    ];
    await Promise.all(
      requiredFiles.map(async (relativePath) => {
        const contents = await readFile(
          join(temporaryOutput, relativePath),
          "utf8",
        );
        if (!contents.includes("GENERATED CODE! DO NOT MODIFY BY HAND!")) {
          throw new Error(
            `Generated binding is missing its marker: ${relativePath}`,
          );
        }
      }),
    );

    // The upstream generator emits extensionless relative imports. Normalize
    // only those specifiers for this NodeNext repository; the generated types
    // and protocol surface remain unchanged.
    await normalizeNodeNextImports(temporaryOutput);
    await writeFile(
      join(temporaryOutput, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(temporaryOutput, "protocol-version.json"),
      `${JSON.stringify(
        {
          codex: cliVersion,
          codexSdk: sdkVersion,
          experimental: false,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    if (checkOnly) {
      if (!(await generatedBindingsAreFresh(temporaryOutput, target))) {
        throw new Error(
          `Codex App Server bindings are stale for ${cliVersion}. Run node scripts/generate-codex-app-server-protocol.mjs and commit the result.`,
        );
      }
      process.stdout.write(
        `Codex App Server bindings are fresh for ${cliVersion} at ${target}\n`,
      );
      return;
    }

    try {
      await replaceGeneratedDirectory({
        targetDirectory: target,
        stagedDirectory: temporaryOutput,
        backupDirectory: backup,
      });
    } catch (error) {
      if (error instanceof GeneratedBindingsRollbackError) {
        preserveTemporaryRoot = true;
      }
      throw error;
    }
    process.stdout.write(
      `Generated Codex App Server bindings for ${cliVersion} at ${target}\n`,
    );
  } finally {
    if (!preserveTemporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}

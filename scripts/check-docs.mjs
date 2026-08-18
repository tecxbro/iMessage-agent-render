import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MARKDOWN_EXTENSIONS = new Set([".md", ".txt"]);
const WALK_EXCLUSIONS = new Set([".git", "dist", "node_modules"]);
const PUBLIC_SCHEMA_EXCLUSIONS = new Set([
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "NODE_ENV",
  "PATH",
]);
const STALE_USER_PHRASES = [
  "feat/render-docs",
  "foundation entrypoint",
  "production entrypoint remains uncomposed",
  "current branch cannot complete",
  "after the composed entrypoint exists",
  "integration owner must wire",
];
const FORBIDDEN_PUBLIC_ONBOARDING_PHRASES = [
  "Deployment setup code",
  "reveal DASHBOARD_SETUP_SECRET",
  "private code from your service environment",
  "Choose an agent password",
  "Enter the agent password",
  "authenticated dashboard",
];

function walkFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && WALK_EXCLUSIONS.has(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function githubHeadingAnchors(source) {
  const anchors = new Set();
  const occurrences = new Map();
  for (const match of source.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gmu)) {
    const base = match[1]
      .replace(/<[^>]+>/gu, "")
      .replace(/[`*_~]/gu, "")
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
      .trim()
      .replace(/\s+/gu, "-");
    const count = occurrences.get(base) ?? 0;
    occurrences.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  for (const match of source.matchAll(/\b(?:id|name)=["']([^"']+)["']/gu)) {
    anchors.add(match[1]);
  }
  return anchors;
}

function localMarkdownLinkFailures(files) {
  const failures = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
      const rawTarget = match[1].trim().replace(/^<|>$/gu, "");
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/iu.test(rawTarget)) {
        if (!rawTarget.startsWith("#")) {
          continue;
        }
      }
      if (rawTarget.includes("<")) {
        continue;
      }
      const [encodedPath = "", fragment = ""] = rawTarget.split("#", 2);
      let decodedPath;
      try {
        decodedPath = decodeURIComponent(encodedPath);
      } catch {
        failures.push(`${relative(REPOSITORY_ROOT, file)}:${lineNumber(source, match.index)} has an invalid encoded link: ${rawTarget}`);
        continue;
      }
      const targetPath = decodedPath.length === 0
        ? file
        : isAbsolute(decodedPath)
          ? resolve(REPOSITORY_ROOT, `.${decodedPath}`)
          : resolve(dirname(file), decodedPath);
      if (!existsSync(targetPath)) {
        failures.push(`${relative(REPOSITORY_ROOT, file)}:${lineNumber(source, match.index)} links to missing ${rawTarget}`);
        continue;
      }
      if (fragment.length > 0 && statSync(targetPath).isFile()) {
        const targetSource = readFileSync(targetPath, "utf8");
        const decodedFragment = decodeURIComponent(fragment);
        if (!githubHeadingAnchors(targetSource).has(decodedFragment)) {
          failures.push(`${relative(REPOSITORY_ROOT, file)}:${lineNumber(source, match.index)} links to missing anchor ${rawTarget}`);
        }
      }
    }
  }
  return failures;
}

function packageManifest() {
  return JSON.parse(readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8"));
}

function documentedCommandFailures(files, scripts) {
  const failures = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bnpm\s+(?:run\s+([a-zA-Z0-9:_-]+)|(test|start))\b/gu)) {
      const script = match[1] ?? match[2];
      if (scripts[script] === undefined) {
        failures.push(`${relative(REPOSITORY_ROOT, file)}:${lineNumber(source, match.index)} documents missing package script ${script}`);
      }
    }
  }
  return failures;
}

function renderCommandFailures(scripts) {
  const blueprint = readFileSync(join(REPOSITORY_ROOT, "render.yaml"), "utf8");
  const failures = [];
  const expected = new Map([
    ["buildCommand", "build"],
    ["preDeployCommand", "db:migrate"],
    ["startCommand", "start"],
  ]);
  for (const [field, requiredScript] of expected) {
    const match = new RegExp(`^\\s*${field}:\\s*(.+)$`, "mu").exec(blueprint);
    if (match === null) {
      failures.push(`render.yaml is missing ${field}`);
      continue;
    }
    if (scripts[requiredScript] === undefined) {
      failures.push(`render.yaml ${field} references missing package script ${requiredScript}`);
    }
    const command = match[1];
    const invokesRequired = requiredScript === "start"
      ? /\bnpm\s+start\b/u.test(command)
      : new RegExp(`\\bnpm\\s+run\\s+${escapeRegularExpression(requiredScript)}\\b`, "u").test(command);
    if (!invokesRequired) {
      failures.push(`render.yaml ${field} must invoke npm ${requiredScript === "start" ? "start" : `run ${requiredScript}`}`);
    }
  }
  return failures;
}

function deployButtonFailures() {
  const readme = readFileSync(join(REPOSITORY_ROOT, "README.md"), "utf8");
  const firstSection = readme.search(/^##\s+/mu);
  const button = readme.indexOf("https://render.com/images/deploy-to-render-button.svg");
  if (button === -1 || firstSection === -1 || button > firstSection) {
    return ["README.md must place the Deploy to Render button before the first H2 section"];
  }
  if (!readme.includes("https://render.com/deploy?repo=https://github.com/tecxbro/iMessage-agent-render")) {
    return ["README.md deploy button must explicitly identify the source repository"];
  }
  return [];
}

function publicEnvironmentVariables() {
  const source = readFileSync(join(REPOSITORY_ROOT, "src/config/env.ts"), "utf8");
  const start = source.indexOf("const rawEnvironmentSchema");
  const end = source.indexOf(".superRefine", start);
  if (start === -1 || end === -1) {
    throw new Error("Could not locate rawEnvironmentSchema in src/config/env.ts");
  }
  const variables = new Set();
  for (const match of source.slice(start, end).matchAll(/^\s{4}([A-Z][A-Z0-9_]+):/gmu)) {
    if (!PUBLIC_SCHEMA_EXCLUSIONS.has(match[1])) {
      variables.add(match[1]);
    }
  }
  return [...variables].sort();
}

function environmentExampleFailures(publicVariables) {
  const example = readFileSync(join(REPOSITORY_ROOT, ".env.example"), "utf8");
  const documented = new Set(
    [...example.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]+)=/gmu)].map((match) => match[1]),
  );
  return publicVariables
    .filter((variable) => !documented.has(variable))
    .map((variable) => `.env.example is missing public environment variable ${variable}`);
}

function stalePhraseFailures() {
  const files = [
    join(REPOSITORY_ROOT, "README.md"),
    ...readdirSync(join(REPOSITORY_ROOT, "docs"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && MARKDOWN_EXTENSIONS.has(extname(entry.name)))
      .map((entry) => join(REPOSITORY_ROOT, "docs", entry.name)),
  ];
  const failures = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8").toLowerCase();
    for (const phrase of STALE_USER_PHRASES) {
      if (source.includes(phrase.toLowerCase())) {
        failures.push(`${relative(REPOSITORY_ROOT, file)} contains stale phrase: ${phrase}`);
      }
    }
  }
  return failures;
}

function publicOnboardingFailures() {
  const files = [
    join(REPOSITORY_ROOT, "README.md"),
    join(REPOSITORY_ROOT, "docs", "DEPLOYMENT.md"),
  ];
  const failures = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8").toLowerCase();
    for (const phrase of FORBIDDEN_PUBLIC_ONBOARDING_PHRASES) {
      if (source.includes(phrase.toLowerCase())) {
        failures.push(`${relative(REPOSITORY_ROOT, file)} contains forbidden public-onboarding phrase: ${phrase}`);
      }
    }
  }
  return failures;
}

function llmsEntrypointFailures() {
  const source = readFileSync(join(REPOSITORY_ROOT, "docs/llms.txt"), "utf8");
  const required = [
    "../src/server.ts",
    "../src/index.ts",
    "../src/runtime/production-bootstrap.ts",
  ];
  const failures = required
    .filter((entrypoint) => !source.includes(entrypoint))
    .map((entrypoint) => `docs/llms.txt is missing production entrypoint ${entrypoint}`);
  if (!source.includes("executable production entrypoint")) {
    failures.push("docs/llms.txt must identify src/server.ts as the executable production entrypoint");
  }
  return failures;
}

export function runDocumentationChecks() {
  const allFiles = walkFiles(REPOSITORY_ROOT);
  const markdownFiles = allFiles.filter((file) => MARKDOWN_EXTENSIONS.has(extname(file)));
  const manifest = packageManifest();
  const scripts = manifest.scripts ?? {};
  const publicVariables = publicEnvironmentVariables();
  const failures = [
    ...localMarkdownLinkFailures(markdownFiles),
    ...documentedCommandFailures(markdownFiles, scripts),
    ...renderCommandFailures(scripts),
    ...deployButtonFailures(),
    ...environmentExampleFailures(publicVariables),
    ...stalePhraseFailures(),
    ...publicOnboardingFailures(),
    ...llmsEntrypointFailures(),
  ];
  if (failures.length > 0) {
    throw new Error(`Documentation contract failed:\n- ${failures.join("\n- ")}`);
  }
  return {
    markdownFileCount: markdownFiles.length,
    publicEnvironmentVariableCount: publicVariables.length,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = runDocumentationChecks();
    console.log(`Documentation contract passed: ${result.markdownFileCount} Markdown/text files and ${result.publicEnvironmentVariableCount} public environment variables checked.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

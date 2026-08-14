import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const CLI_BASE_KEYS = new Set([
  "PATH",
  "HOME",
  "CODEX_HOME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "CODEX_CA_CERTIFICATE",
]);

const taskKeyPattern = /^AGENT_TASK_[A-Z0-9_]+$/u;

export interface SecretBoundaryAuditInput {
  codexHome: string;
  workspaceRoot: string;
  authMode: "chatgpt" | "api_key";
  childEnvironment: Readonly<Record<string, string>>;
  allowedTaskKeys?: readonly string[];
  protectedValues?: readonly string[];
  envFilePath?: string;
}

export interface SecretBoundaryAuditReport {
  ok: true;
  codexHome: "private";
  workspaceRoot: "separate";
  childEnvironment: "allowlisted";
  authFile: "absent" | "private" | "not-used";
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return (
    leftToRight === "" ||
    (!leftToRight.startsWith("..") && !isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith("..") && !isAbsolute(rightToLeft))
  );
}

function containsProtectedValue(
  value: string,
  protectedValues: readonly string[],
): boolean {
  return protectedValues.some(
    (secret) => secret.length >= 6 && value.includes(secret),
  );
}

export function assertCodexChildEnvironmentBoundary(
  child: Readonly<Record<string, string>>,
  options: {
    authMode: "chatgpt" | "api_key";
    allowedTaskKeys?: readonly string[];
    protectedValues?: readonly string[];
  },
): void {
  const allowedTaskKeys = new Set(options.allowedTaskKeys ?? []);
  for (const [key, value] of Object.entries(child)) {
    const baseAllowed = CLI_BASE_KEYS.has(key);
    const apiKeyAllowed =
      key === "OPENAI_API_KEY" && options.authMode === "api_key";
    const taskAllowed = taskKeyPattern.test(key) && allowedTaskKeys.has(key);
    if (!baseAllowed && !apiKeyAllowed && !taskAllowed) {
      throw new Error(
        `Codex child environment contains non-allowlisted key ${key}. Remove it before startup.`,
      );
    }
    if (
      containsProtectedValue(value, options.protectedValues ?? []) &&
      !apiKeyAllowed
    ) {
      throw new Error(
        `Codex child environment key ${key} contains protected service secret material.`,
      );
    }
  }
  if (child["PATH"] === undefined || child["CODEX_HOME"] === undefined) {
    throw new Error("Codex child environment requires PATH and CODEX_HOME.");
  }
  if (child["HOME"] !== child["CODEX_HOME"]) {
    throw new Error("Codex CLI HOME must be the controlled CODEX_HOME directory.");
  }
  if (
    options.authMode === "chatgpt" &&
    (child["OPENAI_API_KEY"] !== undefined || child["CODEX_API_KEY"] !== undefined)
  ) {
    throw new Error("ChatGPT auth mode must not expose API keys to the Codex CLI.");
  }
}

export interface CodexShellEnvironmentPolicy {
  [key: string]: string | boolean | Record<string, string>;
  inherit: "none";
  ignore_default_excludes: false;
  experimental_use_profile: false;
  set: Record<string, string>;
}

export function buildCodexShellEnvironmentPolicy(
  cliEnvironment: Readonly<Record<string, string>>,
  workingDirectory: string,
): CodexShellEnvironmentPolicy {
  if (!isAbsolute(workingDirectory)) {
    throw new Error("Codex shell working directory must be absolute.");
  }
  const path = cliEnvironment["PATH"];
  if (path === undefined || path.length === 0) {
    throw new Error("Codex model shell requires the audited executable PATH.");
  }
  const set: Record<string, string> = {
    PATH: path,
    HOME: workingDirectory,
  };
  for (const key of ["LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE"] as const) {
    const value = cliEnvironment[key];
    if (value !== undefined) {
      set[key] = value;
    }
  }
  return {
    inherit: "none",
    ignore_default_excludes: false,
    experimental_use_profile: false,
    set,
  };
}

async function existingStat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function assertPrivateMode(path: string, mode: number): void {
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `${path} is readable or writable by group/other users. Restrict it to the service account and restart.`,
    );
  }
}

function assertPathSearchBoundary(pathValue: string): void {
  const components = pathValue.split(":");
  if (
    components.some(
      (component) => component.length === 0 || !isAbsolute(component),
    )
  ) {
    throw new Error(
      "PATH must contain only explicit absolute directories; empty and relative entries are forbidden.",
    );
  }
}

export async function auditStartupSecretBoundaries(
  input: SecretBoundaryAuditInput,
): Promise<SecretBoundaryAuditReport> {
  const codexHome = resolve(input.codexHome);
  const workspaceRoot = resolve(input.workspaceRoot);
  if (!isAbsolute(input.codexHome) || !isAbsolute(input.workspaceRoot)) {
    throw new Error("CODEX_HOME and AGENT_WORKSPACE_ROOT must be absolute at startup.");
  }
  if (pathsOverlap(codexHome, workspaceRoot)) {
    throw new Error("CODEX_HOME and AGENT_WORKSPACE_ROOT must not overlap.");
  }
  if (
    input.envFilePath !== undefined &&
    (pathsOverlap(resolve(input.envFilePath), codexHome) ||
      pathsOverlap(resolve(input.envFilePath), workspaceRoot))
  ) {
    throw new Error("The service .env file must not live inside Codex or task workspaces.");
  }

  assertCodexChildEnvironmentBoundary(input.childEnvironment, {
    authMode: input.authMode,
    ...(input.protectedValues === undefined
      ? {}
      : { protectedValues: input.protectedValues }),
    allowedTaskKeys: input.allowedTaskKeys ?? [],
  });
  assertPathSearchBoundary(input.childEnvironment["PATH"]!);

  const codexStat = await existingStat(codexHome);
  if (codexStat !== undefined) {
    if (codexStat.isSymbolicLink() || !codexStat.isDirectory()) {
      throw new Error("CODEX_HOME must be a real directory, not a symlink or file.");
    }
    assertPrivateMode(codexHome, Number(codexStat.mode));
  }
  const workspaceStat = await existingStat(workspaceRoot);
  if (workspaceStat !== undefined && workspaceStat.isSymbolicLink()) {
    throw new Error("AGENT_WORKSPACE_ROOT must not be a symlink.");
  }
  if (codexStat !== undefined && workspaceStat !== undefined) {
    const [realCodex, realWorkspace] = await Promise.all([
      realpath(codexHome),
      realpath(workspaceRoot),
    ]);
    if (pathsOverlap(realCodex, realWorkspace)) {
      throw new Error("Resolved Codex and workspace roots overlap through a link.");
    }
  }

  let authFile: SecretBoundaryAuditReport["authFile"] = "not-used";
  if (input.authMode === "chatgpt") {
    const authPath = join(codexHome, "auth.json");
    const authStat = await existingStat(authPath);
    if (authStat === undefined) {
      authFile = "absent";
    } else {
      if (authStat.isSymbolicLink() || !authStat.isFile()) {
        throw new Error("CODEX_HOME/auth.json must be a private regular file.");
      }
      assertPrivateMode(authPath, Number(authStat.mode));
      const owner = await stat(authPath);
      if (typeof process.getuid === "function" && owner.uid !== process.getuid()) {
        throw new Error("CODEX_HOME/auth.json must be owned by the service account.");
      }
      authFile = "private";
    }
  }
  return {
    ok: true,
    codexHome: "private",
    workspaceRoot: "separate",
    childEnvironment: "allowlisted",
    authFile,
  };
}

import { isAbsolute, resolve } from "node:path";

export type CodexAuthMode = "chatgpt" | "api_key";

const INHERITED_CHILD_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "CODEX_CA_CERTIFICATE",
] as const;

const taskVariableNamePattern = /^AGENT_TASK_[A-Z0-9_]+$/u;

export interface CodexChildEnvironmentOptions {
  parentEnvironment: Readonly<NodeJS.ProcessEnv>;
  codexHome: string;
  authMode: CodexAuthMode;
  openAiApiKey?: string;
  safeTaskEnvironment?: Readonly<Record<string, string>>;
}

function requireAbsoluteCodexHome(codexHome: string): string {
  const normalized = resolve(codexHome);
  if (!isAbsolute(codexHome) || normalized.length === 0) {
    throw new Error(
      "CODEX_HOME must be an explicit absolute path before a Codex child can start.",
    );
  }
  return normalized;
}

function copyInheritedValues(
  parent: Readonly<NodeJS.ProcessEnv>,
): Record<string, string> {
  const child: Record<string, string> = {};
  for (const key of INHERITED_CHILD_KEYS) {
    const value = parent[key];
    if (value !== undefined && value.length > 0) {
      child[key] = value;
    }
  }

  if (child["PATH"] === undefined) {
    throw new Error(
      "PATH is required for the Codex child environment. Configure a minimal executable search path and restart.",
    );
  }
  return child;
}

function copyTaskValues(
  target: Record<string, string>,
  values: Readonly<Record<string, string>> | undefined,
): void {
  if (values === undefined) {
    return;
  }

  for (const [key, value] of Object.entries(values)) {
    if (!taskVariableNamePattern.test(key)) {
      throw new Error(
        `Unsafe task environment key ${key}. Task-specific child variables must use the AGENT_TASK_ prefix.`,
      );
    }
    if (value.length > 4_096 || value.includes("\0")) {
      throw new Error(
        `Unsafe task environment value for ${key}. Values must be at most 4096 characters and contain no null bytes.`,
      );
    }
    target[key] = value;
  }
}

/**
 * Builds the complete environment supplied to the Codex SDK. It deliberately
 * never spreads the parent environment, so database, Photon, memory, encryption, and
 * unrelated cloud credentials cannot cross the child-process boundary.
 */
export function buildCodexChildEnvironment(
  options: CodexChildEnvironmentOptions,
): Record<string, string> {
  const child = copyInheritedValues(options.parentEnvironment);
  child["CODEX_HOME"] = requireAbsoluteCodexHome(options.codexHome);

  if (options.authMode === "api_key") {
    if (options.openAiApiKey === undefined || options.openAiApiKey.length === 0) {
      throw new Error(
        "OPENAI_API_KEY is required for Codex API-key mode. Configure it as a secret and restart.",
      );
    }
    child["OPENAI_API_KEY"] = options.openAiApiKey;
  }

  copyTaskValues(child, options.safeTaskEnvironment);
  return child;
}

export const CODEX_INHERITED_CHILD_KEYS = INHERITED_CHILD_KEYS;

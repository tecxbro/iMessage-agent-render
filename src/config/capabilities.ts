import { chmod, mkdir, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import {
  CodexRuntimeError,
  type StructuredCodexRunner,
} from "../agent/codex-client.js";
import type {
  ModelProfileName,
  ModelProfiles,
  ReasoningEffort,
} from "./model-profiles.js";
import type { CodexAuthMode } from "../agent/child-environment.js";

type ComponentState = "ok" | "missing" | "failed" | "unknown";

interface FileStat {
  mode: number;
  uid: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface CapabilityFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  stat(path: string): Promise<FileStat>;
}

const defaultFileSystem: CapabilityFileSystem = {
  async mkdir(path, options) {
    await mkdir(path, options);
  },
  async chmod(path, mode) {
    await chmod(path, mode);
  },
  async stat(path) {
    return await stat(path);
  },
};

export type PairProbeFailure =
  | "auth"
  | "model"
  | "effort"
  | "sandbox"
  | "runtime";

export interface PairProbeResult {
  supported: boolean;
  failure?: PairProbeFailure;
}

export interface CapabilityPairRunner {
  probe(input: {
    model: string;
    effort: ReasoningEffort;
    signal?: AbortSignal;
  }): Promise<PairProbeResult>;
}

export interface ProfileCapabilityResult {
  profile: ModelProfileName;
  model: string;
  requestedEffort: ReasoningEffort;
  effectiveEffort?: ReasoningEffort;
  state: "ok" | "failed" | "unknown";
  warning?: string;
  remediation?: string;
}

export interface CodexCapabilityReport {
  ready: boolean;
  components: {
    disk: ComponentState;
    auth: ComponentState;
    models: ComponentState;
    sandbox: ComponentState;
  };
  profiles: readonly ProfileCapabilityResult[];
  warnings: readonly string[];
  remediation: readonly string[];
}

export interface ProbeCodexCapabilitiesOptions {
  codexHome: string;
  authMode: CodexAuthMode;
  openAiApiKey?: string;
  profiles: ModelProfiles;
  allowReasoningFallback: boolean;
  runner: CapabilityPairRunner;
  signal?: AbortSignal;
  fileSystem?: CapabilityFileSystem;
  currentUid?: number;
}

interface DiskAndAuthResult {
  disk: ComponentState;
  auth: ComponentState;
  remediation: string[];
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function unsafeMode(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

async function inspectDiskAndAuth(
  options: ProbeCodexCapabilitiesOptions,
): Promise<DiskAndAuthResult> {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const codexHome = resolve(options.codexHome);
  if (!isAbsolute(options.codexHome)) {
    return {
      disk: "failed",
      auth: "unknown",
      remediation: ["Set CODEX_HOME to an explicit absolute persistent path."],
    };
  }

  try {
    await fileSystem.mkdir(codexHome, { recursive: true, mode: 0o700 });
    const directory = await fileSystem.stat(codexHome);
    if (!directory.isDirectory()) {
      return {
        disk: "failed",
        auth: "unknown",
        remediation: ["CODEX_HOME is not a directory. Replace it and restart."],
      };
    }
    if (unsafeMode(directory.mode)) {
      return {
        disk: "failed",
        auth: "unknown",
        remediation: ["Restrict CODEX_HOME to mode 0700, then restart."],
      };
    }
    if (
      options.currentUid !== undefined &&
      directory.uid !== options.currentUid
    ) {
      return {
        disk: "failed",
        auth: "unknown",
        remediation: [
          "Make the service account the owner of CODEX_HOME, then restart.",
        ],
      };
    }
  } catch {
    return {
      disk: "failed",
      auth: "unknown",
      remediation: [
        "Codex storage could not be prepared. Verify the persistent disk mount, ownership, and mode 0700.",
      ],
    };
  }

  if (options.authMode === "api_key") {
    return options.openAiApiKey === undefined || options.openAiApiKey.length === 0
      ? {
          disk: "ok",
          auth: "missing",
          remediation: [
            "Set OPENAI_API_KEY for CODEX_AUTH_MODE=api_key, then restart.",
          ],
        }
      : { disk: "ok", auth: "ok", remediation: [] };
  }

  const authPath = resolve(codexHome, "auth.json");
  try {
    const authFile = await fileSystem.stat(authPath);
    if (!authFile.isFile() || unsafeMode(authFile.mode)) {
      return {
        disk: "ok",
        auth: "failed",
        remediation: [
          "Codex auth.json must be a regular file with mode 0600. Repair permissions or re-enroll with npm run codex:login.",
        ],
      };
    }
    if (
      options.currentUid !== undefined &&
      authFile.uid !== options.currentUid
    ) {
      return {
        disk: "ok",
        auth: "failed",
        remediation: [
          "Make the service account the owner of CODEX_HOME/auth.json or re-enroll Codex.",
        ],
      };
    }
    return { disk: "ok", auth: "ok", remediation: [] };
  } catch (error) {
    if (isMissingFile(error)) {
      return {
        disk: "ok",
        auth: "missing",
        remediation: [
          "Codex ChatGPT enrollment is missing. Run npm run codex:login in the private service shell, then restart.",
        ],
      };
    }
    return {
      disk: "ok",
      auth: "failed",
      remediation: [
        "Codex auth status could not be read. Verify CODEX_HOME/auth.json permissions or re-enroll.",
      ],
    };
  }
}

function failedProfile(
  profile: ModelProfileName,
  model: string,
  effort: ReasoningEffort,
  failure: PairProbeFailure | undefined,
): ProfileCapabilityResult {
  const remediation =
    failure === "model"
      ? `Profile ${profile} uses unsupported model ${model}. Configure a supported exact model identifier.`
      : failure === "effort"
        ? `Profile ${profile} uses unsupported effort ${effort}. Correct it or explicitly enable the documented max-to-xhigh fallback.`
        : failure === "auth"
          ? `Profile ${profile} could not authenticate. Re-enroll ChatGPT or replace the API key.`
          : failure === "sandbox"
            ? `Profile ${profile} could not honor the read-only sandbox probe. Keep execution paused and inspect the pinned Codex runtime.`
            : `Profile ${profile} failed its Codex capability probe. Inspect redacted runtime diagnostics.`;
  return {
    profile,
    model,
    requestedEffort: effort,
    state: "failed",
    remediation,
  };
}

async function probeProfile(
  name: ModelProfileName,
  options: ProbeCodexCapabilitiesOptions,
): Promise<ProfileCapabilityResult> {
  const configured = options.profiles[name];
  const result = await options.runner.probe({
    model: configured.model,
    effort: configured.effort,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (result.supported) {
    return {
      profile: name,
      model: configured.model,
      requestedEffort: configured.effort,
      effectiveEffort: configured.effort,
      state: "ok",
    };
  }

  if (
    configured.effort === "max" &&
    result.failure === "effort" &&
    options.allowReasoningFallback
  ) {
    const fallback = await options.runner.probe({
      model: configured.model,
      effort: "xhigh",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (fallback.supported) {
      const warning = `Profile ${name}: requested max effort is unsupported; explicit ALLOW_REASONING_FALLBACK maps max to xhigh without changing model ${configured.model}.`;
      return {
        profile: name,
        model: configured.model,
        requestedEffort: "max",
        effectiveEffort: "xhigh",
        state: "ok",
        warning,
      };
    }
    return failedProfile(name, configured.model, "xhigh", fallback.failure);
  }

  return failedProfile(name, configured.model, configured.effort, result.failure);
}

export async function probeCodexCapabilities(
  options: ProbeCodexCapabilitiesOptions,
): Promise<CodexCapabilityReport> {
  const storage = await inspectDiskAndAuth(options);
  if (storage.disk !== "ok" || storage.auth !== "ok") {
    return {
      ready: false,
      components: {
        disk: storage.disk,
        auth: storage.auth,
        models: "unknown",
        sandbox: "unknown",
      },
      profiles: Object.entries(options.profiles).map(([profile, value]) => ({
        profile: profile as ModelProfileName,
        model: value.model,
        requestedEffort: value.effort,
        state: "unknown",
      })),
      warnings: [],
      remediation: storage.remediation,
    };
  }

  const profileNames = Object.keys(options.profiles) as ModelProfileName[];
  const profiles: ProfileCapabilityResult[] = [];
  for (const name of profileNames) {
    try {
      profiles.push(await probeProfile(name, options));
    } catch (error) {
      const failure =
        error instanceof CodexRuntimeError
          ? error.code === "CODEX_AUTH_FAILED"
            ? "auth"
            : error.code === "CODEX_MODEL_UNSUPPORTED"
              ? "model"
              : error.code === "CODEX_EFFORT_UNSUPPORTED"
                ? "effort"
                : "runtime"
          : "runtime";
      const configured = options.profiles[name];
      profiles.push(
        failedProfile(name, configured.model, configured.effort, failure),
      );
    }
  }

  const failed = profiles.filter((profile) => profile.state !== "ok");
  const authFailed = failed.some((profile) =>
    profile.remediation?.includes("authenticate"),
  );
  const warnings = profiles.flatMap((profile) =>
    profile.warning === undefined ? [] : [profile.warning],
  );
  const remediation = profiles.flatMap((profile) =>
    profile.remediation === undefined ? [] : [profile.remediation],
  );
  return {
    ready: failed.length === 0,
    components: {
      disk: "ok",
      auth: authFailed ? "failed" : "ok",
      models: failed.length === 0 ? "ok" : "failed",
      sandbox: failed.length === 0 ? "ok" : "failed",
    },
    profiles,
    warnings,
    remediation,
  };
}

const capabilityOutputSchema = z.object({ ok: z.literal(true) }).strict();

export function createCodexPairRunner(
  client: StructuredCodexRunner,
  workingDirectory: string,
): CapabilityPairRunner {
  return {
    async probe(input): Promise<PairProbeResult> {
      try {
        await client.runStructured({
          prompt:
            "Capability probe. Return only the schema-bound acknowledgement; do not inspect files or use tools.",
          outputSchema: capabilityOutputSchema,
          modelProfile: { model: input.model, effort: input.effort },
          permissionProfile: "read",
          workingDirectory,
          skipGitRepoCheck: true,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        return { supported: true };
      } catch (error) {
        if (error instanceof CodexRuntimeError) {
          const failure: PairProbeFailure =
            error.code === "CODEX_AUTH_FAILED"
              ? "auth"
              : error.code === "CODEX_MODEL_UNSUPPORTED"
                ? "model"
                : error.code === "CODEX_EFFORT_UNSUPPORTED"
                  ? "effort"
                  : "runtime";
          return { supported: false, failure };
        }
        return { supported: false, failure: "runtime" };
      }
    },
  };
}

/** Restricts a newly-created Codex directory without touching auth.json. */
export async function initializeCodexHome(codexHome: string): Promise<void> {
  const path = resolve(codexHome);
  if (!isAbsolute(codexHome)) {
    throw new Error("CODEX_HOME must be absolute before initialization.");
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

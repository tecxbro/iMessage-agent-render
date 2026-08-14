import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  probeCodexCapabilities,
  type CapabilityPairRunner,
} from "../../src/config/capabilities.js";
import { DEFAULT_MODEL_PROFILES } from "../../src/config/model-profiles.js";

const temporaryDirectories: string[] = [];
const currentUidOption =
  process.getuid === undefined ? {} : { currentUid: process.getuid() };

async function temporaryCodexHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-capability-test-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("Codex startup capability report", () => {
  it("reports missing ChatGPT enrollment without invoking a model", async () => {
    const codexHome = await temporaryCodexHome();
    let probes = 0;
    const runner: CapabilityPairRunner = {
      async probe() {
        probes += 1;
        return { supported: true };
      },
    };

    const report = await probeCodexCapabilities({
      codexHome,
      authMode: "chatgpt",
      profiles: DEFAULT_MODEL_PROFILES,
      allowReasoningFallback: false,
      runner,
      ...currentUidOption,
    });

    expect(report.ready).toBe(false);
    expect(report.components).toMatchObject({
      disk: "ok",
      auth: "missing",
      models: "unknown",
    });
    expect(report.remediation.join(" ")).toContain("npm run codex:login");
    expect(probes).toBe(0);
  });

  it("requires private auth-file permissions in ChatGPT mode", async () => {
    const codexHome = await temporaryCodexHome();
    const authPath = join(codexHome, "auth.json");
    await writeFile(authPath, "test fixture only", { mode: 0o644 });
    const report = await probeCodexCapabilities({
      codexHome,
      authMode: "chatgpt",
      profiles: DEFAULT_MODEL_PROFILES,
      allowReasoningFallback: false,
      runner: { async probe() { return { supported: true }; } },
      ...currentUidOption,
    });

    expect(report.components.auth).toBe("failed");
    expect(report.remediation.join(" ")).toContain("0600");
  });

  it("never reads auth.json in API-key mode", async () => {
    const codexHome = "/private/codex-home";
    const statPaths: string[] = [];
    const report = await probeCodexCapabilities({
      codexHome,
      authMode: "api_key",
      openAiApiKey: "test-key",
      profiles: DEFAULT_MODEL_PROFILES,
      allowReasoningFallback: false,
      runner: { async probe() { return { supported: true }; } },
      fileSystem: {
        async mkdir() {},
        async chmod() {},
        async stat(path) {
          statPaths.push(path);
          return {
            mode: 0o700,
            uid: 501,
            isDirectory: () => true,
            isFile: () => false,
          };
        },
      },
      currentUid: 501,
    });

    expect(report.ready).toBe(true);
    expect(statPaths).toEqual([codexHome]);
    expect(statPaths.some((path) => path.endsWith("auth.json"))).toBe(false);
  });

  it("fails unsupported max effort unless fallback is explicit", async () => {
    const codexHome = await temporaryCodexHome();
    const authPath = join(codexHome, "auth.json");
    await writeFile(authPath, "test fixture only", { mode: 0o600 });
    const efforts: string[] = [];
    const runner: CapabilityPairRunner = {
      async probe({ effort }) {
        efforts.push(effort);
        return effort === "max"
          ? { supported: false, failure: "effort" }
          : { supported: true };
      },
    };
    const withoutFallback = await probeCodexCapabilities({
      codexHome,
      authMode: "chatgpt",
      profiles: DEFAULT_MODEL_PROFILES,
      allowReasoningFallback: false,
      runner,
      ...currentUidOption,
    });
    expect(withoutFallback.ready).toBe(false);
    expect(withoutFallback.remediation.join(" ")).toContain(
      "explicitly enable",
    );
    expect(
      withoutFallback.profiles.find((profile) => profile.profile === "hard"),
    ).toMatchObject({ requestedEffort: "max", state: "failed" });

    efforts.length = 0;
    const withFallback = await probeCodexCapabilities({
      codexHome,
      authMode: "chatgpt",
      profiles: DEFAULT_MODEL_PROFILES,
      allowReasoningFallback: true,
      runner,
      ...currentUidOption,
    });
    expect(withFallback.ready).toBe(true);
    expect(
      withFallback.profiles.find((profile) => profile.profile === "hard"),
    ).toMatchObject({
      requestedEffort: "max",
      effectiveEffort: "xhigh",
      state: "ok",
    });
    expect(withFallback.warnings.join(" ")).toContain("max to xhigh");
    expect(efforts).toContain("xhigh");
  });

  it("fails an unsupported model without changing its identifier", async () => {
    const codexHome = await temporaryCodexHome();
    await writeFile(join(codexHome, "auth.json"), "test fixture only", {
      mode: 0o600,
    });
    const runner: CapabilityPairRunner = {
      async probe({ model }) {
        return model === DEFAULT_MODEL_PROFILES.deep.model
          ? { supported: false, failure: "model" }
          : { supported: true };
      },
    };
    const report = await probeCodexCapabilities({
      codexHome,
      authMode: "chatgpt",
      profiles: DEFAULT_MODEL_PROFILES,
      allowReasoningFallback: false,
      runner,
      ...currentUidOption,
    });

    expect(report.ready).toBe(false);
    expect(report.remediation.join(" ")).toContain(
      DEFAULT_MODEL_PROFILES.deep.model,
    );
    expect(report.profiles.find((profile) => profile.profile === "deep")?.model).toBe(
      DEFAULT_MODEL_PROFILES.deep.model,
    );
  });

  it("marks readiness false when cached ChatGPT auth is expired", async () => {
    const codexHome = await temporaryCodexHome();
    await writeFile(join(codexHome, "auth.json"), "expired test fixture", {
      mode: 0o600,
    });
    const report = await probeCodexCapabilities({
      codexHome,
      authMode: "chatgpt",
      profiles: DEFAULT_MODEL_PROFILES,
      allowReasoningFallback: false,
      runner: {
        async probe() {
          return { supported: false, failure: "auth" };
        },
      },
      ...currentUidOption,
    });

    expect(report.ready).toBe(false);
    expect(report.components.auth).toBe("failed");
    expect(report.remediation.join(" ")).toContain("Re-enroll ChatGPT");
  });
});

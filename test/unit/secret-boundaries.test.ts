import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildCodexChildEnvironment,
  CODEX_INHERITED_CHILD_KEYS,
} from "../../src/agent/child-environment.js";

const codexHome = resolve("test/.codex-runtime-home");

describe("Codex child environment boundaries", () => {
  it("copies only explicit runtime keys and excludes service secrets", () => {
    const child = buildCodexChildEnvironment({
      parentEnvironment: {
        PATH: "/usr/bin:/bin",
        HOME: "/service-user",
        LANG: "en_US.UTF-8",
        DATABASE_URL: "postgresql://private",
        SPECTRUM_PROJECT_SECRET: "photon-secret",
        SUPERMEMORY_API_KEY: "memory-secret",
        APP_ENCRYPTION_KEY: "encryption-secret",
        AWS_SECRET_ACCESS_KEY: "cloud-secret",
        OPENAI_API_KEY: "must-not-be-inherited",
      },
      codexHome,
      authMode: "chatgpt",
      safeTaskEnvironment: { AGENT_TASK_CORRELATION_ID: "safe-id" },
      allowedTaskEnvironmentKeys: ["AGENT_TASK_CORRELATION_ID"],
    });

    expect(child).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: codexHome,
      LANG: "en_US.UTF-8",
      CODEX_HOME: codexHome,
      AGENT_TASK_CORRELATION_ID: "safe-id",
    });
    expect(Object.keys(child)).not.toContain("DATABASE_URL");
    expect(Object.keys(child)).not.toContain("SPECTRUM_PROJECT_SECRET");
    expect(Object.keys(child)).not.toContain("SUPERMEMORY_API_KEY");
    expect(Object.keys(child)).not.toContain("APP_ENCRYPTION_KEY");
    expect(CODEX_INHERITED_CHILD_KEYS).not.toContain("OPENAI_API_KEY");
  });

  it("adds an API key only in explicit API-key mode", () => {
    expect(
      buildCodexChildEnvironment({
        parentEnvironment: { PATH: "/usr/bin" },
        codexHome,
        authMode: "api_key",
        openAiApiKey: "test-api-key",
      })["OPENAI_API_KEY"],
    ).toBe("test-api-key");

    expect(() =>
      buildCodexChildEnvironment({
        parentEnvironment: { PATH: "/usr/bin" },
        codexHome,
        authMode: "api_key",
      }),
    ).toThrow(/OPENAI_API_KEY is required/);
  });

  it("rejects unscoped task variables and missing executable paths", () => {
    expect(() =>
      buildCodexChildEnvironment({
        parentEnvironment: { PATH: "/usr/bin" },
        codexHome,
        authMode: "chatgpt",
        safeTaskEnvironment: { DATABASE_URL: "still-private" },
      }),
    ).toThrow(/AGENT_TASK_/);
    expect(() =>
      buildCodexChildEnvironment({
        parentEnvironment: {},
        codexHome,
        authMode: "chatgpt",
      }),
    ).toThrow(/PATH is required/);
  });
});

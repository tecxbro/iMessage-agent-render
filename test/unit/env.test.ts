import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  EnvironmentValidationError,
  loadEnvironment,
  modelProfilesFromEnvironment,
} from "../../src/config/env.js";

function validEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    SPECTRUM_PROJECT_ID: "spectrum-project",
    SPECTRUM_PROJECT_SECRET: "spectrum-secret",
    DATABASE_URL: "postgresql://agent:password@localhost:5432/agent",
    AGENT_OWNER_HANDLES: "+15551234567,Owner@Example.com",
    DEPLOYMENT_ID: "00000000-0000-4000-8000-000000000001",
    APP_ENCRYPTION_KEY: "00".repeat(32),
    CODEX_HOME: "./.codex-agent",
    AGENT_WORKSPACE_ROOT: "./.agent-workspaces",
    CODEX_AUTH_MODE: "chatgpt",
    PATH: "/usr/bin:/bin",
    ...overrides,
  };
}

describe("loadEnvironment", () => {
  it("normalizes documented defaults, handles, paths, and model profiles", () => {
    const environment = loadEnvironment(validEnvironment());

    expect(environment.AGENT_OWNER_HANDLES).toEqual([
      "+15551234567",
      "owner@example.com",
    ]);
    expect(environment.CODEX_HOME).toBe(resolve(".codex-agent"));
    expect(environment.AGENT_WORKSPACE_ROOT).toBe(
      resolve(".agent-workspaces"),
    );
    expect(environment.INBOUND_DEBOUNCE_MS).toBe(4_000);
    expect(environment.LOG_MESSAGE_CONTENT).toBe(false);
    expect(modelProfilesFromEnvironment(environment).deep).toEqual({
      model: "gpt-5.6-sol",
      effort: "max",
    });
  });

  it("reports all missing required variables in one actionable error", () => {
    let error: unknown;
    try {
      loadEnvironment({});
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(EnvironmentValidationError);
    const message = (error as Error).message;
    for (const variable of [
      "SPECTRUM_PROJECT_ID",
      "SPECTRUM_PROJECT_SECRET",
      "DATABASE_URL",
      "AGENT_OWNER_HANDLES",
      "DEPLOYMENT_ID",
      "APP_ENCRYPTION_KEY",
      "CODEX_HOME",
      "AGENT_WORKSPACE_ROOT",
    ]) {
      expect(message).toContain(variable);
    }
    expect(message).toContain("Fix the listed variables and restart the service");
    expect(message).not.toContain("undefined");
  });

  it.each([
    ["database protocol", { DATABASE_URL: "https://database.example.com" }],
    ["owner handle", { AGENT_OWNER_HANDLES: "not-a-handle" }],
    ["encryption key", { APP_ENCRYPTION_KEY: "too-short" }],
    ["filesystem root", { CODEX_HOME: "/" }],
    ["path traversal", { AGENT_WORKSPACE_ROOT: "../outside" }],
    [
      "overlapping protected paths",
      { AGENT_WORKSPACE_ROOT: "./.codex-agent/workspaces" },
    ],
    ["duration", { MAX_TASK_RUNTIME_MS: "0" }],
    ["debounce", { INBOUND_DEBOUNCE_MS: "2500" }],
    ["model", { MODEL_MAIN: "not a model/name" }],
    ["effort", { MODEL_HARD_EFFORT: "ultra" }],
    ["boolean", { LOG_MESSAGE_CONTENT: "yes" }],
  ])("rejects malformed %s configuration", (_label, override) => {
    expect(() => loadEnvironment(validEnvironment(override))).toThrow(
      EnvironmentValidationError,
    );
  });

  it("requires an API key only in API-key authentication mode", () => {
    expect(() =>
      loadEnvironment(validEnvironment({ CODEX_AUTH_MODE: "api_key" })),
    ).toThrow(/OPENAI_API_KEY is required/);

    expect(
      loadEnvironment(
        validEnvironment({
          CODEX_AUTH_MODE: "api_key",
          OPENAI_API_KEY: "test-key",
        }),
      ).CODEX_AUTH_MODE,
    ).toBe("api_key");
  });
});

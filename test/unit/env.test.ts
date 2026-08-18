import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  deploymentIdFromRenderServiceId,
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
    OWNER_PHONE_NUMBER: "+15551234567",
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

    expect(environment.OWNER_PHONE_NUMBER).toBe("+15551234567");
    expect(environment.AGENT_OWNER_HANDLES).toEqual([]);
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
      "DATABASE_URL",
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

  it("requires a high-entropy dashboard setup secret in production", () => {
    expect(() =>
      loadEnvironment(validEnvironment({ NODE_ENV: "production" })),
    ).toThrow(/DASHBOARD_SETUP_SECRET is required in production/u);

    const setupSecret = "B0jrphAPOY7pg92AN0c9MN4yecczLMdwnx4OkA1KFUk=";
    expect(
      loadEnvironment(
        validEnvironment({
          NODE_ENV: "production",
          DASHBOARD_SETUP_SECRET: setupSecret,
        }),
      ).DASHBOARD_SETUP_SECRET,
    ).toBe(setupSecret);
  });

  it("allows local configuration to omit the dashboard setup secret", () => {
    expect(
      loadEnvironment(validEnvironment()).DASHBOARD_SETUP_SECRET,
    ).toBeUndefined();
  });

  it.each([
    ["base64", "B0jrphAPOY7pg92AN0c9MN4yecczLMdwnx4OkA1KFUk="],
    ["base64url", "B0jrphAPOY7pg92AN0c9MN4yecczLMdwnx4OkA1KFUk"],
    [
      "hexadecimal",
      "0748eba6100f398ee983dd8037473d30de3279c7332cc7709f1e0e900d4a1549",
    ],
  ])("accepts a diverse 32-byte %s setup secret", (_encoding, setupSecret) => {
    expect(
      loadEnvironment(
        validEnvironment({
          NODE_ENV: "production",
          DASHBOARD_SETUP_SECRET: setupSecret,
        }),
      ).DASHBOARD_SETUP_SECRET,
    ).toBe(setupSecret);
  });

  it("rejects weak dashboard setup secrets without echoing submitted material", () => {
    const submittedSecret = "weak-dashboard-secret";
    let error: unknown;
    try {
      loadEnvironment(
        validEnvironment({
          NODE_ENV: "production",
          DASHBOARD_SETUP_SECRET: submittedSecret,
        }),
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(EnvironmentValidationError);
    expect((error as Error).message).toContain("DASHBOARD_SETUP_SECRET");
    expect((error as Error).message).not.toContain(submittedSecret);
  });

  it.each([
    ["database protocol", { DATABASE_URL: "https://database.example.com" }],
    ["owner phone", { OWNER_PHONE_NUMBER: "not-a-phone" }],
    [
      "Render owner phone",
      {
        OWNER_PHONE_NUMBER: undefined,
        OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123: "9495550123",
      },
    ],
    ["encryption key", { APP_ENCRYPTION_KEY: "too-short" }],
    ["dashboard setup secret", { DASHBOARD_SETUP_SECRET: "too-short" }],
    [
      "low-diversity setup secret",
      { DASHBOARD_SETUP_SECRET: "00".repeat(32) },
    ],
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

  it("allows initial boot without Spectrum credentials", () => {
    const environment = loadEnvironment(
      validEnvironment({
        SPECTRUM_PROJECT_ID: undefined,
        SPECTRUM_PROJECT_SECRET: undefined,
      }),
    );

    expect(environment.SPECTRUM_PROJECT_ID).toBeUndefined();
    expect(environment.SPECTRUM_PROJECT_SECRET).toBeUndefined();
  });

  it("preserves legacy OWNER_PHONE_NUMBER as a migration input", () => {
    const environment = loadEnvironment(validEnvironment());

    expect(environment.OWNER_PHONE_NUMBER).toBe("+15551234567");
    expect(environment.AGENT_OWNER_HANDLES).toEqual([]);
  });

  it("preserves AGENT_OWNER_HANDLES as a legacy migration input", () => {
    const environment = loadEnvironment(
      validEnvironment({
        OWNER_PHONE_NUMBER: undefined,
        AGENT_OWNER_HANDLES: "+15557654321,Owner@Example.com",
      }),
    );

    expect(environment.AGENT_OWNER_HANDLES).toEqual([
      "+15557654321",
      "owner@example.com",
    ]);
  });

  it("preserves the Render Blueprint owner-phone alias for migration", () => {
    const environment = loadEnvironment(
      validEnvironment({
        OWNER_PHONE_NUMBER: undefined,
        OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123: "+19495550123",
      }),
    );

    expect(environment.OWNER_PHONE_NUMBER).toBeUndefined();
    expect(
      environment.OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123,
    ).toBe("+19495550123");
    expect(environment.AGENT_OWNER_HANDLES).toEqual([]);
  });

  it("rejects conflicting local and Render owner-phone values", () => {
    expect(() =>
      loadEnvironment(
        validEnvironment({
          OWNER_PHONE_NUMBER: "+15551234567",
          OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123: "+19495550123",
        }),
      ),
    ).toThrow(/must match when both are set/u);
  });

  it("loads a fresh environment without an owner and normalizes an empty authorization list", () => {
    const environment = loadEnvironment(
      validEnvironment({
        OWNER_PHONE_NUMBER: undefined,
        OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123: undefined,
        AGENT_OWNER_HANDLES: undefined,
      }),
    );

    expect(environment.OWNER_PHONE_NUMBER).toBeUndefined();
    expect(
      environment.OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123,
    ).toBeUndefined();
    expect(environment.AGENT_OWNER_HANDLES).toEqual([]);
  });

  it("requires legacy Spectrum credentials to be supplied as a pair", () => {
    expect(() =>
      loadEnvironment(
        validEnvironment({ SPECTRUM_PROJECT_SECRET: undefined }),
      ),
    ).toThrow(/must either both be set or both be omitted/);
  });

  it("derives a stable private deployment UUID from Render's service ID", () => {
    const withoutDeploymentId = validEnvironment({
      DEPLOYMENT_ID: undefined,
      RENDER_SERVICE_ID: "srv-codex-agent-01",
    });

    const first = loadEnvironment(withoutDeploymentId).DEPLOYMENT_ID;
    const second = loadEnvironment({ ...withoutDeploymentId }).DEPLOYMENT_ID;

    expect(first).toBe(second);
    expect(first).toBe(
      deploymentIdFromRenderServiceId("srv-codex-agent-01"),
    );
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(first).not.toContain("srv-codex-agent-01");
  });

  it("preserves an explicit deployment UUID instead of replacing it on Render", () => {
    expect(
      loadEnvironment(
        validEnvironment({ RENDER_SERVICE_ID: "srv-codex-agent-01" }),
      ).DEPLOYMENT_ID,
    ).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("rejects malformed Render service IDs used for derivation", () => {
    expect(() =>
      loadEnvironment(
        validEnvironment({
          DEPLOYMENT_ID: undefined,
          RENDER_SERVICE_ID: "srv id with spaces",
        }),
      ),
    ).toThrow();
  });
});

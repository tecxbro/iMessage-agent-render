import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const blueprintUrl = new URL("../../render.yaml", import.meta.url);

describe("Render Blueprint onboarding contract", () => {
  it("prompts only for the owner's E.164 phone number", async () => {
    const blueprint = await readFile(blueprintUrl, "utf8");

    expect(blueprint).toMatch(
      /- key: OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123\n\s+sync: false/u,
    );
    expect(blueprint).not.toMatch(/- key: OWNER_PHONE_NUMBER\n/u);
    for (const key of [
      "SPECTRUM_PROJECT_ID",
      "SPECTRUM_PROJECT_SECRET",
      "AGENT_OWNER_HANDLES",
      "SUPERMEMORY_API_KEY",
    ]) {
      expect(blueprint).not.toContain(`- key: ${key}`);
    }
  });

  it("keeps liveness separate from post-deploy agent readiness", async () => {
    const blueprint = await readFile(blueprintUrl, "utf8");

    expect(blueprint).toContain("startCommand: npm start");
    expect(blueprint).toContain("healthCheckPath: /healthz");
    expect(blueprint).not.toContain("healthCheckPath: /readyz");
  });

  it("generates the private dashboard setup secret without prompting for it", async () => {
    const blueprint = await readFile(blueprintUrl, "utf8");
    const setupSecretBlock = blueprint.match(
      /- key: DASHBOARD_SETUP_SECRET\n(?<properties>(?:\s{8}[^\n]+\n?)*)/u,
    );

    expect(setupSecretBlock?.groups?.["properties"]).toContain(
      "generateValue: true",
    );
    expect(setupSecretBlock?.groups?.["properties"]).not.toContain(
      "sync: false",
    );
  });
});

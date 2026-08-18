import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const blueprintUrl = new URL("../../render.yaml", import.meta.url);

describe("Render Blueprint onboarding contract", () => {
  it("prompts for no user-supplied environment values", async () => {
    const blueprint = await readFile(blueprintUrl, "utf8");
    const promptedKeys = [...blueprint.matchAll(
      /- key: (?<key>[A-Z0-9_]+)\n\s+sync:\s*false/gu,
    )].map((match) => match.groups?.["key"]);

    expect(promptedKeys).toEqual([]);
    for (const key of [
      "OWNER_PHONE_NUMBER",
      "OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123",
      "SPECTRUM_PROJECT_ID",
      "SPECTRUM_PROJECT_SECRET",
      "AGENT_OWNER_HANDLES",
      "SUPERMEMORY_API_KEY",
      "OPENAI_API_KEY",
      "AGENT_PASSWORD",
      "DASHBOARD_SETUP_SECRET",
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

  it("generates application encryption material only", async () => {
    const blueprint = await readFile(blueprintUrl, "utf8");
    const encryptionKeyBlock = blueprint.match(
      /- key: APP_ENCRYPTION_KEY\n(?<properties>(?:\s{8}[^\n]+\n?)*)/u,
    );

    expect(encryptionKeyBlock?.groups?.["properties"]).toContain(
      "generateValue: true",
    );
    expect(blueprint).not.toContain("DASHBOARD_SETUP_SECRET");
  });
});

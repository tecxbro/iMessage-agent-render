import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const blueprintUrl = new URL("../../render.yaml", import.meta.url);

describe("Render Blueprint onboarding contract", () => {
  it("prompts only for the user-chosen agent password", async () => {
    const blueprint = await readFile(blueprintUrl, "utf8");
    const promptedKeys = [...blueprint.matchAll(
      /- key: (?<key>[A-Z0-9_]+)\n\s+sync:\s*false/gu,
    )].map((match) => match.groups?.["key"]);

    expect(promptedKeys).toEqual(["AGENT_PASSWORD"]);
    const passwordBlock = blueprint.match(
      /- key: AGENT_PASSWORD\n(?<properties>(?:\s{8}[^\n]+\n?)*)/u,
    );
    expect(passwordBlock?.groups?.["properties"]).toContain("sync: false");
    expect(passwordBlock?.groups?.["properties"]).not.toContain(
      "generateValue: true",
    );
    for (const key of [
      "OWNER_PHONE_NUMBER",
      "OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123",
      "SPECTRUM_PROJECT_ID",
      "SPECTRUM_PROJECT_SECRET",
      "AGENT_OWNER_HANDLES",
      "SUPERMEMORY_API_KEY",
      "OPENAI_API_KEY",
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

  it("generates encryption material and the legacy credential only", async () => {
    const blueprint = await readFile(blueprintUrl, "utf8");
    const encryptionKeyBlock = blueprint.match(
      /- key: APP_ENCRYPTION_KEY\n(?<properties>(?:\s{8}[^\n]+\n?)*)/u,
    );
    const setupSecretBlock = blueprint.match(
      /- key: DASHBOARD_SETUP_SECRET\n(?<properties>(?:\s{8}[^\n]+\n?)*)/u,
    );

    expect(encryptionKeyBlock?.groups?.["properties"]).toContain(
      "generateValue: true",
    );
    expect(setupSecretBlock?.groups?.["properties"]).toContain(
      "generateValue: true",
    );
    expect(setupSecretBlock?.groups?.["properties"]).not.toContain(
      "sync: false",
    );
  });
});

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const blueprintUrl = new URL("../../render.yaml", import.meta.url);

describe("Render Blueprint onboarding contract", () => {
  it("prompts for provider, owner, and optional Supermemory credentials", async () => {
    const blueprint = await readFile(blueprintUrl, "utf8");

    for (const key of [
      "SPECTRUM_PROJECT_ID",
      "SPECTRUM_PROJECT_SECRET",
      "AGENT_OWNER_HANDLES",
      "SUPERMEMORY_API_KEY",
    ]) {
      expect(blueprint).toMatch(
        new RegExp(`- key: ${key}\\n\\s+sync: false`, "u"),
      );
    }
  });

  it("keeps liveness separate from post-deploy agent readiness", async () => {
    const blueprint = await readFile(blueprintUrl, "utf8");

    expect(blueprint).toContain("startCommand: npm start");
    expect(blueprint).toContain("healthCheckPath: /healthz");
    expect(blueprint).not.toContain("healthCheckPath: /readyz");
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  dependencies?: Record<string, string>;
}

describe("Codex CLI and SDK version pin", () => {
  it("pins exact matching @openai/codex and @openai/codex-sdk versions", () => {
    const manifest = JSON.parse(
      readFileSync(resolve("package.json"), "utf8"),
    ) as PackageManifest;
    const cli = manifest.dependencies?.["@openai/codex"];
    const sdk = manifest.dependencies?.["@openai/codex-sdk"];

    expect(cli).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(sdk).toBe(cli);
  });
});

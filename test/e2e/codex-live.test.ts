import { resolve } from "node:path";

import { z } from "zod";
import { describe, expect, it } from "vitest";

import { CodexClient } from "../../src/agent/codex-client.js";

const liveEnabled = process.env["RUN_CODEX_LIVE"] === "1";
const liveIt = liveEnabled ? it : it.skip;

describe("protected live Codex account", () => {
  liveIt("answers one schema-bound read-only turn", async () => {
    const codexHome = process.env["CODEX_HOME"];
    if (codexHome === undefined) {
      throw new Error("Set CODEX_HOME before RUN_CODEX_LIVE=1.");
    }
    const authMode =
      process.env["CODEX_AUTH_MODE"] === "api_key" ? "api_key" : "chatgpt";
    const client = new CodexClient({
      codexHome: resolve(codexHome),
      authMode,
      parentEnvironment: process.env,
      ...(process.env["OPENAI_API_KEY"] === undefined
        ? {}
        : { openAiApiKey: process.env["OPENAI_API_KEY"] }),
      maximumRuntimeMs: 120_000,
      maximumConcurrency: 1,
    });
    const schema = z.object({ acknowledgement: z.literal("ok") }).strict();
    const result = await client.runStructured({
      prompt:
        "This is an opt-in protected smoke test. Do not inspect files or use tools. Return the schema-bound acknowledgement 'ok'.",
      outputSchema: schema,
      modelProfile: {
        model: process.env["CODEX_LIVE_MODEL"] ?? "gpt-5.6-luna",
        effort: "medium",
      },
      permissionProfile: "read",
      workingDirectory: resolve("."),
      skipGitRepoCheck: false,
    });

    expect(result.output).toEqual({ acknowledgement: "ok" });
    expect(result.threadId.length).toBeGreaterThan(0);
  });
});

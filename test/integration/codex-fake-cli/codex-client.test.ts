import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import {
  CodexClient,
  CodexRuntimeError,
} from "../../../src/agent/codex-client.js";
import { createCodexPairRunner } from "../../../src/config/capabilities.js";

const fakeExecutable = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fake-codex.mjs",
);
const outputSchema = z.object({ ok: z.literal(true) }).strict();
const temporaryDirectories: string[] = [];

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-fake-cli-test-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return directory;
}

function parentEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: process.env["HOME"] ?? "/tmp",
    DATABASE_URL: "postgresql://private",
    SPECTRUM_PROJECT_SECRET: "photon-secret",
    SUPERMEMORY_API_KEY: "memory-secret",
    APP_ENCRYPTION_KEY: "encryption-secret",
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function waitForReadable(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  throw new Error(`Timed out waiting for fake Codex fixture ${path}`);
}

describe("Codex client through pinned SDK and fake CLI", () => {
  it("passes bounded model, sandbox, network, approval, schema, and environment options", async () => {
    const directory = await fixtureDirectory();
    const capturePath = join(directory, "capture.jsonl");
    const client = new CodexClient({
      codexHome: directory,
      authMode: "chatgpt",
      parentEnvironment: parentEnvironment(),
      codexPathOverride: fakeExecutable,
      safeTaskEnvironment: { AGENT_TASK_FAKE_CAPTURE_PATH: capturePath },
    });

    const result = await client.runStructured({
      prompt: "Return the acknowledgement.",
      outputSchema,
      modelProfile: { model: "gpt-5.6-luna", effort: "max" },
      permissionProfile: "workspace-write",
      workingDirectory: directory,
      skipGitRepoCheck: true,
    });
    expect(result).toMatchObject({
      threadId: "fake-thread-new",
      output: { ok: true },
    });

    const [capture] = (await readFile(capturePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        args: string[];
        envKeys: string[];
        outputSchemaExists: boolean;
      });
    expect(capture?.args).toEqual(
      expect.arrayContaining([
        "--model",
        "gpt-5.6-luna",
        "--sandbox",
        "workspace-write",
        "--cd",
        directory,
        "--skip-git-repo-check",
        "--output-schema",
      ]),
    );
    expect(capture?.args).toContain('model_reasoning_effort="max"');
    expect(capture?.args).toContain('cli_auth_credentials_store="file"');
    expect(capture?.args).toContain('forced_login_method="chatgpt"');
    expect(capture?.args).toContain("hide_agent_reasoning=true");
    expect(capture?.args).toContain(
      "sandbox_workspace_write.network_access=false",
    );
    expect(capture?.args).toContain('web_search="disabled"');
    expect(capture?.args).toContain('approval_policy="never"');
    expect(capture?.outputSchemaExists).toBe(true);
    expect(capture?.envKeys).toContain("CODEX_HOME");
    expect(capture?.envKeys).not.toContain("DATABASE_URL");
    expect(capture?.envKeys).not.toContain("SPECTRUM_PROJECT_SECRET");
    expect(capture?.envKeys).not.toContain("SUPERMEMORY_API_KEY");
    expect(capture?.envKeys).not.toContain("APP_ENCRYPTION_KEY");
  });

  it("uses API-key mode without relying on auth.json", async () => {
    const directory = await fixtureDirectory();
    const capturePath = join(directory, "api-capture.jsonl");
    const client = new CodexClient({
      codexHome: directory,
      authMode: "api_key",
      openAiApiKey: "test-api-key",
      parentEnvironment: parentEnvironment(),
      codexPathOverride: fakeExecutable,
      safeTaskEnvironment: { AGENT_TASK_FAKE_CAPTURE_PATH: capturePath },
    });
    await client.runStructured({
      prompt: "Return the acknowledgement.",
      outputSchema,
      modelProfile: { model: "gpt-5.6-luna", effort: "high" },
      permissionProfile: "read",
      workingDirectory: directory,
      skipGitRepoCheck: true,
    });
    const capture = JSON.parse(
      (await readFile(capturePath, "utf8")).trim(),
    ) as { envKeys: string[]; apiKeysMatch: boolean };
    expect(capture.envKeys).toContain("OPENAI_API_KEY");
    expect(capture.envKeys).toContain("CODEX_API_KEY");
    expect(capture.apiKeysMatch).toBe(true);
    const captureWithArgs = capture as typeof capture & { args: string[] };
    expect(captureWithArgs.args).toContain('forced_login_method="api"');
  });

  it.each([
    ["malformed", "CODEX_STRUCTURED_OUTPUT_INVALID"],
    ["oversized", "CODEX_OUTPUT_TOO_LARGE"],
  ] as const)("rejects %s structured output", async (mode, code) => {
    const directory = await fixtureDirectory();
    const client = new CodexClient({
      codexHome: directory,
      authMode: "chatgpt",
      parentEnvironment: parentEnvironment(),
      codexPathOverride: fakeExecutable,
      maximumOutputBytes: 2_048,
      safeTaskEnvironment: { AGENT_TASK_FAKE_MODE: mode },
    });

    await expect(
      client.runStructured({
        prompt: "Return the acknowledgement.",
        outputSchema,
        modelProfile: { model: "gpt-5.6-luna", effort: "high" },
        permissionProfile: "read",
        workingDirectory: directory,
        skipGitRepoCheck: true,
      }),
    ).rejects.toMatchObject({ code });
  });

  it("terminates the fake CLI when the chain aborts", async () => {
    const directory = await fixtureDirectory();
    const capturePath = join(directory, "abort-capture.jsonl");
    const terminationPath = join(directory, "terminated.txt");
    const client = new CodexClient({
      codexHome: directory,
      authMode: "chatgpt",
      parentEnvironment: parentEnvironment(),
      codexPathOverride: fakeExecutable,
      safeTaskEnvironment: {
        AGENT_TASK_FAKE_MODE: "sleep",
        AGENT_TASK_FAKE_CAPTURE_PATH: capturePath,
        AGENT_TASK_FAKE_TERMINATION_PATH: terminationPath,
      },
    });
    const controller = new AbortController();
    const running = client.runStructured({
      prompt: "FAKE_MODE:SLEEP",
      outputSchema,
      modelProfile: { model: "gpt-5.6-luna", effort: "high" },
      permissionProfile: "read",
      workingDirectory: directory,
      skipGitRepoCheck: true,
      signal: controller.signal,
    });
    await waitForReadable(capturePath);
    controller.abort();

    await expect(running).rejects.toMatchObject({ code: "CODEX_CANCELED" });
    await waitForReadable(terminationPath);
    expect(await readFile(terminationPath, "utf8")).toContain("terminated");
  });

  it("terminates the fake CLI at the configured runtime limit", async () => {
    const directory = await fixtureDirectory();
    const capturePath = join(directory, "timeout-capture.jsonl");
    const terminationPath = join(directory, "timeout-terminated.txt");
    const client = new CodexClient({
      codexHome: directory,
      authMode: "chatgpt",
      parentEnvironment: parentEnvironment(),
      codexPathOverride: fakeExecutable,
      maximumRuntimeMs: 500,
      safeTaskEnvironment: {
        AGENT_TASK_FAKE_MODE: "sleep",
        AGENT_TASK_FAKE_CAPTURE_PATH: capturePath,
        AGENT_TASK_FAKE_TERMINATION_PATH: terminationPath,
      },
    });

    const running =
      client.runStructured({
        prompt: "FAKE_MODE:SLEEP",
        outputSchema,
        modelProfile: { model: "gpt-5.6-luna", effort: "high" },
        permissionProfile: "read",
        workingDirectory: directory,
        skipGitRepoCheck: true,
      });
    await waitForReadable(capturePath);
    await expect(
      running,
    ).rejects.toMatchObject({ code: "CODEX_TIMEOUT" });
    await waitForReadable(terminationPath);
    expect(await readFile(terminationPath, "utf8")).toContain("terminated");
  });

  it("classifies a missing persisted session for bounded recovery", async () => {
    const directory = await fixtureDirectory();
    const client = new CodexClient({
      codexHome: directory,
      authMode: "chatgpt",
      parentEnvironment: parentEnvironment(),
      codexPathOverride: fakeExecutable,
    });

    await expect(
      client.runStructured({
        threadId: "missing-session",
        prompt: "Resume this turn.",
        outputSchema,
        modelProfile: { model: "gpt-5.6-luna", effort: "high" },
        permissionProfile: "read",
        workingDirectory: directory,
        skipGitRepoCheck: true,
      }),
    ).rejects.toMatchObject({ code: "CODEX_SESSION_MISSING" });
  });

  it("classifies model and effort capability failures without downgrading", async () => {
    const directory = await fixtureDirectory();
    const client = new CodexClient({
      codexHome: directory,
      authMode: "chatgpt",
      parentEnvironment: parentEnvironment(),
      codexPathOverride: fakeExecutable,
      safeTaskEnvironment: { AGENT_TASK_FAKE_UNSUPPORTED_EFFORT: "max" },
    });
    const runner = createCodexPairRunner(client, directory);

    await expect(runner.probe({ model: "gpt-5.6-luna", effort: "max" })).resolves.toEqual({
      supported: false,
      failure: "effort",
    });
    await expect(runner.probe({ model: "gpt-5.6-luna", effort: "xhigh" })).resolves.toEqual({
      supported: true,
    });
  });

  it("classifies expired authentication and keeps execution paused", async () => {
    const directory = await fixtureDirectory();
    const client = new CodexClient({
      codexHome: directory,
      authMode: "chatgpt",
      parentEnvironment: parentEnvironment(),
      codexPathOverride: fakeExecutable,
      safeTaskEnvironment: { AGENT_TASK_FAKE_AUTH_FAILURE: "true" },
    });

    await expect(
      client.runStructured({
        prompt: "Return the acknowledgement.",
        outputSchema,
        modelProfile: { model: "gpt-5.6-luna", effort: "high" },
        permissionProfile: "read",
        workingDirectory: directory,
        skipGitRepoCheck: true,
      }),
    ).rejects.toMatchObject({
      code: "CODEX_AUTH_FAILED",
      retryable: false,
    } satisfies Partial<CodexRuntimeError>);
  });
});

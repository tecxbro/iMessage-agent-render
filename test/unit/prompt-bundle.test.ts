import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PROMPT_CONTRACT_VERSION,
  PROMPT_FILES,
  loadPromptBundle,
} from "../../src/config/prompt-bundle.js";

describe("prompt bundle", () => {
  it("loads every versioned prompt and produces a stable bundle hash", async () => {
    const first = await loadPromptBundle();
    const second = await loadPromptBundle();

    expect(first.contractVersion).toBe(PROMPT_CONTRACT_VERSION);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toEqual(second);
    expect(Object.keys(first.prompts).sort()).toEqual([...PROMPT_FILES].sort());
    for (const prompt of Object.values(first.prompts)) {
      expect(prompt.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(prompt.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("changes the bundle version when prompt content changes", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "contracts-prompts-"));
    const temporaryPrompts = join(temporaryRoot, "prompts");
    await cp(resolve("prompts"), temporaryPrompts, { recursive: true });

    const before = await loadPromptBundle(temporaryPrompts);
    const target = join(temporaryPrompts, "voice-policy.md");
    const content = await readFile(target, "utf8");
    await writeFile(target, `${content}\n`, "utf8");
    const after = await loadPromptBundle(temporaryPrompts);

    expect(after.version).not.toBe(before.version);
  });

  it("keeps voice adaptive, natural, concise, and restrained with emojis", async () => {
    const bundle = await loadPromptBundle();
    const voice = bundle.prompts["voice-policy.md"]?.content ?? "";
    const interaction = bundle.prompts["interaction.system.md"]?.content ?? "";

    expect(voice).toContain("Lead with the answer, decision, or outcome.");
    expect(voice).toContain(
      "Match the user’s tone, casing, punctuation, and approximate message length when natural.",
    );
    expect(voice).toContain(
      "In casual conversation, prefer a short human reaction over an unnecessary explanation or offer to help.",
    );
    expect(voice).toContain(
      "Subtle wit, dry humor, or mild sass is allowed when it fits naturally.",
    );
    expect(voice).toContain(
      "Use emojis only when the user has used them recently, and keep them rare.",
    );
    expect(interaction).toContain(
      "Match the user’s tone, casing, punctuation, and approximate message length when natural.",
    );
    expect(interaction).toContain(
      "In casual conversation, prefer a short human reaction over an unnecessary explanation or offer to help.",
    );
    expect(interaction).toContain(
      "Subtle wit, dry humor, or mild sass is allowed when it fits naturally.",
    );
    expect(interaction).toContain(
      "Use emojis only when the user has used them recently, and keep them rare.",
    );
  });
});

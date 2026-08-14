import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { CONTRACT_VERSION } from "../contracts/version.js";

export const PROMPT_CONTRACT_VERSION = CONTRACT_VERSION;

export const PROMPT_FILES = [
  "interaction.system.md",
  "execution.system.md",
  "memory-curator.system.md",
  "voice-policy.md",
  "approval-policy.md",
] as const;

export type PromptFileName = (typeof PROMPT_FILES)[number];

const promptHeaderSchema = z
  .object({
    name: z.string().trim().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    output: z.string().trim().min(1).optional(),
  })
  .strict();

export interface LoadedPrompt {
  fileName: PromptFileName;
  name: string;
  version: string;
  output?: string;
  content: string;
  sha256: string;
}

export interface PromptBundle {
  contractVersion: typeof PROMPT_CONTRACT_VERSION;
  version: string;
  sha256: string;
  prompts: Readonly<Record<PromptFileName, LoadedPrompt>>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parsePromptHeader(content: string, fileName: PromptFileName) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (match === null || match[1] === undefined) {
    throw new Error(
      `Prompt ${fileName} is missing YAML-style frontmatter. Add name and version fields before restarting.`,
    );
  }

  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    if (separator < 1) {
      throw new Error(
        `Prompt ${fileName} contains malformed frontmatter. Use one key: value pair per line.`,
      );
    }
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }

  const result = promptHeaderSchema.safeParse(fields);
  if (!result.success) {
    throw new Error(
      `Prompt ${fileName} has invalid frontmatter: ${z.prettifyError(result.error)}`,
    );
  }

  return result.data;
}

export async function loadPromptBundle(
  promptDirectory = resolve("prompts"),
): Promise<PromptBundle> {
  const loaded = await Promise.all(
    PROMPT_FILES.map(async (fileName): Promise<LoadedPrompt> => {
      let content: string;
      try {
        content = await readFile(resolve(promptDirectory, fileName), "utf8");
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown read error";
        throw new Error(
          `Failed to load prompt ${fileName}: ${reason}. Restore the prompt file and restart the service.`,
          { cause: error },
        );
      }

      const header = parsePromptHeader(content, fileName);
      const prompt: LoadedPrompt = {
        fileName,
        name: header.name,
        version: header.version,
        content,
        sha256: sha256(content),
      };
      if (header.output !== undefined) {
        prompt.output = header.output;
      }
      return prompt;
    }),
  );

  const promptRecord = Object.fromEntries(
    loaded.map((prompt) => [prompt.fileName, prompt]),
  ) as Record<PromptFileName, LoadedPrompt>;
  const bundleInput = loaded
    .map(
      (prompt) =>
        `${prompt.fileName}\0${prompt.name}\0${prompt.version}\0${prompt.sha256}`,
    )
    .join("\n");
  const bundleHash = sha256(bundleInput);

  return {
    contractVersion: PROMPT_CONTRACT_VERSION,
    version: `${PROMPT_CONTRACT_VERSION}:${bundleHash}`,
    sha256: bundleHash,
    prompts: promptRecord,
  };
}

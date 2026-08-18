import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPOSITORY_MODULES = [
  "src/db/repositories/orchestration.ts",
  "src/db/repositories/turn-planning.ts",
  "src/db/repositories/task-execution.ts",
  "src/db/repositories/turn-synthesis.ts",
  "src/db/repositories/orchestration-recovery.ts",
  "src/db/repositories/orchestration-codec.ts",
  "src/db/repositories/orchestration-shared.ts",
] as const;

const CONTRACT_MODULES = [
  "src/orchestration/contracts/turn-plan.ts",
  "src/orchestration/contracts/task-execution.ts",
  "src/orchestration/contracts/turn-synthesis.ts",
  "src/orchestration/contracts/capabilities.ts",
] as const;

async function source(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), path), "utf8");
}

describe("orchestration dependency direction", () => {
  it.each(REPOSITORY_MODULES)(
    "%s does not depend on queue handlers",
    async (path) => {
      expect(await source(path)).not.toMatch(/from\s+["'][^"']*queue\/handlers\//u);
    },
  );

  it.each(CONTRACT_MODULES)(
    "%s remains independent of persistence and queue implementations",
    async (path) => {
      const contents = await source(path);

      expect(contents).not.toMatch(/from\s+["'][^"']*db\//u);
      expect(contents).not.toMatch(
        /from\s+["'][^"']*queue\/(?:handlers|boss|pipeline|publisher)(?:[/."'])/u,
      );
    },
  );
});

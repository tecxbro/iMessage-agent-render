import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  interactionDecisionSchema,
  type InteractionDecision,
} from "../../src/agent/schemas.js";
import { executionTaskLevels } from "../../src/agent/task-graph.js";

function fixture(fileName: string): InteractionDecision {
  return interactionDecisionSchema.parse(
    JSON.parse(
      readFileSync(resolve("test/fixtures/step5", fileName), "utf8"),
    ) as unknown,
  );
}

describe("Step 5 turn-planning fixtures", () => {
  it("keeps a simple greeting on the single-call direct path", () => {
    const decision = fixture("direct-greeting.json");

    expect(decision).toMatchObject({
      mode: "direct",
      tasks: [],
      waitForTasks: false,
    });
    expect(decision.userMessage).toBeTruthy();
    expect(decision.statusMessage).toBeUndefined();
    expect(executionTaskLevels(decision.tasks)).toEqual([]);
  });

  it("places independent delegated investigations in one parallel root level", () => {
    const decision = fixture("parallel-delegation.json");
    const levels = executionTaskLevels(decision.tasks);

    expect(decision.mode).toBe("delegate");
    expect(decision.waitForTasks).toBe(true);
    expect(levels.map((level) => level.map((task) => task.id))).toEqual([
      ["inspect-repository", "check-guidance"],
      ["compare-findings"],
    ]);
  });
});

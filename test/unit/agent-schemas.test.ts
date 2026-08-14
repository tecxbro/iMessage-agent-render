import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  executionResultSchema,
  interactionDecisionSchema,
  memoryCandidateSchema,
} from "../../src/agent/schemas.js";

function readFixture(fileName: string): unknown {
  return JSON.parse(
    readFileSync(resolve("test/fixtures/model-output", fileName), "utf8"),
  ) as unknown;
}

describe("model output contracts", () => {
  it("accepts representative valid interaction and execution JSON fixtures", () => {
    expect(
      interactionDecisionSchema.safeParse(
        readFixture("interaction-valid.json"),
      ).success,
    ).toBe(true);
    expect(
      executionResultSchema.safeParse(readFixture("execution-valid.json"))
        .success,
    ).toBe(true);
  });

  it("rejects representative malformed fixtures deterministically", () => {
    const interaction = interactionDecisionSchema.safeParse(
      readFixture("interaction-invalid.json"),
    );
    const execution = executionResultSchema.safeParse(
      readFixture("execution-invalid.json"),
    );

    expect(interaction.success).toBe(false);
    expect(execution.success).toBe(false);
    if (!interaction.success) {
      expect(interaction.error.issues.map((issue) => issue.code)).toContain(
        "unrecognized_keys",
      );
    }
    if (!execution.success) {
      expect(execution.error.issues.map((issue) => issue.path.join("."))).toContain(
        "error",
      );
    }
  });

  it("rejects duplicate IDs, cycles, and graphs deeper than three tasks", () => {
    const base = {
      mode: "delegate",
      modelProfile: "main",
      waitForTasks: true,
      memoryCandidates: [],
    } as const;
    const task = (id: string, dependsOn: string[]) => ({
      id,
      agentName: `agent-${id}`,
      purpose: `Complete ${id}`,
      instructions: `Return evidence for ${id}.`,
      modelProfile: "main",
      permissionProfile: "read",
      dependsOn,
    });

    expect(
      interactionDecisionSchema.safeParse({
        ...base,
        tasks: [task("a", []), task("a", [])],
      }).success,
    ).toBe(false);
    expect(
      interactionDecisionSchema.safeParse({
        ...base,
        tasks: [task("a", ["b"]), task("b", ["a"])],
      }).success,
    ).toBe(false);
    expect(
      interactionDecisionSchema.safeParse({
        ...base,
        tasks: [
          task("a", []),
          task("b", ["a"]),
          task("c", ["b"]),
          task("d", ["c"]),
        ],
      }).success,
    ).toBe(false);
  });

  it("requires explicit support for durable project-scoped memory", () => {
    const candidate = {
      kind: "project_fact",
      scope: "project",
      content: "Project Atlas uses PostgreSQL as its operational store.",
      confidence: 1,
      source: "verified_task_result",
    };

    expect(memoryCandidateSchema.safeParse(candidate).success).toBe(false);
    expect(
      memoryCandidateSchema.safeParse({
        ...candidate,
        projectId: "00000000-0000-4000-8000-000000000010",
      }).success,
    ).toBe(true);
  });

  it("requires proposed actions to remain in needs_approval results", () => {
    const proposedAction = {
      actionType: "filesystem.destructive",
      target: "primary-repo/main",
      normalizedPayload: { command: "git reset" },
      humanSummary: "Reset the primary repository branch.",
    };
    const baseResult = {
      taskId: "task-a",
      userSafeSummary: "The next operation requires approval.",
      artifacts: [],
      proposedActions: [proposedAction],
      memoryCandidates: [],
      error: null,
    };

    expect(
      executionResultSchema.safeParse({
        ...baseResult,
        status: "succeeded",
      }).success,
    ).toBe(false);
    expect(
      executionResultSchema.safeParse({
        ...baseResult,
        status: "needs_approval",
      }).success,
    ).toBe(true);
  });
});

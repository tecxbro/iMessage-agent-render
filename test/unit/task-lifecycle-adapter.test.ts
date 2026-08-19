import { describe, expect, it, vi } from "vitest";

import { TaskLifecycleAdapter } from "../../src/conversation/task-lifecycle-adapter.js";
import { TaskLifecycleError } from "../../src/db/repositories/task-operations.js";

const runId = "71000000-0000-4000-8000-000000000001";
const spaceId = "71000000-0000-4000-8000-000000000002";
const chainId = "71000000-0000-4000-8000-000000000003";
const taskId = "71000000-0000-4000-8000-000000000004";

function fixture() {
  const operations = {
    createDelegatedChain: vi.fn().mockResolvedValue({
      chainId,
      chainVersion: 1,
      spaceId,
      sourceInteractionRunId: runId,
      created: true,
      rootTasks: [
        {
          taskId,
          chainId,
          expectedChainVersion: 1,
          expectedState: "queued" as const,
        },
      ],
    }),
    cancelTask: vi.fn(),
    reviseTask: vi.fn(),
    pauseTask: vi.fn(),
    cancelInteractionTurn: vi.fn(),
  };
  const readiness = {
    loadInteractionTaskSnapshot: vi.fn().mockResolvedValue({
      pendingCount: 0,
      terminalResults: [{ status: "succeeded" }],
    }),
    findResultReadySignals: vi.fn().mockResolvedValue([
      { spaceId, reason: "task_results_ready" as const },
    ]),
  };
  const taskPublisher = { enqueueTaskExecute: vi.fn() };
  const wakePublisher = { publish: vi.fn() };
  return {
    adapter: new TaskLifecycleAdapter({
      operations,
      readiness,
      taskPublisher,
      wakePublisher,
    }),
    operations,
    readiness,
    taskPublisher,
    wakePublisher,
  };
}

const delegatedTask = {
  id: "inspect",
  agentName: "reviewer",
  purpose: "Inspect the requested behavior.",
  instructions: "Return bounded evidence.",
  workspaceBinding: "personal",
  permissionProfile: "read" as const,
  dependsOn: [],
};

describe("TaskLifecycleAdapter", () => {
  it("does not mutate tasks for a normal interaction decision", async () => {
    const { adapter, operations, taskPublisher } = fixture();

    await adapter.dispatch({
      interactionRunId: runId,
      generation: 4,
      decisionMetadataJson: {
        mode: "direct",
        topic: "ordinary-message",
        // Even malformed or stale task metadata on a normal message cannot
        // turn it into durable delegation.
        tasks: [delegatedTask],
      },
    });

    expect(operations.createDelegatedChain).not.toHaveBeenCalled();
    expect(taskPublisher.enqueueTaskExecute).not.toHaveBeenCalled();
  });

  it("creates durable delegated work and publishes only runnable roots", async () => {
    const { adapter, operations, taskPublisher } = fixture();

    await adapter.dispatch({
      interactionRunId: runId,
      generation: 4,
      decisionMetadataJson: { mode: "delegate", tasks: [delegatedTask] },
    });

    expect(operations.createDelegatedChain).toHaveBeenCalledWith(runId, [
      delegatedTask,
    ]);
    expect(taskPublisher.enqueueTaskExecute).toHaveBeenCalledWith({
      taskId,
      chainId,
      expectedChainVersion: 1,
      expectedState: "queued",
    });
  });

  it("returns readiness to the actor without starting synthesis", async () => {
    const { adapter, readiness, operations, taskPublisher } = fixture();

    await expect(
      adapter.reconcile({ interactionRunId: runId, generation: 4 }),
    ).resolves.toEqual({
      pendingCount: 0,
      terminalResults: [{ status: "succeeded" }],
    });
    await expect(
      adapter.reconcile({ interactionRunId: runId, generation: 4 }),
    ).resolves.toEqual({
      pendingCount: 0,
      terminalResults: [{ status: "succeeded" }],
    });

    expect(readiness.loadInteractionTaskSnapshot).toHaveBeenCalledTimes(2);
    expect(operations.createDelegatedChain).not.toHaveBeenCalled();
    expect(taskPublisher.enqueueTaskExecute).not.toHaveBeenCalled();
  });

  it("publishes minimal, repeatable result-ready wakes without synthesis data", async () => {
    const { adapter, wakePublisher } = fixture();

    await adapter.publishTaskResultsReady(spaceId);
    await adapter.publishTaskResultsReady(spaceId);

    expect(wakePublisher.publish).toHaveBeenCalledTimes(2);
    expect(wakePublisher.publish).toHaveBeenNthCalledWith(1, {
      spaceId,
      reason: "task_results_ready",
    });
    expect(Object.keys(wakePublisher.publish.mock.calls[0]?.[0] ?? {})).toEqual([
      "spaceId",
      "reason",
    ]);
  });

  it("re-publishes recoverable readiness signals and preserves typed pause errors", async () => {
    const { adapter, operations, wakePublisher } = fixture();
    operations.pauseTask.mockRejectedValue(
      new TaskLifecycleError(
        "TASK_PAUSE_UNSUPPORTED_WHILE_RUNNING",
        "No durable runtime checkpoint is available.",
      ),
    );

    await expect(adapter.recoverResultReadyWakes()).resolves.toBe(1);
    expect(wakePublisher.publish).toHaveBeenCalledWith({
      spaceId,
      reason: "task_results_ready",
    });
    await expect(adapter.pauseTask(taskId, "Hold this work.")).rejects.toMatchObject({
      code: "TASK_PAUSE_UNSUPPORTED_WHILE_RUNNING",
    });
  });
});

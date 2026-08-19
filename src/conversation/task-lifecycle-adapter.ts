import { z } from "zod";

import { executionTaskGraphSchema } from "../agent/schemas.js";
import type {
  InteractionTaskPort,
  InteractionTaskSnapshot,
  InteractionWakePublisherPort,
} from "./contracts.js";
import type {
  InteractionTurnCancellationResult,
  TaskCancellationResult,
  TaskOperationsRepository,
  TaskPauseResult,
  TaskRevisionResult,
} from "../db/repositories/task-operations.js";
import type { TaskResultReadinessRepository } from "../db/repositories/task-result-readiness.js";
import type { TaskExecutePayload } from "../queue/payloads.js";

const identifierSchema = z.uuid();

const delegationMetadataSchema = z
  .object({
    mode: z.string().optional(),
    route: z.string().optional(),
    tasks: z.unknown().optional(),
  })
  .passthrough();

export interface TaskExecutionPublisherPort {
  enqueueTaskExecute(payload: TaskExecutePayload): Promise<void>;
}

export interface TaskLifecycleAdapterOptions {
  operations: Pick<
    TaskOperationsRepository,
    | "createDelegatedChain"
    | "cancelTask"
    | "reviseTask"
    | "pauseTask"
    | "cancelInteractionTurn"
  >;
  readiness: Pick<
    TaskResultReadinessRepository,
    "loadInteractionTaskSnapshot" | "findResultReadySignals"
  >;
  taskPublisher?: TaskExecutionPublisherPort;
  wakePublisher?: InteractionWakePublisherPort;
}

/**
 * Conversation-facing adapter for explicit durable task work. Direct and
 * ordinary interaction decisions are deliberate no-ops. Result completion
 * only wakes the actor; this adapter never invokes synthesis itself.
 */
export class TaskLifecycleAdapter implements InteractionTaskPort {
  public constructor(private readonly options: TaskLifecycleAdapterOptions) {}

  public async dispatch(input: {
    interactionRunId: string;
    generation: number;
    decisionMetadataJson: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    identifierSchema.parse(input.interactionRunId);
    z.number().int().nonnegative().parse(input.generation);
    const metadata = delegationMetadataSchema.parse(
      input.decisionMetadataJson,
    );
    const route = metadata.mode ?? metadata.route;
    if (route !== "delegate") {
      return;
    }

    const tasks = executionTaskGraphSchema.parse(metadata.tasks ?? []);
    const delegated = await this.options.operations.createDelegatedChain(
      input.interactionRunId,
      tasks,
    );
    if (this.options.taskPublisher !== undefined) {
      for (const payload of delegated.rootTasks) {
        await this.options.taskPublisher.enqueueTaskExecute(payload);
      }
    }
  }

  public async reconcile(input: {
    interactionRunId: string;
    generation: number;
  }): Promise<InteractionTaskSnapshot> {
    identifierSchema.parse(input.interactionRunId);
    z.number().int().nonnegative().parse(input.generation);
    return await this.options.readiness.loadInteractionTaskSnapshot(
      input.interactionRunId,
    );
  }

  public cancelTask(
    taskId: string,
    reason: string,
  ): Promise<TaskCancellationResult> {
    return this.options.operations.cancelTask(taskId, reason);
  }

  public reviseTask(
    taskId: string,
    revisedInstructions: string,
  ): Promise<TaskRevisionResult> {
    return this.options.operations.reviseTask(taskId, revisedInstructions);
  }

  public pauseTask(taskId: string, reason: string): Promise<TaskPauseResult> {
    return this.options.operations.pauseTask(taskId, reason);
  }

  public cancelInteractionTurn(
    runId: string,
    reason: string,
  ): Promise<InteractionTurnCancellationResult> {
    return this.options.operations.cancelInteractionTurn(runId, reason);
  }

  public async publishTaskResultsReady(spaceId: string): Promise<void> {
    const parsedSpaceId = identifierSchema.parse(spaceId);
    if (this.options.wakePublisher === undefined) {
      throw new Error(
        "Task result wake publishing is not configured. Compose an InteractionWakePublisherPort before enabling task completion.",
      );
    }
    await this.options.wakePublisher.publish({
      spaceId: parsedSpaceId,
      reason: "task_results_ready",
    });
  }

  public async recoverResultReadyWakes(limit = 100): Promise<number> {
    if (this.options.wakePublisher === undefined) {
      throw new Error(
        "Task result wake recovery is not configured. Compose an InteractionWakePublisherPort before reconciliation.",
      );
    }
    const signals = await this.options.readiness.findResultReadySignals(limit);
    for (const signal of signals) {
      await this.options.wakePublisher.publish(signal);
    }
    return signals.length;
  }
}

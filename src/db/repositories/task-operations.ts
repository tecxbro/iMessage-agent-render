import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import { z } from "zod";

import {
  executionResultSchema,
  executionTaskGraphSchema,
  type ExecutionTask,
} from "../../agent/schemas.js";
import type { TaskExecutePayload } from "../../queue/payloads.js";
import type { Database, DatabaseTransaction } from "../client.js";
import {
  interactionAuthorizationReferences,
  interactionRuns,
} from "../schema-fragments/conversation-actors.js";
import { chainAuthorizationIdentities } from "../schema-fragments/chain-authorization.js";
import {
  agentThreads,
  chains,
  executionTasks,
  spaces,
} from "../schema.js";

const identifierSchema = z.uuid();
const reasonSchema = z.string().trim().min(1).max(1_000);
const revisedInstructionsSchema = z.string().trim().min(1).max(8_000);

export const TASK_LIFECYCLE_ERROR_CODES = [
  "TASK_DELEGATION_EMPTY",
  "TASK_SOURCE_INTERACTION_NOT_FOUND",
  "TASK_SOURCE_INTERACTION_NOT_DELEGATABLE",
  "TASK_SOURCE_AUTHORIZATION_NOT_FOUND",
  "TASK_DELEGATION_CONFLICT",
  "TASK_NOT_FOUND",
  "TASK_STATE_CONFLICT",
  "TASK_REVISION_UNSUPPORTED",
  "TASK_PAUSE_UNSUPPORTED_WHILE_RUNNING",
  "TASK_PAUSE_UNSUPPORTED_IN_CURRENT_STATE",
] as const;

export type TaskLifecycleErrorCode =
  (typeof TASK_LIFECYCLE_ERROR_CODES)[number];

export class TaskLifecycleError extends Error {
  public readonly retryable = false;

  public constructor(
    public readonly code: TaskLifecycleErrorCode,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`${code}. ${detail}`, options);
    this.name = "TaskLifecycleError";
  }
}

export interface TaskOperationsRepositoryOptions {
  encrypt(plaintext: string): Promise<string> | string;
  decrypt(ciphertext: string): Promise<string> | string;
  now?: () => Date;
  createId?: () => string;
}

export interface DelegatedChainCreation {
  chainId: string;
  chainVersion: number;
  spaceId: string;
  sourceInteractionRunId: string;
  created: boolean;
  rootTasks: readonly TaskExecutePayload[];
}

export interface TaskCancellationResult {
  taskId: string;
  previousState: string;
  state: "canceled";
  applied: boolean;
}

export interface TaskRevisionResult {
  previousTaskId: string;
  revisedTaskId: string;
  logicalTaskId: string;
  revision: number;
  payload: TaskExecutePayload;
}

export interface TaskPauseResult {
  taskId: string;
  state: "paused";
  applied: boolean;
}

export interface InteractionTurnCancellationResult {
  interactionRunId: string;
  canceledChainCount: number;
  canceledTaskCount: number;
}

interface PauseCheckpoint {
  kind: "task_pause";
  agentThreadId: string;
  reason: string;
  pausedAt: string;
}

const pauseEnvelopeSchema = z
  .object({ lifecycleCiphertext: z.string().min(1) })
  .strict();

const pauseCheckpointSchema = z
  .object({
    kind: z.literal("task_pause"),
    agentThreadId: identifierSchema,
    reason: reasonSchema,
    pausedAt: z.iso.datetime(),
  })
  .strict();

const delegatedDecisionSchema = z
  .object({
    mode: z.literal("delegate"),
    tasks: z.array(
      z.object({ id: z.string().trim().min(1).max(64) }).passthrough(),
    ),
  })
  .passthrough();

const activeChainStates = [
  "queued",
  "planning",
  "executing",
  "awaiting_approval",
  "synthesizing",
  "sending",
] as const;

const mutableTaskStates = ["queued", "running"] as const;

function sourceTaskIds(tasks: readonly ExecutionTask[]): Set<string> {
  return new Set(tasks.map((task) => task.id));
}

function revisionIdentity(logicalTaskId: string): {
  base: string;
  currentRevision: number;
} {
  const match = /^(.*)-r([2-9][0-9]*)$/u.exec(logicalTaskId);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return { base: logicalTaskId, currentRevision: 1 };
  }
  return { base: match[1], currentRevision: Number(match[2]) };
}

function revisionLogicalId(base: string, revision: number): string {
  const suffix = `-r${revision}`;
  return `${base.slice(0, 64 - suffix.length)}${suffix}`;
}

/**
 * Explicit task lifecycle mutations for the conversation actor. This module
 * owns lifecycle changes while the focused planning/execution/synthesis
 * repositories retain their existing runtime responsibilities.
 */
export class TaskOperationsRepository {
  private readonly now: () => Date;
  private readonly createId: () => string;

  public constructor(
    private readonly database: Database,
    private readonly options: TaskOperationsRepositoryOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  public async createDelegatedChain(
    sourceInteractionRunId: string,
    tasks: readonly ExecutionTask[],
  ): Promise<DelegatedChainCreation> {
    const runId = identifierSchema.parse(sourceInteractionRunId);
    const parsedTasks = executionTaskGraphSchema.parse(tasks);
    if (parsedTasks.length === 0) {
      throw new TaskLifecycleError(
        "TASK_DELEGATION_EMPTY",
        "A delegated chain requires at least one durable execution task.",
      );
    }

    return await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${interactionRuns} where ${interactionRuns.id} = ${runId} for update`,
      );
      const [run] = await transaction
        .select({
          id: interactionRuns.id,
          spaceId: interactionRuns.spaceId,
          state: interactionRuns.state,
          modelId: interactionRuns.modelId,
          reasoningEffort: interactionRuns.reasoningEffort,
          promptVersion: interactionRuns.promptVersion,
          ownerId: interactionAuthorizationReferences.ownerId,
          identityId: interactionAuthorizationReferences.identityId,
        })
        .from(interactionRuns)
        .leftJoin(
          interactionAuthorizationReferences,
          eq(
            interactionAuthorizationReferences.interactionRunId,
            interactionRuns.id,
          ),
        )
        .where(eq(interactionRuns.id, runId))
        .limit(1);
      if (run === undefined) {
        throw new TaskLifecycleError(
          "TASK_SOURCE_INTERACTION_NOT_FOUND",
          "Reload the conversation before attempting to delegate work.",
        );
      }
      if (run.ownerId === null || run.identityId === null) {
        throw new TaskLifecycleError(
          "TASK_SOURCE_AUTHORIZATION_NOT_FOUND",
          "The interaction authorization snapshot is missing; reject delegation without starting a task.",
        );
      }

      const existing = await this.loadExistingDelegation(
        transaction,
        runId,
        sourceTaskIds(parsedTasks),
      );
      if (existing !== null) {
        return existing;
      }
      if (
        run.state !== "starting" &&
        run.state !== "active" &&
        run.state !== "finalizing"
      ) {
        throw new TaskLifecycleError(
          "TASK_SOURCE_INTERACTION_NOT_DELEGATABLE",
          `Interaction run ${runId} is ${run.state}; only an active interaction may create durable work.`,
        );
      }

      await transaction.execute(
        sql`select id from ${spaces} where ${spaces.id} = ${run.spaceId} for update`,
      );
      const [versionRow] = await transaction
        .select({ version: max(chains.version) })
        .from(chains)
        .where(eq(chains.spaceId, run.spaceId));
      const chainVersion = (versionRow?.version ?? 0) + 1;
      const chainId = this.createId();
      const now = this.now();
      await transaction.insert(chains).values({
        id: chainId,
        spaceId: run.spaceId,
        version: chainVersion,
        state: "executing",
        chainStartedAt: now,
        modelProfile: "main",
        modelId: run.modelId,
        reasoningEffort: run.reasoningEffort,
        modelSelectionSource: "interaction_run",
        promptVersion: run.promptVersion,
        sourceInteractionRunId: runId,
        decisionJson: {
          mode: "delegate",
          sourceInteractionRunId: runId,
          taskCount: parsedTasks.length,
          tasks: parsedTasks.map((task) => ({
            id: task.id,
            agentName: task.agentName,
            workspaceBinding: task.workspaceBinding ?? task.agentName,
            permissionProfile: task.permissionProfile,
            dependsOn: task.dependsOn,
          })),
        },
        updatedAt: now,
      });
      await transaction.insert(chainAuthorizationIdentities).values({
        chainId,
        identityId: run.identityId,
        isPrincipal: true,
        acceptedAt: now,
      });

      const taskIds = new Map(
        parsedTasks.map((task) => [task.id, this.createId()]),
      );
      const rootTasks: TaskExecutePayload[] = [];
      for (const task of parsedTasks) {
        const workspaceBinding = task.workspaceBinding ?? task.agentName;
        const [thread] = await transaction
          .insert(agentThreads)
          .values({
            id: this.createId(),
            ownerId: run.ownerId,
            agentName: task.agentName,
            workspaceBinding,
            lastModelProfile: "main",
            status: "active",
            lastUsedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              agentThreads.ownerId,
              agentThreads.agentName,
              agentThreads.workspaceBinding,
            ],
            set: {
              lastModelProfile: "main",
              lastUsedAt: now,
              updatedAt: now,
            },
          })
          .returning({ id: agentThreads.id, status: agentThreads.status });
        if (thread === undefined || thread.status === "disabled") {
          throw new TaskLifecycleError(
            "TASK_STATE_CONFLICT",
            `Execution context ${task.agentName} is disabled or unavailable. Choose another configured context.`,
          );
        }
        const taskId = taskIds.get(task.id);
        if (taskId === undefined) {
          throw new TaskLifecycleError(
            "TASK_DELEGATION_CONFLICT",
            "The durable task identifier map is incomplete; retry the entire delegation transaction.",
          );
        }
        const dependencies = task.dependsOn.map((dependency) => {
          const dependencyId = taskIds.get(dependency);
          if (dependencyId === undefined) {
            throw new TaskLifecycleError(
              "TASK_DELEGATION_CONFLICT",
              `Task ${task.id} references unknown dependency ${dependency}.`,
            );
          }
          return dependencyId;
        });
        await transaction.insert(executionTasks).values({
          id: taskId,
          chainId,
          agentThreadId: thread.id,
          name: task.id,
          purpose: await this.options.encrypt(task.purpose),
          instructionsCiphertext: await this.options.encrypt(task.instructions),
          modelProfile: "main",
          permissionProfile: task.permissionProfile,
          state: "queued",
          dependsOnJson: dependencies,
          updatedAt: now,
        });
        if (dependencies.length === 0) {
          rootTasks.push({
            taskId,
            chainId,
            expectedChainVersion: chainVersion,
            expectedState: "queued",
          });
        }
      }

      return {
        chainId,
        chainVersion,
        spaceId: run.spaceId,
        sourceInteractionRunId: runId,
        created: true,
        rootTasks,
      };
    });
  }

  public async cancelTask(
    taskId: string,
    reason: string,
  ): Promise<TaskCancellationResult> {
    const parsedTaskId = identifierSchema.parse(taskId);
    const parsedReason = reasonSchema.parse(reason);
    return await this.database.transaction(async (transaction) => {
      await this.lockTask(transaction, parsedTaskId);
      const [task] = await transaction
        .select({
          id: executionTasks.id,
          logicalId: executionTasks.name,
          state: executionTasks.state,
        })
        .from(executionTasks)
        .where(eq(executionTasks.id, parsedTaskId))
        .limit(1);
      if (task === undefined) {
        throw new TaskLifecycleError(
          "TASK_NOT_FOUND",
          "Reload the task list before retrying cancellation.",
        );
      }
      if (task.state === "canceled") {
        return {
          taskId: task.id,
          previousState: task.state,
          state: "canceled",
          applied: false,
        };
      }
      if (!mutableTaskStates.includes(task.state as "queued" | "running")) {
        throw new TaskLifecycleError(
          "TASK_STATE_CONFLICT",
          `Task ${task.id} is already ${task.state} and cannot be canceled.`,
        );
      }
      await transaction
        .update(executionTasks)
        .set({
          state: "canceled",
          resultJson: await this.terminalResult(
            task.logicalId,
            "TASK_CANCELED",
            parsedReason,
          ),
          completedAt: this.now(),
          updatedAt: this.now(),
        })
        .where(eq(executionTasks.id, task.id));
      return {
        taskId: task.id,
        previousState: task.state,
        state: "canceled",
        applied: true,
      };
    });
  }

  public async reviseTask(
    taskId: string,
    revisedInstructions: string,
  ): Promise<TaskRevisionResult> {
    const parsedTaskId = identifierSchema.parse(taskId);
    const instructions = revisedInstructionsSchema.parse(revisedInstructions);
    return await this.database.transaction(async (transaction) => {
      await this.lockTask(transaction, parsedTaskId);
      const [task] = await transaction
        .select({
          id: executionTasks.id,
          chainId: executionTasks.chainId,
          agentThreadId: executionTasks.agentThreadId,
          logicalId: executionTasks.name,
          purpose: executionTasks.purpose,
          instructionsCiphertext: executionTasks.instructionsCiphertext,
          modelProfile: executionTasks.modelProfile,
          permissionProfile: executionTasks.permissionProfile,
          state: executionTasks.state,
          dependencies: executionTasks.dependsOnJson,
          resultJson: executionTasks.resultJson,
          chainVersion: chains.version,
          chainState: chains.state,
          canceledAt: chains.canceledAt,
        })
        .from(executionTasks)
        .innerJoin(chains, eq(chains.id, executionTasks.chainId))
        .where(eq(executionTasks.id, parsedTaskId))
        .limit(1);
      if (task === undefined) {
        throw new TaskLifecycleError(
          "TASK_NOT_FOUND",
          "Reload the task list before revising instructions.",
        );
      }
      if (
        !mutableTaskStates.includes(task.state as "queued" | "running") ||
        task.chainState !== "executing" ||
        task.canceledAt !== null
      ) {
        throw new TaskLifecycleError(
          "TASK_REVISION_UNSUPPORTED",
          `Task ${task.id} is ${task.state} in a ${task.chainState} chain; create a new interaction instead.`,
        );
      }
      if (task.instructionsCiphertext === null) {
        throw new TaskLifecycleError(
          "TASK_STATE_CONFLICT",
          "The previous encrypted instructions are missing, so an auditable revision cannot be created.",
        );
      }

      const rows = await transaction
        .select({
          id: executionTasks.id,
          logicalId: executionTasks.name,
          state: executionTasks.state,
          dependencies: executionTasks.dependsOnJson,
        })
        .from(executionTasks)
        .where(eq(executionTasks.chainId, task.chainId))
        .orderBy(asc(executionTasks.createdAt), asc(executionTasks.id));
      const identity = revisionIdentity(task.logicalId);
      const lineageRevisions = rows.map((row) => {
        const candidate = revisionIdentity(row.logicalId);
        return candidate.base === identity.base ? candidate.currentRevision : 0;
      });
      const revision = Math.max(identity.currentRevision, ...lineageRevisions) + 1;
      const logicalTaskId = revisionLogicalId(identity.base, revision);
      const revisedTaskId = this.createId();
      const agentThreadId = await this.agentThreadForRevision(task);
      const now = this.now();

      await transaction
        .update(executionTasks)
        .set({
          state: "canceled",
          resultJson: await this.terminalResult(
            task.logicalId,
            "TASK_REVISED",
            `Revised as ${logicalTaskId}.`,
          ),
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(executionTasks.id, task.id));
      await transaction.insert(executionTasks).values({
        id: revisedTaskId,
        chainId: task.chainId,
        agentThreadId,
        name: logicalTaskId,
        purpose: task.purpose,
        instructionsCiphertext: await this.options.encrypt(instructions),
        modelProfile: task.modelProfile,
        permissionProfile: task.permissionProfile,
        state: "queued",
        dependsOnJson: task.dependencies,
        updatedAt: now,
      });

      for (const dependent of rows) {
        if (dependent.id === task.id || dependent.state !== "queued") {
          continue;
        }
        const dependencies = dependent.dependencies.map((dependency) =>
          dependency === task.id ? revisedTaskId : dependency,
        );
        if (
          dependencies.some(
            (dependency, index) =>
              dependency !== dependent.dependencies[index],
          )
        ) {
          await transaction
            .update(executionTasks)
            .set({ dependsOnJson: dependencies, updatedAt: now })
            .where(eq(executionTasks.id, dependent.id));
        }
      }

      return {
        previousTaskId: task.id,
        revisedTaskId,
        logicalTaskId,
        revision,
        payload: {
          taskId: revisedTaskId,
          chainId: task.chainId,
          expectedChainVersion: task.chainVersion,
          expectedState: "queued",
        },
      };
    });
  }

  public async pauseTask(
    taskId: string,
    reason: string,
  ): Promise<TaskPauseResult> {
    const parsedTaskId = identifierSchema.parse(taskId);
    const parsedReason = reasonSchema.parse(reason);
    return await this.database.transaction(async (transaction) => {
      await this.lockTask(transaction, parsedTaskId);
      const [task] = await transaction
        .select({
          id: executionTasks.id,
          state: executionTasks.state,
          agentThreadId: executionTasks.agentThreadId,
          resultJson: executionTasks.resultJson,
        })
        .from(executionTasks)
        .where(eq(executionTasks.id, parsedTaskId))
        .limit(1);
      if (task === undefined) {
        throw new TaskLifecycleError(
          "TASK_NOT_FOUND",
          "Reload the task list before pausing.",
        );
      }
      if (task.state === "running") {
        throw new TaskLifecycleError(
          "TASK_PAUSE_UNSUPPORTED_WHILE_RUNNING",
          "The active runtime has no durable pause/checkpoint primitive. Leave it running or cancel it explicitly.",
        );
      }
      if (task.state !== "queued") {
        throw new TaskLifecycleError(
          "TASK_PAUSE_UNSUPPORTED_IN_CURRENT_STATE",
          `Task ${task.id} is ${task.state}; only queued work can be paused without a runtime checkpoint.`,
        );
      }
      if (await this.pauseCheckpoint(task.resultJson)) {
        return { taskId: task.id, state: "paused", applied: false };
      }
      if (task.agentThreadId === null) {
        throw new TaskLifecycleError(
          "TASK_STATE_CONFLICT",
          "The queued task has no execution context to checkpoint. Repair the task before retrying pause.",
        );
      }
      const checkpoint: PauseCheckpoint = {
        kind: "task_pause",
        agentThreadId: task.agentThreadId,
        reason: parsedReason,
        pausedAt: this.now().toISOString(),
      };
      await transaction
        .update(executionTasks)
        .set({
          // The existing claimer requires an agent-thread join. Clearing this
          // reference is the compatibility checkpoint that keeps a paused
          // queued task ineligible without pretending it was canceled.
          agentThreadId: null,
          resultJson: {
            lifecycleCiphertext: await this.options.encrypt(
              JSON.stringify(checkpoint),
            ),
          },
          updatedAt: this.now(),
        })
        .where(eq(executionTasks.id, task.id));
      return { taskId: task.id, state: "paused", applied: true };
    });
  }

  public async cancelInteractionTurn(
    runId: string,
    reason: string,
  ): Promise<InteractionTurnCancellationResult> {
    const parsedRunId = identifierSchema.parse(runId);
    const parsedReason = reasonSchema.parse(reason);
    return await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${interactionRuns} where ${interactionRuns.id} = ${parsedRunId} for update`,
      );
      const delegatedChains = await transaction
        .select({ id: chains.id, state: chains.state })
        .from(chains)
        .where(eq(chains.sourceInteractionRunId, parsedRunId));
      let canceledTaskCount = 0;
      let canceledChainCount = 0;
      const now = this.now();
      for (const chain of delegatedChains) {
        await transaction.execute(
          sql`select id from ${chains} where ${chains.id} = ${chain.id} for update`,
        );
        const tasks = await transaction
          .select({
            id: executionTasks.id,
            logicalId: executionTasks.name,
            state: executionTasks.state,
          })
          .from(executionTasks)
          .where(eq(executionTasks.chainId, chain.id));
        for (const task of tasks) {
          if (!mutableTaskStates.includes(task.state as "queued" | "running")) {
            continue;
          }
          await transaction
            .update(executionTasks)
            .set({
              state: "canceled",
              resultJson: await this.terminalResult(
                task.logicalId,
                "INTERACTION_TURN_CANCELED",
                parsedReason,
              ),
              completedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(executionTasks.id, task.id),
                inArray(executionTasks.state, mutableTaskStates),
              ),
            );
          canceledTaskCount += 1;
        }
        if (activeChainStates.includes(chain.state as (typeof activeChainStates)[number])) {
          await transaction
            .update(chains)
            .set({
              state: "canceled",
              canceledAt: now,
              terminalErrorCode: "INTERACTION_TURN_CANCELED",
              completedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(chains.id, chain.id),
                inArray(chains.state, activeChainStates),
              ),
            );
          canceledChainCount += 1;
        }
      }
      return {
        interactionRunId: parsedRunId,
        canceledChainCount,
        canceledTaskCount,
      };
    });
  }

  private async loadExistingDelegation(
    transaction: DatabaseTransaction,
    sourceInteractionRunId: string,
    expectedLogicalIds: ReadonlySet<string>,
  ): Promise<DelegatedChainCreation | null> {
    const existingChains = await transaction
      .select({
        id: chains.id,
        version: chains.version,
        spaceId: chains.spaceId,
        decisionJson: chains.decisionJson,
      })
      .from(chains)
      .where(eq(chains.sourceInteractionRunId, sourceInteractionRunId));
    if (existingChains.length === 0) {
      return null;
    }
    const chain = existingChains[0];
    if (existingChains.length !== 1 || chain === undefined) {
      throw new TaskLifecycleError(
        "TASK_DELEGATION_CONFLICT",
        "More than one chain references the interaction run. Repair the duplicate provenance before retrying.",
      );
    }
    const originalDecision = delegatedDecisionSchema.safeParse(
      chain.decisionJson,
    );
    const originalLogicalIds = new Set(
      originalDecision.success
        ? originalDecision.data.tasks.map((task) => task.id)
        : [],
    );
    if (
      originalLogicalIds.size !== expectedLogicalIds.size ||
      [...expectedLogicalIds].some(
        (logicalId) => !originalLogicalIds.has(logicalId),
      )
    ) {
      throw new TaskLifecycleError(
        "TASK_DELEGATION_CONFLICT",
        "The interaction already owns a different durable task graph. Reconcile its recorded delegation instead of replacing it.",
      );
    }
    const rows = await transaction
      .select({
        id: executionTasks.id,
        state: executionTasks.state,
        dependencies: executionTasks.dependsOnJson,
        resultJson: executionTasks.resultJson,
      })
      .from(executionTasks)
      .where(eq(executionTasks.chainId, chain.id));
    if (rows.length === 0) {
      throw new TaskLifecycleError(
        "TASK_DELEGATION_CONFLICT",
        "The interaction chain exists without durable tasks. Repair the incomplete delegation before retrying.",
      );
    }
    return {
      chainId: chain.id,
      chainVersion: chain.version,
      spaceId: chain.spaceId,
      sourceInteractionRunId,
      created: false,
      rootTasks: rows
        .filter(
          (row) =>
            row.state === "queued" &&
            row.dependencies.length === 0 &&
            !pauseEnvelopeSchema.safeParse(row.resultJson).success,
        )
        .map((row) => ({
          taskId: row.id,
          chainId: chain.id,
          expectedChainVersion: chain.version,
          expectedState: "queued" as const,
        })),
    };
  }

  private async lockTask(
    transaction: DatabaseTransaction,
    taskId: string,
  ): Promise<void> {
    await transaction.execute(
      sql`select id from ${executionTasks} where ${executionTasks.id} = ${taskId} for update`,
    );
  }

  private async terminalResult(
    logicalTaskId: string,
    code: "TASK_CANCELED" | "TASK_REVISED" | "INTERACTION_TURN_CANCELED",
    reason: string,
  ): Promise<Record<string, unknown>> {
    const result = executionResultSchema.parse({
      taskId: logicalTaskId,
      status: "canceled",
      userSafeSummary:
        code === "TASK_REVISED"
          ? "This task was replaced by revised instructions."
          : "This task was canceled explicitly.",
      artifacts: [],
      proposedActions: [],
      memoryCandidates: [],
      error: {
        code,
        retryable: false,
        safeMessage: reason,
      },
    });
    return {
      ciphertext: await this.options.encrypt(JSON.stringify(result)),
    };
  }

  private async pauseCheckpoint(
    resultJson: Record<string, unknown> | null,
  ): Promise<PauseCheckpoint | null> {
    const envelope = pauseEnvelopeSchema.safeParse(resultJson);
    if (!envelope.success) {
      return null;
    }
    const plaintext = await this.options.decrypt(
      envelope.data.lifecycleCiphertext,
    );
    return pauseCheckpointSchema.parse(JSON.parse(plaintext) as unknown);
  }

  private async agentThreadForRevision(task: {
    agentThreadId: string | null;
    resultJson: Record<string, unknown> | null;
  }): Promise<string> {
    if (task.agentThreadId !== null) {
      return task.agentThreadId;
    }
    const checkpoint = await this.pauseCheckpoint(task.resultJson);
    if (checkpoint === null) {
      throw new TaskLifecycleError(
        "TASK_STATE_CONFLICT",
        "The task has no recoverable execution context for its revision.",
      );
    }
    return checkpoint.agentThreadId;
  }
}

import { and, asc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";

import {
  executionResultSchema,
  type ExecutionResult,
} from "../../agent/schemas.js";
import type { InteractionTaskSnapshot } from "../../conversation/contracts.js";
import type { InteractionCoordinatePayload } from "../../queue/payloads.js";
import type { Database } from "../client.js";
import { interactionRuns } from "../schema-fragments/conversation-actors.js";
import { chains, executionTasks } from "../schema.js";

const identifierSchema = z.uuid();
const encryptedResultSchema = z
  .object({ ciphertext: z.string().min(1) })
  .strict();

const terminalTaskStates = new Set([
  "succeeded",
  "failed",
  "canceled",
  "needs_approval",
]);

export interface TaskResultReadinessRepositoryOptions {
  decrypt(ciphertext: string): Promise<string> | string;
}

export interface InteractionTaskReadinessSnapshot
  extends Omit<InteractionTaskSnapshot, "terminalResults"> {
  spaceId: string;
  sourceInteractionRunId: string;
  taskCount: number;
  resultReady: boolean;
  terminalResults: readonly ExecutionResult[];
}

/**
 * Read-only task completion projection for the conversation actor. It never
 * schedules synthesis: callers receive a snapshot and decide how the active
 * interaction should proceed.
 */
export class TaskResultReadinessRepository {
  public constructor(
    private readonly database: Database,
    private readonly options: TaskResultReadinessRepositoryOptions,
  ) {}

  public async loadTaskSnapshot(
    spaceId: string,
    sourceInteractionRunId: string,
  ): Promise<InteractionTaskReadinessSnapshot> {
    const parsedSpaceId = identifierSchema.parse(spaceId);
    const parsedRunId = identifierSchema.parse(sourceInteractionRunId);
    const rows = await this.database
      .select({
        taskId: executionTasks.id,
        state: executionTasks.state,
        resultJson: executionTasks.resultJson,
      })
      .from(chains)
      .innerJoin(executionTasks, eq(executionTasks.chainId, chains.id))
      .where(
        and(
          eq(chains.spaceId, parsedSpaceId),
          eq(chains.sourceInteractionRunId, parsedRunId),
        ),
      )
      .orderBy(asc(executionTasks.createdAt), asc(executionTasks.id));

    const terminalResults: ExecutionResult[] = [];
    let pendingCount = 0;
    for (const row of rows) {
      if (!terminalTaskStates.has(row.state)) {
        pendingCount += 1;
        continue;
      }
      const envelope = encryptedResultSchema.safeParse(row.resultJson);
      if (!envelope.success) {
        throw new Error(
          `Terminal task ${row.taskId} has no encrypted result. Repair the task result before waking the interaction actor.`,
        );
      }
      const plaintext = await this.options.decrypt(envelope.data.ciphertext);
      const result = executionResultSchema.parse(
        JSON.parse(plaintext) as unknown,
      );
      if (result.status !== row.state) {
        throw new Error(
          `Terminal task ${row.taskId} state/result mismatch. Repair the durable task before synthesis.`,
        );
      }
      // A revised row remains durable audit history, while only its replacement
      // participates in actor synthesis.
      if (result.error?.code !== "TASK_REVISED") {
        terminalResults.push(result);
      }
    }

    return {
      spaceId: parsedSpaceId,
      sourceInteractionRunId: parsedRunId,
      taskCount: rows.length,
      pendingCount,
      terminalResults,
      resultReady: rows.length > 0 && pendingCount === 0,
    };
  }

  public async loadCompletedTaskResults(
    spaceId: string,
    sourceInteractionRunId: string,
  ): Promise<readonly ExecutionResult[]> {
    return (
      await this.loadTaskSnapshot(spaceId, sourceInteractionRunId)
    ).terminalResults as readonly ExecutionResult[];
  }

  public async loadInteractionTaskSnapshot(
    sourceInteractionRunId: string,
  ): Promise<InteractionTaskSnapshot> {
    const parsedRunId = identifierSchema.parse(sourceInteractionRunId);
    const [run] = await this.database
      .select({ spaceId: interactionRuns.spaceId })
      .from(interactionRuns)
      .where(eq(interactionRuns.id, parsedRunId))
      .limit(1);
    if (run === undefined) {
      return { pendingCount: 0, terminalResults: [] };
    }
    const snapshot = await this.loadTaskSnapshot(run.spaceId, parsedRunId);
    return {
      pendingCount: snapshot.pendingCount,
      terminalResults: snapshot.terminalResults,
    };
  }

  public async findResultReadySignals(
    limit = 100,
  ): Promise<readonly InteractionCoordinatePayload[]> {
    const parsedLimit = z.number().int().positive().max(1_000).parse(limit);
    const rows = await this.database
      .select({
        spaceId: chains.spaceId,
        sourceInteractionRunId: chains.sourceInteractionRunId,
        taskState: executionTasks.state,
      })
      .from(chains)
      .innerJoin(executionTasks, eq(executionTasks.chainId, chains.id))
      .where(
        and(
          eq(chains.state, "executing"),
          isNotNull(chains.sourceInteractionRunId),
        ),
      )
      .orderBy(asc(chains.createdAt), asc(executionTasks.createdAt));

    const readiness = new Map<
      string,
      { spaceId: string; ready: boolean }
    >();
    for (const row of rows) {
      if (row.sourceInteractionRunId === null) {
        continue;
      }
      const key = `${row.spaceId}:${row.sourceInteractionRunId}`;
      const existing = readiness.get(key);
      readiness.set(key, {
        spaceId: row.spaceId,
        ready:
          (existing?.ready ?? true) && terminalTaskStates.has(row.taskState),
      });
    }

    const signalsBySpace = new Map<string, InteractionCoordinatePayload>();
    for (const candidate of readiness.values()) {
      if (candidate.ready && !signalsBySpace.has(candidate.spaceId)) {
        signalsBySpace.set(candidate.spaceId, {
          spaceId: candidate.spaceId,
          reason: "task_results_ready",
        });
      }
      if (signalsBySpace.size >= parsedLimit) {
        break;
      }
    }
    return [...signalsBySpace.values()];
  }
}

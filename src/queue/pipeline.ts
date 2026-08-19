import type {
  AcceptedInboundMessage,
  IngestResult,
} from "../db/repositories/inbound.js";
import type { ChainRepository } from "../db/repositories/chains.js";
import type { OutboundDeliveryRepository } from "../db/repositories/outbound-delivery.js";
import type { OrchestrationRepository } from "../db/repositories/orchestration.js";
import type { ConversationActorWakeRegistry } from "../conversation/coordinator.js";
import type { InteractionCoordinateReason } from "./payloads.js";
import type {
  InteractionCoordinatePublisher,
  QueuePublisher,
} from "./publisher.js";

export interface DurableInboundRepository {
  ingestAcceptedMessage(input: AcceptedInboundMessage): Promise<IngestResult>;
  findSpacesWithUndrainedInbound(limit?: number): Promise<string[]>;
}

export interface ConversationObservationRecovery {
  findSpacesWithUnfinalizedInput(input?: {
    limit?: number;
    afterSpaceId?: string;
  }): Promise<string[]>;
}

export interface ConversationObservationDependencies {
  actorRegistry: ConversationActorWakeRegistry;
  publisher: InteractionCoordinatePublisher;
  recovery: ConversationObservationRecovery;
  operationTimeoutMs?: number;
  onWakeFailure?: (input: {
    spaceId?: string;
    reason: InteractionCoordinateReason;
    trigger: "direct" | "durable" | "recovery_query";
    error: unknown;
  }) => void;
}

export interface DurableInboundPipelineDependencies {
  engine?: "legacy" | "observe" | "actor";
  inbound: DurableInboundRepository;
  chains: Pick<ChainRepository, "findQueuedChains"> &
    Partial<Pick<ChainRepository, "supersedeActiveChain">>;
  outbound: Pick<OutboundDeliveryRepository, "findRecoverableBatchIds">;
  orchestration?: Pick<
    OrchestrationRepository,
    | "requeueStaleRunningTasks"
    | "findRunnableTaskPayloads"
    | "findSynthesisPayloads"
  >;
  publisher: QueuePublisher;
  conversationObservation?: ConversationObservationDependencies;
  /** Legacy compatibility callback; normal inbound messages never invoke it. */
  onChainsSuperseded?: (chainIds: readonly string[]) => void;
  debounceMs: number;
  taskRuntimeMs?: number;
  now?: () => Date;
}

export interface ReconciliationResult {
  inboundFlushesScheduled: number;
  planJobsScheduled: number;
  staleTasksRecovered: number;
  taskJobsScheduled: number;
  synthesisJobsScheduled: number;
  outboundJobsScheduled: number;
}

export interface ConversationObservationReconciliationResult {
  spacesScanned: number;
  directWakesCompleted: number;
  durableWakesPublished: number;
}

export class DurablePipeline {
  public constructor(
    private readonly dependencies: DurableInboundPipelineDependencies,
  ) {
    const timeoutMs =
      dependencies.conversationObservation?.operationTimeoutMs ?? 2_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error(
        "Conversation observation operation timeout must be a positive integer.",
      );
    }
  }

  public async ingestAndSchedule(
    input: AcceptedInboundMessage,
  ): Promise<IngestResult> {
    // Commit accepted content before touching pg-boss. A queue outage may delay
    // work, but it cannot make an authorized inbound message disappear.
    const result = await this.dependencies.inbound.ingestAcceptedMessage(input);
    const engine =
      this.dependencies.engine ??
      (this.dependencies.conversationObservation === undefined
        ? "legacy"
        : "observe");
    if (engine === "observe") {
      void this.wakeConversation(input.spaceId, "inbound");
    } else if (engine === "actor") {
      // Invoke the direct wake first without awaiting the actor's whole run.
      // The durable wake is published only after the sequencing commit and is
      // best-effort: startup cursor reconciliation repairs this split later.
      this.startDirectWake(input.spaceId, "inbound");
      await this.publishDurableWake(input.spaceId, "inbound");
      return result;
    }

    try {
      await this.dependencies.publisher.scheduleInboundFlush(
        { spaceId: input.spaceId },
        this.dependencies.debounceMs,
      );
    } catch (error) {
      throw new Error(
        "Inbound message is durable but its flush job could not be scheduled. Run pipeline reconciliation after queue recovery.",
        { cause: error },
      );
    }

    return result;
  }

  public async reconcile(limit = 100): Promise<ReconciliationResult> {
    // Reconciliation recreates identifier-only jobs from authoritative rows
    // after a crash or a database-commit/queue-publish split failure.
    const spaceIds =
      this.engine() === "actor"
        ? []
        : await this.dependencies.inbound.findSpacesWithUndrainedInbound(limit);
    for (const spaceId of spaceIds) {
      await this.dependencies.publisher.scheduleInboundFlush(
        { spaceId },
        this.dependencies.debounceMs,
      );
    }

    const queuedChains = await this.dependencies.chains.findQueuedChains(limit);
    for (const chain of queuedChains) {
      await this.dependencies.publisher.enqueueTurnPlan({
        chainId: chain.chainId,
        expectedChainVersion: chain.version,
        expectedState: "queued",
      });
    }

    const now = this.dependencies.now?.() ?? new Date();
    const staleBefore = new Date(
      now.getTime() - (this.dependencies.taskRuntimeMs ?? 900_000),
    );
    const staleTasksRecovered =
      (await this.dependencies.orchestration?.requeueStaleRunningTasks(
        staleBefore,
        limit,
      )) ?? 0;
    const runnableTasks =
      (await this.dependencies.orchestration?.findRunnableTaskPayloads(limit)) ??
      [];
    for (const task of runnableTasks) {
      await this.dependencies.publisher.enqueueTaskExecute(task);
    }

    const syntheses =
      (await this.dependencies.orchestration?.findSynthesisPayloads(limit)) ?? [];
    for (const synthesis of syntheses) {
      await this.dependencies.publisher.enqueueTurnSynthesize(synthesis);
    }

    const batchIds = await this.dependencies.outbound.findRecoverableBatchIds({
      now,
      limit,
    });
    for (const outboundBatchId of batchIds) {
      await this.dependencies.publisher.enqueueOutboundCoordinate({
        outboundBatchId,
      });
    }

    if (this.engine() !== "legacy") {
      // Every optional database/queue operation has its own timeout and reports
      // degraded coordination without closing readiness.
      void this.reconcileConversationObservations(limit).catch((error: unknown) => {
        this.reportWakeFailure({
          reason: "recovery",
          trigger: "recovery_query",
          error,
        });
      });
    }

    return {
      inboundFlushesScheduled: spaceIds.length,
      planJobsScheduled: queuedChains.length,
      staleTasksRecovered,
      taskJobsScheduled: runnableTasks.length,
      synthesisJobsScheduled: syntheses.length,
      outboundJobsScheduled: batchIds.length,
    };
  }

  public async reconcileConversationObservations(
    limit = 100,
  ): Promise<ConversationObservationReconciliationResult> {
    const observation = this.dependencies.conversationObservation;
    const totals: ConversationObservationReconciliationResult = {
      spacesScanned: 0,
      directWakesCompleted: 0,
      durableWakesPublished: 0,
    };
    if (observation === undefined) {
      return totals;
    }

    const pageSize = Math.max(1, Math.min(limit, 1_000));
    let afterSpaceId: string | undefined;
    while (true) {
      const page = await this.runBounded(
        () =>
          observation.recovery.findSpacesWithUnfinalizedInput({
            limit: pageSize,
            ...(afterSpaceId === undefined ? {} : { afterSpaceId }),
          }),
        "conversation observation recovery query",
      );
      if (!page.ok) {
        this.reportWakeFailure({
          reason: "recovery",
          trigger: "recovery_query",
          error: page.error,
        });
        return totals;
      }
      const spaceIds = page.value;
      if (spaceIds.length === 0) {
        return totals;
      }
      // Keep passive recovery below the dedicated observer pool capacity. A
      // timed-out space settles before the scan advances to the next one.
      for (const spaceId of spaceIds) {
        const result = await this.wakeConversation(spaceId, "recovery");
        totals.spacesScanned += 1;
        totals.directWakesCompleted += result.direct ? 1 : 0;
        totals.durableWakesPublished += result.durable ? 1 : 0;
        if (!result.durable) {
          // Do not accumulate abandoned queue publications during an outage.
          // A duplicate delivery or the next process startup retries the scan.
          return totals;
        }
      }
      if (spaceIds.length < pageSize) {
        return totals;
      }
      afterSpaceId = spaceIds.at(-1);
    }
  }

  private async wakeConversation(
    spaceId: string,
    reason: InteractionCoordinateReason,
  ): Promise<{ direct: boolean; durable: boolean }> {
    const observation = this.dependencies.conversationObservation;
    if (observation === undefined) {
      return { direct: false, durable: false };
    }
    const direct = await this.runBounded(
      () => observation.actorRegistry.wake(spaceId, reason),
      "direct conversation wake",
    );
    if (!direct.ok) {
      this.reportWakeFailure({
        spaceId,
        reason,
        trigger: "direct",
        error: direct.error,
      });
    }
    const durable = await this.publishDurableWake(spaceId, reason);
    return { direct: direct.ok, durable };
  }

  private startDirectWake(
    spaceId: string,
    reason: InteractionCoordinateReason,
  ): void {
    const observation = this.dependencies.conversationObservation;
    if (observation === undefined) return;
    let wake: Promise<void>;
    try {
      wake = Promise.resolve(observation.actorRegistry.wake(spaceId, reason));
    } catch (error) {
      this.reportWakeFailure({ spaceId, reason, trigger: "direct", error });
      return;
    }
    void wake.catch((error: unknown) => {
      this.reportWakeFailure({ spaceId, reason, trigger: "direct", error });
    });
  }

  private async publishDurableWake(
    spaceId: string,
    reason: InteractionCoordinateReason,
  ): Promise<boolean> {
    const observation = this.dependencies.conversationObservation;
    if (observation === undefined) return false;
    const result = await this.runBounded(
      () =>
        observation.publisher.enqueueInteractionCoordinate({ spaceId, reason }),
      "durable conversation wake",
    );
    if (!result.ok) {
      this.reportWakeFailure({
        spaceId,
        reason,
        trigger: "durable",
        error: result.error,
      });
    }
    return result.ok;
  }

  private async runBounded<Result>(
    run: () => Promise<Result>,
    label: string,
  ): Promise<{ ok: true; value: Result } | { ok: false; error: unknown }> {
    const timeoutMs =
      this.dependencies.conversationObservation?.operationTimeoutMs ?? 2_000;
    let operation: Promise<Result>;
    try {
      operation = Promise.resolve(run());
    } catch (error) {
      return { ok: false, error };
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(
              new Error(
                `${label} exceeded ${timeoutMs}ms; passive observation will retry through reconciliation.`,
              ),
            );
          }, timeoutMs);
          timeout.unref?.();
        }),
      ]);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error };
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  private engine(): "legacy" | "observe" | "actor" {
    return (
      this.dependencies.engine ??
      (this.dependencies.conversationObservation === undefined
        ? "legacy"
        : "observe")
    );
  }

  private reportWakeFailure(input: {
    spaceId?: string;
    reason: InteractionCoordinateReason;
    trigger: "direct" | "durable" | "recovery_query";
    error: unknown;
  }): void {
    try {
      this.dependencies.conversationObservation?.onWakeFailure?.(input);
    } catch {
      // Observation diagnostics must not interrupt the legacy reply path.
    }
  }
}

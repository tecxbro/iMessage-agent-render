import { describe, expect, it, vi } from "vitest";

import { createInboundFlushHandler } from "../../src/queue/handlers/inbound-flush.js";
import { DurablePipeline } from "../../src/queue/pipeline.js";
import { PgBossPublisher } from "../../src/queue/publisher.js";

const spaceId = "00000000-0000-4000-8000-000000000101";
const chainId = "00000000-0000-4000-8000-000000000102";
const messageId = "00000000-0000-4000-8000-000000000103";
const batchId = "00000000-0000-4000-8000-000000000104";
const taskId = "00000000-0000-4000-8000-000000000106";

describe("durable receive, debounce, planning, and synthesis recovery", () => {
  it("interrupts superseded in-flight work before scheduling the replacement flush", async () => {
    const order: string[] = [];
    const onChainsSuperseded = vi.fn((chainIds: readonly string[]) => {
      order.push(`cancel:${chainIds.join(",")}`);
    });
    const pipeline = new DurablePipeline({
      inbound: {
        ingestAcceptedMessage: vi.fn(async () => ({
          inserted: true,
          messageId,
        })),
        findSpacesWithUndrainedInbound: vi.fn(async () => []),
      },
      chains: {
        supersedeActiveChain: vi.fn(async () => ({
          canceledChainIds: [chainId],
          carriedMessageIds: [],
        })),
        findQueuedChains: vi.fn(async () => []),
      },
      outbound: { findRecoverableBatchIds: vi.fn(async () => []) },
      publisher: {
        scheduleInboundFlush: vi.fn(async () => {
          order.push("schedule-replacement");
        }),
        enqueueTurnPlan: vi.fn(async () => undefined),
        enqueueTaskExecute: vi.fn(async () => undefined),
        enqueueTurnSynthesize: vi.fn(async () => undefined),
        enqueueOutboundCoordinate: vi.fn(async () => undefined),
        enqueueOutboundSend: vi.fn(async () => undefined),
        enqueueApprovalRequest: vi.fn(async () => undefined),
        enqueueApprovalExecute: vi.fn(async () => undefined),
        enqueueMemoryCurate: vi.fn(async () => undefined),
      },
      onChainsSuperseded,
      debounceMs: 4_000,
    });

    await pipeline.ingestAndSchedule({
      spaceId,
      externalMessageId: "provider-message-correction",
      senderIdentityId: "00000000-0000-4000-8000-000000000105",
      contentCiphertext: "encrypted",
      contentHash: "hash",
      receivedAt: new Date("2026-08-14T12:00:00.000Z"),
      retentionExpiresAt: new Date("2026-09-13T12:00:00.000Z"),
    });

    expect(onChainsSuperseded).toHaveBeenCalledWith([chainId]);
    expect(order).toEqual([`cancel:${chainId}`, "schedule-replacement"]);
  });

  it("interrupts chains superseded during reconciliation flush recovery", async () => {
    const onChainsSuperseded = vi.fn();
    const enqueueTurnPlan = vi.fn(async () => undefined);
    const handler = createInboundFlushHandler({
      chains: {
        flushInboundMessages: vi.fn(async () => ({
          chainId,
          version: 2,
          messageIds: [messageId],
          canceledChainIds: ["00000000-0000-4000-8000-000000000107"],
        })),
      },
      publisher: { enqueueTurnPlan },
      onChainsSuperseded,
    });

    await handler({ spaceId });

    expect(onChainsSuperseded).toHaveBeenCalledWith([
      "00000000-0000-4000-8000-000000000107",
    ]);
    expect(enqueueTurnPlan).toHaveBeenCalledWith({
      chainId,
      expectedChainVersion: 2,
      expectedState: "queued",
    });
  });

  it("recovers a receive crash after durable insert but before debounce scheduling", async () => {
    const scheduleInboundFlush = vi
      .fn()
      .mockRejectedValueOnce(new Error("simulated queue outage"))
      .mockResolvedValue(undefined);
    const pipeline = new DurablePipeline({
      inbound: {
        ingestAcceptedMessage: vi.fn(async () => ({
          inserted: true,
          messageId,
        })),
        findSpacesWithUndrainedInbound: vi.fn(async () => [spaceId]),
      },
      chains: {
        supersedeActiveChain: vi.fn(async () => ({
          canceledChainIds: [],
          carriedMessageIds: [],
        })),
        findQueuedChains: vi.fn(async () => []),
      },
      outbound: { findRecoverableBatchIds: vi.fn(async () => []) },
      publisher: {
        scheduleInboundFlush,
        enqueueTurnPlan: vi.fn(async () => undefined),
        enqueueTaskExecute: vi.fn(async () => undefined),
        enqueueTurnSynthesize: vi.fn(async () => undefined),
        enqueueOutboundCoordinate: vi.fn(async () => undefined),
        enqueueOutboundSend: vi.fn(async () => undefined),
        enqueueApprovalRequest: vi.fn(async () => undefined),
        enqueueApprovalExecute: vi.fn(async () => undefined),
        enqueueMemoryCurate: vi.fn(async () => undefined),
      },
      debounceMs: 4_000,
    });

    await expect(
      pipeline.ingestAndSchedule({
        spaceId,
        externalMessageId: "provider-message-1",
        senderIdentityId: "00000000-0000-4000-8000-000000000105",
        contentCiphertext: "encrypted",
        contentHash: "hash",
        receivedAt: new Date("2026-08-14T12:00:00.000Z"),
        retentionExpiresAt: new Date("2026-09-13T12:00:00.000Z"),
      }),
    ).rejects.toThrow(/message is durable/);

    await expect(pipeline.reconcile()).resolves.toEqual({
      inboundFlushesScheduled: 1,
      planJobsScheduled: 0,
      staleTasksRecovered: 0,
      taskJobsScheduled: 0,
      synthesisJobsScheduled: 0,
      outboundJobsScheduled: 0,
    });
    expect(scheduleInboundFlush).toHaveBeenNthCalledWith(2, { spaceId }, 4_000);
  });

  it("starts the direct observation wake before durable publication settles", async () => {
    let releaseDurable!: () => void;
    const durableSettled = new Promise<void>((resolve) => {
      releaseDurable = resolve;
    });
    const events: string[] = [];
    let ingestionSettled = false;
    const pipeline = new DurablePipeline({
      inbound: {
        ingestAcceptedMessage: vi.fn(async () => {
          events.push("sequenced-commit");
          return { inserted: true, messageId };
        }),
        findSpacesWithUndrainedInbound: vi.fn(async () => []),
      },
      chains: {
        supersedeActiveChain: vi.fn(async () => ({
          canceledChainIds: [],
          carriedMessageIds: [],
        })),
        findQueuedChains: vi.fn(async () => []),
      },
      outbound: { findRecoverableBatchIds: vi.fn(async () => []) },
      publisher: {
        scheduleInboundFlush: vi.fn(async () => {
          events.push("legacy-flush-scheduled");
        }),
        enqueueTurnPlan: vi.fn(async () => undefined),
        enqueueTaskExecute: vi.fn(async () => undefined),
        enqueueTurnSynthesize: vi.fn(async () => undefined),
        enqueueOutboundCoordinate: vi.fn(async () => undefined),
        enqueueOutboundSend: vi.fn(async () => undefined),
        enqueueApprovalRequest: vi.fn(async () => undefined),
        enqueueApprovalExecute: vi.fn(async () => undefined),
        enqueueMemoryCurate: vi.fn(async () => undefined),
      },
      conversationObservation: {
        actorRegistry: {
          wake: vi.fn(async () => {
            events.push("direct-wake");
          }),
        },
        publisher: {
          enqueueInteractionCoordinate: vi.fn(async () => {
            events.push("durable-wake-started");
            await durableSettled;
          }),
        },
        recovery: {
          findSpacesWithUnfinalizedInput: vi.fn(async () => []),
        },
      },
      debounceMs: 4_000,
    });

    const ingestion = pipeline
      .ingestAndSchedule({
        spaceId,
        externalMessageId: "provider-observe-latency",
        senderIdentityId: "00000000-0000-4000-8000-000000000105",
        contentCiphertext: "encrypted",
        contentHash: "hash",
        receivedAt: new Date("2026-08-14T12:00:00.000Z"),
        retentionExpiresAt: new Date("2026-09-13T12:00:00.000Z"),
      })
      .finally(() => {
        ingestionSettled = true;
      });

    await vi.waitFor(() => {
      expect(events).toContain("legacy-flush-scheduled");
    });
    expect(events).toEqual([
      "sequenced-commit",
      "direct-wake",
      "durable-wake-started",
      "legacy-flush-scheduled",
    ]);
    await ingestion;
    expect(ingestionSettled).toBe(true);

    releaseDurable();
  });

  it("paginates startup observation recovery and emits both wake paths", async () => {
    const space2 = "00000000-0000-4000-8000-000000000108";
    const space3 = "00000000-0000-4000-8000-000000000109";
    const directWake = vi.fn(async () => undefined);
    const durableWake = vi.fn(async () => undefined);
    const findSpacesWithUnfinalizedInput = vi
      .fn()
      .mockResolvedValueOnce([spaceId, space2])
      .mockResolvedValueOnce([space3]);
    const pipeline = new DurablePipeline({
      inbound: {
        ingestAcceptedMessage: vi.fn(),
        findSpacesWithUndrainedInbound: vi.fn(async () => []),
      },
      chains: {
        supersedeActiveChain: vi.fn(),
        findQueuedChains: vi.fn(async () => []),
      },
      outbound: { findRecoverableBatchIds: vi.fn(async () => []) },
      publisher: {
        scheduleInboundFlush: vi.fn(async () => undefined),
        enqueueTurnPlan: vi.fn(async () => undefined),
        enqueueTaskExecute: vi.fn(async () => undefined),
        enqueueTurnSynthesize: vi.fn(async () => undefined),
        enqueueOutboundCoordinate: vi.fn(async () => undefined),
        enqueueOutboundSend: vi.fn(async () => undefined),
        enqueueApprovalRequest: vi.fn(async () => undefined),
        enqueueApprovalExecute: vi.fn(async () => undefined),
        enqueueMemoryCurate: vi.fn(async () => undefined),
      },
      conversationObservation: {
        actorRegistry: { wake: directWake },
        publisher: { enqueueInteractionCoordinate: durableWake },
        recovery: { findSpacesWithUnfinalizedInput },
      },
      debounceMs: 4_000,
    });

    await expect(pipeline.reconcile(2)).resolves.toMatchObject({
      inboundFlushesScheduled: 0,
    });
    await vi.waitFor(() => {
      expect(durableWake).toHaveBeenCalledTimes(3);
    });
    expect(findSpacesWithUnfinalizedInput).toHaveBeenNthCalledWith(1, {
      limit: 2,
    });
    expect(findSpacesWithUnfinalizedInput).toHaveBeenNthCalledWith(2, {
      limit: 2,
      afterSpaceId: space2,
    });
    for (const recoveredSpaceId of [spaceId, space2, space3]) {
      expect(directWake).toHaveBeenCalledWith(recoveredSpaceId, "recovery");
      expect(durableWake).toHaveBeenCalledWith({
        spaceId: recoveredSpaceId,
        reason: "recovery",
      });
    }
  });

  it("keeps the legacy reply schedule authoritative when observation wakes fail", async () => {
    const scheduleInboundFlush = vi.fn(async () => undefined);
    const onWakeFailure = vi.fn(() => {
      throw new Error("diagnostic sink unavailable");
    });
    const pipeline = new DurablePipeline({
      inbound: {
        ingestAcceptedMessage: vi.fn(async () => ({
          inserted: true,
          messageId,
        })),
        findSpacesWithUndrainedInbound: vi.fn(async () => []),
      },
      chains: {
        supersedeActiveChain: vi.fn(async () => ({
          canceledChainIds: [],
          carriedMessageIds: [],
        })),
        findQueuedChains: vi.fn(async () => []),
      },
      outbound: { findRecoverableBatchIds: vi.fn(async () => []) },
      publisher: {
        scheduleInboundFlush,
        enqueueTurnPlan: vi.fn(async () => undefined),
        enqueueTaskExecute: vi.fn(async () => undefined),
        enqueueTurnSynthesize: vi.fn(async () => undefined),
        enqueueOutboundCoordinate: vi.fn(async () => undefined),
        enqueueOutboundSend: vi.fn(async () => undefined),
        enqueueApprovalRequest: vi.fn(async () => undefined),
        enqueueApprovalExecute: vi.fn(async () => undefined),
        enqueueMemoryCurate: vi.fn(async () => undefined),
      },
      conversationObservation: {
        actorRegistry: {
          wake: vi.fn(async () => {
            throw new Error("direct observer unavailable");
          }),
        },
        publisher: {
          enqueueInteractionCoordinate: vi.fn(async () => {
            throw new Error("coordinate queue unavailable");
          }),
        },
        recovery: {
          findSpacesWithUnfinalizedInput: vi.fn(async () => []),
        },
        onWakeFailure,
      },
      debounceMs: 4_000,
    });

    await expect(
      pipeline.ingestAndSchedule({
        spaceId,
        externalMessageId: "provider-observe-failure",
        senderIdentityId: "00000000-0000-4000-8000-000000000105",
        contentCiphertext: "encrypted",
        contentHash: "hash",
        receivedAt: new Date("2026-08-14T12:00:00.000Z"),
        retentionExpiresAt: new Date("2026-09-13T12:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ inserted: true, messageId });
    expect(scheduleInboundFlush).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(onWakeFailure).toHaveBeenCalledTimes(2);
    });
  });

  it("bounds a stalled startup observation scan without blocking legacy recovery", async () => {
    const onWakeFailure = vi.fn();
    const pipeline = new DurablePipeline({
      inbound: {
        ingestAcceptedMessage: vi.fn(),
        findSpacesWithUndrainedInbound: vi.fn(async () => []),
      },
      chains: {
        supersedeActiveChain: vi.fn(),
        findQueuedChains: vi.fn(async () => []),
      },
      outbound: { findRecoverableBatchIds: vi.fn(async () => []) },
      publisher: {
        scheduleInboundFlush: vi.fn(async () => undefined),
        enqueueTurnPlan: vi.fn(async () => undefined),
        enqueueTaskExecute: vi.fn(async () => undefined),
        enqueueTurnSynthesize: vi.fn(async () => undefined),
        enqueueOutboundCoordinate: vi.fn(async () => undefined),
        enqueueOutboundSend: vi.fn(async () => undefined),
        enqueueApprovalRequest: vi.fn(async () => undefined),
        enqueueApprovalExecute: vi.fn(async () => undefined),
        enqueueMemoryCurate: vi.fn(async () => undefined),
      },
      conversationObservation: {
        actorRegistry: { wake: vi.fn(async () => undefined) },
        publisher: { enqueueInteractionCoordinate: vi.fn(async () => undefined) },
        recovery: {
          findSpacesWithUnfinalizedInput: vi.fn(
            async () => await new Promise<string[]>(() => undefined),
          ),
        },
        operationTimeoutMs: 10,
        onWakeFailure,
      },
      debounceMs: 4_000,
    });

    await expect(pipeline.reconcile()).resolves.toMatchObject({
      inboundFlushesScheduled: 0,
    });
    await vi.waitFor(() => {
      expect(onWakeFailure).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: "recovery_query" }),
      );
    });
  });

  it("stops startup scanning after the first durable publication failure", async () => {
    const space2 = "00000000-0000-4000-8000-000000000108";
    const durableWake = vi.fn(async () => {
      throw new Error("coordinate queue unavailable");
    });
    const directWake = vi.fn(async () => undefined);
    const pipeline = new DurablePipeline({
      inbound: {
        ingestAcceptedMessage: vi.fn(),
        findSpacesWithUndrainedInbound: vi.fn(async () => []),
      },
      chains: {
        supersedeActiveChain: vi.fn(),
        findQueuedChains: vi.fn(async () => []),
      },
      outbound: { findRecoverableBatchIds: vi.fn(async () => []) },
      publisher: {
        scheduleInboundFlush: vi.fn(async () => undefined),
        enqueueTurnPlan: vi.fn(async () => undefined),
        enqueueTaskExecute: vi.fn(async () => undefined),
        enqueueTurnSynthesize: vi.fn(async () => undefined),
        enqueueOutboundCoordinate: vi.fn(async () => undefined),
        enqueueOutboundSend: vi.fn(async () => undefined),
        enqueueApprovalRequest: vi.fn(async () => undefined),
        enqueueApprovalExecute: vi.fn(async () => undefined),
        enqueueMemoryCurate: vi.fn(async () => undefined),
      },
      conversationObservation: {
        actorRegistry: { wake: directWake },
        publisher: { enqueueInteractionCoordinate: durableWake },
        recovery: {
          findSpacesWithUnfinalizedInput: vi.fn(async () => [spaceId, space2]),
        },
      },
      debounceMs: 4_000,
    });

    await expect(pipeline.reconcileConversationObservations(2)).resolves.toEqual({
      spacesScanned: 1,
      directWakesCompleted: 1,
      durableWakesPublished: 0,
    });
    expect(directWake).toHaveBeenCalledTimes(1);
    expect(durableWake).toHaveBeenCalledTimes(1);
  });

  it("re-publishes observation wakes for duplicate provider delivery", async () => {
    const durableWake = vi.fn(async () => undefined);
    const pipeline = new DurablePipeline({
      inbound: {
        ingestAcceptedMessage: vi.fn(async () => ({
          inserted: false,
          messageId,
        })),
        findSpacesWithUndrainedInbound: vi.fn(async () => []),
      },
      chains: {
        supersedeActiveChain: vi.fn(),
        findQueuedChains: vi.fn(async () => []),
      },
      outbound: { findRecoverableBatchIds: vi.fn(async () => []) },
      publisher: {
        scheduleInboundFlush: vi.fn(async () => undefined),
        enqueueTurnPlan: vi.fn(async () => undefined),
        enqueueTaskExecute: vi.fn(async () => undefined),
        enqueueTurnSynthesize: vi.fn(async () => undefined),
        enqueueOutboundCoordinate: vi.fn(async () => undefined),
        enqueueOutboundSend: vi.fn(async () => undefined),
        enqueueApprovalRequest: vi.fn(async () => undefined),
        enqueueApprovalExecute: vi.fn(async () => undefined),
        enqueueMemoryCurate: vi.fn(async () => undefined),
      },
      conversationObservation: {
        actorRegistry: { wake: vi.fn(async () => undefined) },
        publisher: { enqueueInteractionCoordinate: durableWake },
        recovery: { findSpacesWithUnfinalizedInput: vi.fn(async () => []) },
      },
      debounceMs: 4_000,
    });

    await pipeline.ingestAndSchedule({
      spaceId,
      externalMessageId: "provider-observe-duplicate",
      senderIdentityId: "00000000-0000-4000-8000-000000000105",
      contentCiphertext: "encrypted",
      contentHash: "hash",
      receivedAt: new Date("2026-08-14T12:00:00.000Z"),
      retentionExpiresAt: new Date("2026-09-13T12:00:00.000Z"),
    });

    await vi.waitFor(() => {
      expect(durableWake).toHaveBeenCalledWith({ spaceId, reason: "inbound" });
    });
  });

  it("recovers materialized legacy batches through outbound.coordinate", async () => {
    const enqueueOutboundCoordinate = vi.fn(async () => undefined);
    const enqueueOutboundSend = vi.fn(async () => undefined);
    const pipeline = new DurablePipeline({
      inbound: {
        ingestAcceptedMessage: vi.fn(),
        findSpacesWithUndrainedInbound: vi.fn(async () => []),
      },
      chains: {
        supersedeActiveChain: vi.fn(),
        findQueuedChains: vi.fn(async () => []),
      },
      outbound: {
        findRecoverableBatchIds: vi.fn(async () => [batchId]),
      },
      publisher: {
        scheduleInboundFlush: vi.fn(async () => undefined),
        enqueueTurnPlan: vi.fn(async () => undefined),
        enqueueTaskExecute: vi.fn(async () => undefined),
        enqueueTurnSynthesize: vi.fn(async () => undefined),
        enqueueOutboundCoordinate,
        enqueueOutboundSend,
        enqueueApprovalRequest: vi.fn(async () => undefined),
        enqueueApprovalExecute: vi.fn(async () => undefined),
        enqueueMemoryCurate: vi.fn(async () => undefined),
      },
      debounceMs: 4_000,
    });

    await expect(pipeline.reconcile()).resolves.toMatchObject({
      outboundJobsScheduled: 1,
    });
    expect(enqueueOutboundCoordinate).toHaveBeenCalledWith({
      outboundBatchId: batchId,
    });
    expect(enqueueOutboundSend).not.toHaveBeenCalled();
  });

  it("uses stable singleton keys when debounce, planning, synthesis, and send enqueue retry", async () => {
    const upsertSingletonKeys: string[] = [];
    const sendSingletonKeys: string[] = [];
    const upsert = vi.fn(async (...arguments_: unknown[]) => {
      upsertSingletonKeys.push(
        (arguments_[2] as { singletonKey: string }).singletonKey,
      );
    });
    let sendAttempt = 0;
    const send = vi.fn(async (...arguments_: unknown[]) => {
      sendSingletonKeys.push(
        (arguments_[2] as { singletonKey: string }).singletonKey,
      );
      sendAttempt += 1;
      if (sendAttempt === 1) {
        throw new Error("simulated plan enqueue timeout");
      }
    });
    const now = new Date("2026-08-14T12:00:00.000Z");
    const publisher = new PgBossPublisher(
      { upsert, send } as never,
      () => now,
    );

    await publisher.scheduleInboundFlush({ spaceId }, 4_000);
    await publisher.scheduleInboundFlush({ spaceId }, 4_000);
    expect(upsertSingletonKeys).toEqual([
      `space:${spaceId}`,
      `space:${spaceId}`,
    ]);

    const plan = {
      chainId,
      expectedChainVersion: 1,
      expectedState: "queued" as const,
    };
    await expect(publisher.enqueueTurnPlan(plan)).rejects.toThrow(
      "simulated plan enqueue timeout",
    );
    await publisher.enqueueTurnPlan(plan);
    await publisher.enqueueTaskExecute({
      taskId,
      chainId,
      expectedChainVersion: 1,
      expectedState: "queued",
    });
    await publisher.enqueueTurnSynthesize({
      chainId,
      expectedChainVersion: 1,
      expectedState: "executing",
    });
    await publisher.enqueueOutboundCoordinate({
      outboundBatchId: batchId,
    });

    expect(sendSingletonKeys).toEqual([
      `chain:${chainId}:plan`,
      `chain:${chainId}:plan`,
      `task:${taskId}`,
      `chain:${chainId}:synthesize`,
      `outbound:${batchId}`,
    ]);
  });
});

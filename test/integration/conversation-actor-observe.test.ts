import { describe, expect, it, vi } from "vitest";

import { ActorRegistry } from "../../src/conversation/actor-registry.js";
import {
  ConversationObservationMetrics,
  ObserveConversationActor,
} from "../../src/conversation/observe-actor.js";
import type { ConversationSnapshot } from "../../src/conversation/contracts.js";
import type { PostgresConversationRepository } from "../../src/db/repositories/conversation-recovery.js";
import { ConversationSequencedInboundAdapter } from "../../src/db/repositories/inbound.js";
import { createInboundFlushHandler } from "../../src/queue/handlers/inbound-flush.js";
import { createInteractionCoordinateHandler } from "../../src/queue/handlers/interaction-coordinate.js";
import type { InteractionCoordinatePayload } from "../../src/queue/payloads.js";
import { DurablePipeline } from "../../src/queue/pipeline.js";

const ids = {
  space: "52000000-0000-4000-8000-000000000001",
  message: "52000000-0000-4000-8000-000000000002",
  sender: "52000000-0000-4000-8000-000000000003",
  chain: "52000000-0000-4000-8000-000000000004",
} as const;

describe("conversation actor observe integration", () => {
  it("dual-triggers observation while legacy produces the only model call and output", async () => {
    const observedAt = new Date("2026-08-19T04:00:00.000Z");
    const state: ConversationSnapshot = {
      state: {
        spaceId: ids.space,
        latestInputSequence: 0,
        acceptedThroughSequence: 0,
        finalizedThroughSequence: 0,
        actorGeneration: 0,
        activeInteractionRunId: null,
        state: "idle",
        updatedAt: observedAt,
      },
      activeRun: null,
    };
    const ingestObservedInput = vi.fn(
      async (
        input: Parameters<PostgresConversationRepository["ingestObservedInput"]>[0],
      ) => {
        state.state.latestInputSequence += 1;
        return {
          status: "inserted" as const,
          input: {
            messageId: input.messageId,
            spaceId: ids.space,
            inputSequence: state.state.latestInputSequence,
            actorGeneration: state.state.actorGeneration,
          },
        };
      },
    );
    const adapter = new ConversationSequencedInboundAdapter(
      { findSpacesWithUndrainedInbound: vi.fn(async () => []) },
      { ingestObservedInput },
    );
    const loadConversation = vi.fn(async () => structuredClone(state));
    const metrics = new ConversationObservationMetrics();
    const registry = new ActorRegistry({
      idleTtlMs: 60_000,
      createActor: (spaceId) =>
        new ObserveConversationActor({
          spaceId,
          repository: { loadConversation },
          metrics,
          now: () => observedAt,
        }),
    });
    const durableWakes: InteractionCoordinatePayload[] = [];
    const scheduleInboundFlush = vi.fn(async () => undefined);
    const legacyModel = vi.fn(async () => {
      await legacyOutput("legacy reply");
    });
    const legacyOutput = vi.fn(async (_text: string) => undefined);
    const pipeline = new DurablePipeline({
      inbound: adapter,
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
        actorRegistry: registry,
        publisher: {
          enqueueInteractionCoordinate: async (payload) => {
            durableWakes.push(payload);
          },
        },
        recovery: {
          findSpacesWithUnfinalizedInput: vi.fn(async () => []),
        },
      },
      debounceMs: 4_000,
    });

    await pipeline.ingestAndSchedule({
      id: ids.message,
      spaceId: ids.space,
      externalMessageId: "provider-observe-1",
      senderIdentityId: ids.sender,
      contentCiphertext: "cipher:owner input",
      contentHash: "hash:owner-input",
      receivedAt: observedAt,
      retentionExpiresAt: new Date("2026-09-19T04:00:00.000Z"),
    });

    expect(ingestObservedInput).toHaveBeenCalledOnce();
    expect(scheduleInboundFlush).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(durableWakes).toEqual([
        { spaceId: ids.space, reason: "inbound" },
      ]);
      expect(metrics.get(ids.space)).toMatchObject({
        observedThroughSequence: 1,
        legacyFinalizedThroughSequence: 0,
        observationCount: 1,
      });
    });

    const queuedHandler = createInteractionCoordinateHandler(registry);
    await queuedHandler(durableWakes[0]!);

    const legacyFlush = createInboundFlushHandler({
      chains: {
        flushInboundMessages: vi.fn(async () => ({
          chainId: ids.chain,
          version: 1,
          messageIds: [ids.message],
          canceledChainIds: [],
        })),
      },
      publisher: {
        enqueueTurnPlan: async () => legacyModel(),
      },
      now: () => observedAt,
    });
    await legacyFlush({ spaceId: ids.space });

    expect(legacyModel).toHaveBeenCalledOnce();
    expect(legacyOutput).toHaveBeenCalledOnce();
    expect(metrics.get(ids.space)).toMatchObject({
      observedThroughSequence: 1,
      legacyFinalizedThroughSequence: 0,
      observationCount: 1,
    });
    expect(state.state).toMatchObject({
      latestInputSequence: 1,
      acceptedThroughSequence: 0,
      finalizedThroughSequence: 0,
      actorGeneration: 0,
      activeInteractionRunId: null,
      state: "idle",
    });

    await registry.dispose();
    expect(registry.actorCount).toBe(0);
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  ConversationObservationMetrics,
  ObserveConversationActor,
} from "../../src/conversation/observe-actor.js";
import type { ConversationSnapshot } from "../../src/conversation/contracts.js";

const spaceId = "41000000-0000-4000-8000-000000000001";
const observedAt = new Date("2026-08-19T03:00:00.000Z");

function snapshot(input: {
  latest: number;
  finalized: number;
  generation?: number;
}): ConversationSnapshot {
  return {
    state: {
      spaceId,
      latestInputSequence: input.latest,
      acceptedThroughSequence: input.finalized,
      finalizedThroughSequence: input.finalized,
      actorGeneration: input.generation ?? 0,
      activeInteractionRunId: null,
      state: "idle",
      updatedAt: observedAt,
    },
    activeRun: null,
  };
}

describe("observe conversation actor", () => {
  it("coalesces duplicate wakes and records a separate observed cursor", async () => {
    const repository = {
      loadConversation: vi.fn(async () => snapshot({ latest: 3, finalized: 1 })),
    };
    const metrics = new ConversationObservationMetrics();
    const actor = new ObserveConversationActor({
      spaceId,
      repository,
      metrics,
      now: () => observedAt,
    });

    await Promise.all(
      Array.from({ length: 10 }, async () => actor.wake("inbound")),
    );

    expect(repository.loadConversation).toHaveBeenCalledTimes(1);
    expect(metrics.get(spaceId)).toEqual({
      spaceId,
      observedThroughSequence: 3,
      legacyFinalizedThroughSequence: 1,
      actorGeneration: 0,
      actorState: "idle",
      reasons: ["inbound"],
      observationCount: 1,
      observedAt,
    });
  });

  it("deduplicates replayed cursor observations and advances on new input", async () => {
    const snapshots = [
      snapshot({ latest: 2, finalized: 0 }),
      snapshot({ latest: 2, finalized: 0 }),
      snapshot({ latest: 4, finalized: 0 }),
    ];
    const repository = {
      loadConversation: vi.fn(async () => snapshots.shift() ?? null),
    };
    const metrics = new ConversationObservationMetrics();
    const actor = new ObserveConversationActor({
      spaceId,
      repository,
      metrics,
      now: () => observedAt,
    });

    await actor.wake("inbound");
    await actor.wake("recovery");
    await actor.wake("late_input");

    expect(metrics.get(spaceId)).toMatchObject({
      observedThroughSequence: 4,
      legacyFinalizedThroughSequence: 0,
      reasons: ["inbound", "late_input", "recovery"],
      observationCount: 2,
    });
  });

  it("records nothing for missing state and rejects wakes after disposal", async () => {
    const metrics = new ConversationObservationMetrics();
    const actor = new ObserveConversationActor({
      spaceId,
      repository: { loadConversation: async () => null },
      metrics,
    });

    await actor.wake("recovery");
    expect(metrics.snapshot()).toEqual([]);

    actor.dispose();
    await expect(actor.wake("inbound")).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("aborts an in-flight snapshot read during disposal", async () => {
    let loadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      loadStarted = resolve;
    });
    const actor = new ObserveConversationActor({
      spaceId,
      repository: {
        loadConversation: async () => {
          loadStarted();
          return await new Promise<ConversationSnapshot | null>(() => undefined);
        },
      },
      metrics: new ConversationObservationMetrics(),
      readTimeoutMs: 10_000,
    });

    const wake = actor.wake("recovery");
    await started;
    actor.dispose();

    await expect(wake).rejects.toMatchObject({ name: "AbortError" });
  });

  it("bounds retained cursor metrics and exports each observation", () => {
    const records: string[] = [];
    const metrics = new ConversationObservationMetrics({
      maximumTrackedSpaces: 1,
      onRecord: (observation) => records.push(observation.spaceId),
    });
    metrics.record({
      snapshot: snapshot({ latest: 1, finalized: 0 }),
      reasons: new Set(["inbound"]),
      observedAt,
    });
    const anotherSpaceId = "41000000-0000-4000-8000-000000000002";
    const second = snapshot({ latest: 2, finalized: 1 });
    second.state.spaceId = anotherSpaceId;
    metrics.record({
      snapshot: second,
      reasons: new Set(["recovery"]),
      observedAt,
    });

    expect(metrics.get(spaceId)).toBeUndefined();
    expect(metrics.snapshot()).toHaveLength(1);
    expect(records).toEqual([spaceId, anotherSpaceId]);
  });

  it("aborts the repository signal when a snapshot read times out", async () => {
    let observedSignal: AbortSignal | undefined;
    const actor = new ObserveConversationActor({
      spaceId,
      repository: {
        loadConversation: async (_spaceId, signal) => {
          observedSignal = signal;
          return await new Promise<ConversationSnapshot | null>(() => undefined);
        },
      },
      metrics: new ConversationObservationMetrics(),
      readTimeoutMs: 10,
    });

    await expect(actor.wake("recovery")).rejects.toThrow(
      /snapshot read exceeded/u,
    );
    expect(observedSignal?.aborted).toBe(true);
  });
});

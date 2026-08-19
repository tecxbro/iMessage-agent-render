import { describe, expect, it, vi } from "vitest";

import { ActorRegistry } from "../../src/conversation/actor-registry.js";
import {
  ConversationObservationMetrics,
  ObserveConversationActor,
} from "../../src/conversation/observe-actor.js";
import { stopQueueAndActorRegistry } from "../../src/runtime/observe-queue-lifecycle.js";

describe("observe queue lifecycle", () => {
  it("disposes an in-flight observer when queue shutdown fails", async () => {
    let loadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      loadStarted = resolve;
    });
    const registry = new ActorRegistry({
      createActor: (spaceId) =>
        new ObserveConversationActor({
          spaceId,
          repository: {
            loadConversation: async () => {
              loadStarted();
              return await new Promise<null>(() => undefined);
            },
          },
          metrics: new ConversationObservationMetrics(),
          readTimeoutMs: 10_000,
        }),
    });
    const wake = registry.wake(
      "53000000-0000-4000-8000-000000000001",
      "recovery",
    );
    await started;
    const stopFailure = new Error("queue shutdown failed");
    const stop = vi.fn(async () => {
      throw stopFailure;
    });

    await expect(
      stopQueueAndActorRegistry({ stop }, registry),
    ).rejects.toBe(stopFailure);
    await expect(wake).rejects.toMatchObject({ name: "AbortError" });
    expect(registry.actorCount).toBe(0);
  });

  it("starts registry disposal even while queue shutdown is pending", async () => {
    let finishQueueStop!: () => void;
    const queueStopped = new Promise<void>((resolve) => {
      finishQueueStop = resolve;
    });
    const dispose = vi.fn(async () => undefined);

    const shutdown = stopQueueAndActorRegistry(
      { stop: async () => await queueStopped },
      { dispose },
    );
    await vi.waitFor(() => {
      expect(dispose).toHaveBeenCalledOnce();
    });

    finishQueueStop();
    await shutdown;
  });
});

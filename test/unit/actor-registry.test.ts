import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ActorRegistry,
  type ConversationActorHandle,
  type ConversationActorWakeReason,
} from "../../src/conversation/actor-registry.js";
import { CoalescingMailbox } from "../../src/conversation/coalescing-mailbox.js";
import { InteractionSemaphore } from "../../src/conversation/interaction-semaphore.js";

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve: ((value: Value) => void) | undefined;
  let reject: ((reason: unknown) => void) | undefined;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve: (value) => resolve?.(value),
    reject: (reason) => reject?.(reason),
  };
}

function createMailboxActor(input: {
  batches: ConversationActorWakeReason[][];
  pause?: Promise<void>;
}): ConversationActorHandle {
  const mailbox = new CoalescingMailbox<ConversationActorWakeReason>();
  let activeDrain: Promise<void> | undefined;

  return {
    wake(reason) {
      mailbox.wake(reason);
      if (activeDrain !== undefined) {
        return activeDrain;
      }
      activeDrain = Promise.resolve()
        .then(async () => {
          do {
            input.batches.push([...mailbox.drain()]);
            await input.pause;
          } while (mailbox.hasPending);
        })
        .finally(() => {
          activeDrain = undefined;
        });
      return activeDrain;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("coalescing mailbox", () => {
  it("coalesces duplicate values while preserving a wake version", async () => {
    const mailbox = new CoalescingMailbox<string>();
    const initialVersion = mailbox.version;
    const changed = mailbox.waitForChange(initialVersion);

    mailbox.wake("inbound");
    mailbox.wake("inbound");
    mailbox.wake("recovery");

    expect(await changed).toBe(1);
    expect(mailbox.version).toBe(3);
    expect(mailbox.hasPending).toBe(true);
    expect([...mailbox.drain()]).toEqual(["inbound", "recovery"]);
    expect(mailbox.hasPending).toBe(false);
    await expect(mailbox.waitForChange(initialVersion)).resolves.toBe(3);
  });

  it("removes an aborted change waiter without consuming a later wake", async () => {
    const mailbox = new CoalescingMailbox<string>();
    const controller = new AbortController();
    const reason = new Error("actor stopped");
    const waiting = mailbox.waitForChange(mailbox.version, controller.signal);

    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);

    mailbox.wake("late_input");
    expect([...mailbox.drain()]).toEqual(["late_input"]);
  });
});

describe("actor registry", () => {
  it("keeps one actor per space while ten duplicate wakes share one drain", async () => {
    const batches: ConversationActorWakeReason[][] = [];
    let created = 0;
    const registry = new ActorRegistry({
      idleTtlMs: 60_000,
      createActor: () => {
        created += 1;
        return createMailboxActor({ batches });
      },
    });

    await Promise.all(
      Array.from({ length: 10 }, async () => registry.wake("space-a", "inbound")),
    );

    expect(created).toBe(1);
    expect(registry.actorCount).toBe(1);
    expect(batches).toEqual([["inbound"]]);
    await registry.dispose();
  });

  it("identity-removes a failed actor so the next wake creates a fresh one", async () => {
    const failure = new Error("actor crashed");
    let created = 0;
    let disposed = 0;
    const registry = new ActorRegistry({
      createActor: () => {
        created += 1;
        const actorNumber = created;
        return {
          wake: async () => {
            if (actorNumber === 1) {
              throw failure;
            }
          },
          dispose: () => {
            disposed += 1;
          },
        };
      },
    });

    await expect(registry.wake("space-a", "inbound")).rejects.toBe(failure);
    expect(registry.actorCount).toBe(0);
    await registry.wake("space-a", "recovery");

    expect(created).toBe(2);
    expect(disposed).toBe(1);
    expect(registry.actorCount).toBe(1);
    await registry.dispose();
  });

  it("does not let a late failure from an old actor remove its replacement", async () => {
    const firstFailure = deferred<void>();
    const lateFailure = deferred<void>();
    let created = 0;
    let oldWakeCount = 0;
    const registry = new ActorRegistry({
      createActor: () => {
        created += 1;
        if (created > 1) {
          return { wake: async () => undefined };
        }
        return {
          wake: () => {
            oldWakeCount += 1;
            return oldWakeCount === 1
              ? firstFailure.promise
              : lateFailure.promise;
          },
        };
      },
    });

    const first = registry.wake("space-a", "inbound");
    const late = registry.wake("space-a", "late_input");
    firstFailure.reject(new Error("first failure"));
    await expect(first).rejects.toThrow("first failure");

    const replacement = registry.wake("space-a", "recovery");
    await Promise.resolve();
    expect(created).toBe(1);
    lateFailure.reject(new Error("late failure"));
    await expect(late).rejects.toThrow("late failure");
    await replacement;
    expect(created).toBe(2);
    expect(registry.actorCount).toBe(1);
    await registry.dispose();
  });

  it("expires only an idle actor and resets the TTL on a new wake", async () => {
    vi.useFakeTimers();
    let created = 0;
    let disposed = 0;
    const registry = new ActorRegistry({
      idleTtlMs: 100,
      createActor: () => {
        created += 1;
        return {
          wake: async () => undefined,
          dispose: () => {
            disposed += 1;
          },
        };
      },
    });

    await registry.wake("space-a", "inbound");
    await vi.advanceTimersByTimeAsync(99);
    await registry.wake("space-a", "late_input");
    await vi.advanceTimersByTimeAsync(99);
    expect(registry.actorCount).toBe(1);
    expect(created).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(registry.actorCount).toBe(0);
    expect(disposed).toBe(1);
    await registry.dispose();
  });

  it("does not expire an actor while its drain promise remains active", async () => {
    vi.useFakeTimers();
    const drain = deferred<void>();
    let disposed = 0;
    const registry = new ActorRegistry({
      idleTtlMs: 25,
      createActor: () => ({
        wake: async () => drain.promise,
        dispose: () => {
          disposed += 1;
        },
      }),
    });

    const waking = registry.wake("space-a", "inbound");
    await vi.advanceTimersByTimeAsync(100);
    expect(registry.actorCount).toBe(1);

    drain.resolve(undefined);
    await waking;
    await vi.advanceTimersByTimeAsync(24);
    expect(registry.actorCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(registry.actorCount).toBe(0);
    expect(disposed).toBe(1);
    await registry.dispose();
  });

  it("serializes runExclusive per space without blocking another space", async () => {
    const registry = new ActorRegistry({
      createActor: () => ({ wake: async () => undefined }),
    });
    const firstGate = deferred<void>();
    const events: string[] = [];

    const first = registry.runExclusive("space-a", async () => {
      events.push("first-start");
      await firstGate.promise;
      events.push("first-end");
    });
    const second = registry.runExclusive("space-a", async () => {
      events.push("second");
    });
    const otherSpace = registry.runExclusive("space-b", async () => {
      events.push("other-space");
    });

    await otherSpace;
    expect(events).toEqual(["first-start", "other-space"]);
    firstGate.resolve(undefined);
    await Promise.all([first, second]);
    expect(events).toEqual([
      "first-start",
      "other-space",
      "first-end",
      "second",
    ]);
    await registry.dispose();
  });
});

describe("interaction semaphore", () => {
  it("is bounded, FIFO, and removes a canceled waiter safely", async () => {
    const semaphore = new InteractionSemaphore(1);
    const firstRelease = await semaphore.acquire();
    const canceled = new AbortController();
    const canceledReason = new Error("no longer current");
    const second = semaphore.acquire(canceled.signal);
    const third = semaphore.acquire();

    expect(semaphore.activeCount).toBe(1);
    expect(semaphore.pendingCount).toBe(2);
    canceled.abort(canceledReason);
    await expect(second).rejects.toBe(canceledReason);
    expect(semaphore.pendingCount).toBe(1);

    firstRelease();
    const thirdRelease = await third;
    expect(semaphore.activeCount).toBe(1);
    expect(semaphore.pendingCount).toBe(0);
    thirdRelease();
    thirdRelease();
    expect(semaphore.activeCount).toBe(0);
  });

  it("releases capacity when a protected operation fails", async () => {
    const semaphore = new InteractionSemaphore(2);
    await expect(
      semaphore.runExclusive(async () => {
        throw new Error("runtime failed");
      }),
    ).rejects.toThrow("runtime failed");

    expect(semaphore.activeCount).toBe(0);
    await expect(semaphore.runExclusive(async () => "replacement")).resolves.toBe(
      "replacement",
    );
  });
});

import { describe, expect, it } from "vitest";

import { InFlightChainRegistry } from "../../src/queue/in-flight-chain-registry.js";

const oldChainId = "00000000-0000-4000-8000-000000000201";
const newChainId = "00000000-0000-4000-8000-000000000202";

describe("in-flight chain cancellation", () => {
  it("aborts superseded work without poisoning the replacement chain", async () => {
    const registry = new InFlightChainRegistry();
    const events: string[] = [];
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const oldWork = registry.run(
      oldChainId,
      new AbortController().signal,
      async (signal) => {
        markStarted?.();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              events.push("old-aborted");
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    );

    await started;
    expect(registry.cancel([oldChainId])).toBe(1);
    await expect(oldWork).resolves.toBeUndefined();

    await registry.run(
      newChainId,
      new AbortController().signal,
      async (signal) => {
        events.push(signal.aborted ? "replacement-aborted" : "replacement-ran");
      },
    );
    expect(events).toEqual(["old-aborted", "replacement-ran"]);
    expect(registry.cancel([oldChainId, newChainId])).toBe(0);
  });

  it("propagates the queue worker signal into chain-scoped work", async () => {
    const registry = new InFlightChainRegistry();
    const worker = new AbortController();
    const work = registry.run(oldChainId, worker.signal, async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    });

    worker.abort(new Error("queue worker stopped"));

    await expect(work).rejects.toThrow("queue worker stopped");
    expect(registry.cancel([oldChainId])).toBe(0);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InteractionPresence,
  runWithPresence,
  type InteractionPresenceTransport,
} from "../../src/transport/interaction-presence.js";

function transportFake(): InteractionPresenceTransport {
  return {
    start: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("InteractionPresence", () => {
  it("refreshes while work is active and stops after success", async () => {
    vi.useFakeTimers();
    const transport = transportFake();
    const presence = new InteractionPresence({
      transport,
      refreshIntervalMs: 25,
    });
    const abort = new AbortController();
    let finish!: () => void;
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const running = runWithPresence(
      presence,
      {
        interactionRunId: "interaction-run-1",
        signal: abort.signal,
        spaceId: "space-1",
      },
      () => work,
    );
    await flushPromises();

    expect(transport.start).toHaveBeenCalledWith("space-1");
    await vi.advanceTimersByTimeAsync(25);
    expect(transport.refresh).toHaveBeenCalledWith("space-1");

    finish();
    await running;
    expect(transport.stop).toHaveBeenCalledTimes(1);
    expect(transport.stop).toHaveBeenCalledWith("space-1");
  });

  it("stops in finally without replacing a work failure", async () => {
    const transport = transportFake();
    const presence = new InteractionPresence({ transport });
    const failure = new Error("interaction failed");

    await expect(
      runWithPresence(
        presence,
        {
          interactionRunId: "interaction-run-2",
          signal: new AbortController().signal,
          spaceId: "space-2",
        },
        () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(transport.stop).toHaveBeenCalledTimes(1);
    expect(transport.stop).toHaveBeenCalledWith("space-2");
  });

  it("stops once when interruption aborts the active run", async () => {
    const transport = transportFake();
    const presence = new InteractionPresence({ transport });
    const abort = new AbortController();
    const lease = await presence.start({
      interactionRunId: "interaction-run-3",
      signal: abort.signal,
      spaceId: "space-3",
    });

    abort.abort();
    await flushPromises();
    await lease.stop();

    expect(transport.stop).toHaveBeenCalledTimes(1);
    expect(transport.stop).toHaveBeenCalledWith("space-3");
  });

  it("compensates when a timed-out start settles after final cleanup", async () => {
    vi.useFakeTimers();
    const lateStart = deferred();
    const transport = transportFake();
    vi.mocked(transport.start).mockReturnValue(lateStart.promise);
    const presence = new InteractionPresence({
      operationTimeoutMs: 10,
      transport,
    });

    const running = runWithPresence(
      presence,
      {
        interactionRunId: "interaction-run-late-start",
        signal: new AbortController().signal,
        spaceId: "space-late-start",
      },
      () => "completed",
    );
    await vi.advanceTimersByTimeAsync(10);
    await expect(running).resolves.toBe("completed");
    expect(transport.stop).toHaveBeenCalledTimes(1);

    lateStart.resolve();
    await flushPromises();
    expect(transport.stop).toHaveBeenCalledTimes(2);
    expect(transport.stop).toHaveBeenLastCalledWith("space-late-start");
  });

  it("does not let an old late start disable a replacement run", async () => {
    vi.useFakeTimers();
    const lateStart = deferred();
    let present = false;
    let startCalls = 0;
    const transport: InteractionPresenceTransport = {
      start: vi.fn(async () => {
        startCalls += 1;
        if (startCalls === 1) {
          await lateStart.promise;
        }
        present = true;
      }),
      refresh: vi.fn(async () => {
        present = true;
      }),
      stop: vi.fn(async () => {
        present = false;
      }),
    };
    const presence = new InteractionPresence({
      operationTimeoutMs: 10,
      transport,
    });

    const oldLeasePromise = presence.start({
      interactionRunId: "interaction-run-old",
      signal: new AbortController().signal,
      spaceId: "space-replaced",
    });
    await vi.advanceTimersByTimeAsync(10);
    const oldLease = await oldLeasePromise;
    await oldLease.stop();
    const replacementLease = await presence.start({
      interactionRunId: "interaction-run-replacement",
      signal: new AbortController().signal,
      spaceId: "space-replaced",
    });
    expect(present).toBe(true);

    lateStart.resolve();
    await flushPromises();
    expect(present).toBe(true);

    await replacementLease.stop();
  });

  it("drains late presence settlement before shutdown completes", async () => {
    vi.useFakeTimers();
    const lateStart = deferred();
    const transport = transportFake();
    vi.mocked(transport.start).mockReturnValue(lateStart.promise);
    const presence = new InteractionPresence({
      operationTimeoutMs: 10,
      transport,
    });

    const leasePromise = presence.start({
      interactionRunId: "interaction-run-shutdown-late-start",
      signal: new AbortController().signal,
      spaceId: "space-shutdown-late-start",
    });
    await vi.advanceTimersByTimeAsync(10);
    await leasePromise;

    let shutdownCompleted = false;
    const shutdown = presence.shutdown().then(() => {
      shutdownCompleted = true;
    });
    await flushPromises();
    expect(shutdownCompleted).toBe(false);
    expect(transport.stop).toHaveBeenCalledTimes(1);

    lateStart.resolve();
    await shutdown;
    expect(shutdownCompleted).toBe(true);
    expect(transport.stop).toHaveBeenCalledTimes(2);
  });

  it("stops every active run during shutdown and rejects new presence work as a no-op", async () => {
    const transport = transportFake();
    const presence = new InteractionPresence({ transport });
    await presence.start({
      interactionRunId: "interaction-run-4",
      signal: new AbortController().signal,
      spaceId: "space-4",
    });
    await presence.start({
      interactionRunId: "interaction-run-5",
      signal: new AbortController().signal,
      spaceId: "space-5",
    });

    await presence.shutdown();
    await presence.shutdown();
    const stoppedLease = await presence.start({
      interactionRunId: "interaction-run-after-shutdown",
      signal: new AbortController().signal,
      spaceId: "space-after-shutdown",
    });
    await stoppedLease.stop();

    expect(transport.stop).toHaveBeenCalledTimes(2);
    expect(transport.stop).toHaveBeenCalledWith("space-4");
    expect(transport.stop).toHaveBeenCalledWith("space-5");
    expect(transport.start).not.toHaveBeenCalledWith("space-after-shutdown");
  });

  it("contains provider and diagnostic failures so they never fail the interaction", async () => {
    const failures = vi.fn(async () => {
      throw new Error("metrics unavailable");
    });
    const transport: InteractionPresenceTransport = {
      start: vi.fn(async () => {
        throw new Error("provider start failed");
      }),
      refresh: vi.fn(async () => {
        throw new Error("provider refresh failed");
      }),
      stop: vi.fn(async () => {
        throw new Error("provider stop failed");
      }),
    };
    const presence = new InteractionPresence({
      onFailure: failures,
      transport,
    });

    await expect(
      runWithPresence(
        presence,
        {
          interactionRunId: "interaction-run-6",
          signal: new AbortController().signal,
          spaceId: "space-6",
        },
        () => "completed",
      ),
    ).resolves.toBe("completed");
    await flushPromises();
    expect(failures).toHaveBeenCalledTimes(2);
    expect(transport.stop).toHaveBeenCalledWith("space-6");
  });
});

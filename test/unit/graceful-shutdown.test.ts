import { describe, expect, it, vi } from "vitest";

import { ReadinessRegistry } from "../../src/http/readiness.js";
import { GracefulShutdown } from "../../src/runtime/graceful-shutdown.js";

describe("graceful shutdown", () => {
  it("drops readiness, aborts active work, and closes in recovery-safe order", async () => {
    const readiness = new ReadinessRegistry();
    const shutdown = new GracefulShutdown(readiness);
    const order: string[] = [];
    shutdown.signal.addEventListener("abort", () => order.push("abort"));
    for (const [name, priority] of [
      ["spectrum", 10],
      ["codex", 20],
      ["outbound-checkpoint", 30],
      ["queue", 40],
      ["database", 50],
      ["health-http", 60],
    ] as const) {
      shutdown.register({
        name,
        priority,
        timeoutMs: 1_000,
        stop: vi.fn(async () => {
          order.push(name);
        }),
      });
    }

    const [first, second] = await Promise.all([
      shutdown.shutdown("SIGTERM"),
      shutdown.shutdown("SIGTERM"),
    ]);
    expect(first).toEqual({ clean: true, failures: [] });
    expect(second).toBe(first);
    expect(order).toEqual([
      "abort",
      "spectrum",
      "codex",
      "outbound-checkpoint",
      "queue",
      "database",
      "health-http",
    ]);
    expect(readiness.snapshot()).toMatchObject({
      ready: false,
      shuttingDown: true,
    });
  });

  it("continues cleanup and reports critical failure without raw errors", async () => {
    const readiness = new ReadinessRegistry();
    const shutdown = new GracefulShutdown(readiness);
    const closed = vi.fn(async () => undefined);
    shutdown.register({
      name: "queue",
      priority: 10,
      timeoutMs: 1_000,
      stop: async () => {
        throw new Error("postgresql://user:secret@example.test/private");
      },
    });
    shutdown.register({
      name: "database",
      priority: 20,
      timeoutMs: 1_000,
      stop: closed,
    });

    const result = await shutdown.shutdown();
    expect(result).toEqual({
      clean: false,
      failures: [
        { name: "queue", critical: true, code: "SHUTDOWN_FAILED" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(closed).toHaveBeenCalledOnce();
  });

  it("bounds hung hooks and does not infer timeout from provider text", async () => {
    const readiness = new ReadinessRegistry();
    const shutdown = new GracefulShutdown(readiness);
    shutdown.register({
      name: "codex",
      priority: 10,
      timeoutMs: 5,
      stop: async () => await new Promise<void>(() => {}),
    });
    shutdown.register({
      name: "queue",
      priority: 20,
      timeoutMs: 1_000,
      stop: async () => {
        throw new Error("provider said request timed out with credential secret");
      },
    });

    const result = await shutdown.shutdown();

    expect(result).toEqual({
      clean: false,
      failures: [
        { name: "codex", critical: true, code: "SHUTDOWN_TIMEOUT" },
        { name: "queue", critical: true, code: "SHUTDOWN_FAILED" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

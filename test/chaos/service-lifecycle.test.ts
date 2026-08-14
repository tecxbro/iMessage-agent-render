import { type AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startAgentService,
  type AgentServiceBootstrap,
  type RunningAgentService,
} from "../../src/index.js";
import { runSpectrumMessageLoop } from "../../src/transport/message-loop.js";

const runningServices: RunningAgentService[] = [];

afterEach(async () => {
  await Promise.all(
    runningServices.splice(0).map(async (service) => service.shutdown("test")),
  );
});

async function fetchReadiness(service: RunningAgentService): Promise<{
  status: number;
  body: {
    actions: string[];
    components: Record<string, { code?: string; state: string }>;
    ready: boolean;
    shuttingDown: boolean;
  };
}> {
  const address = service.health.server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/readyz`);
  return {
    status: response.status,
    body: (await response.json()) as {
      actions: string[];
      components: Record<string, { code?: string; state: string }>;
      ready: boolean;
      shuttingDown: boolean;
    },
  };
}

describe("composed service lifecycle recovery", () => {
  it("boots in dependency order and gracefully checkpoints before durable resources close", async () => {
    const events: string[] = [];
    const stage = (name: string) => async (): Promise<void> => {
      events.push(name);
    };
    const bootstrap: AgentServiceBootstrap = {
      prepareConfiguration: stage("start:configuration"),
      prepareStorage: stage("start:storage"),
      connectDatabase: stage("start:database"),
      applyMigrations: stage("start:migrations"),
      startQueue: stage("start:queue"),
      checkCodex: async () => {
        events.push("start:codex");
        return { auth: "ok", capabilities: "ok" };
      },
      configureSupermemory: async () => {
        events.push("start:supermemory");
        return "disabled";
      },
      startSpectrum: async ({ signal, readiness }) => {
        events.push("start:spectrum");
        signal.addEventListener(
          "abort",
          () => events.push("stop:abort-active-work"),
          { once: true },
        );
        readiness.markConnected();
      },
      stopSpectrum: stage("stop:spectrum"),
      stopCodex: stage("stop:codex"),
      checkpointOutbound: stage("stop:outbound-checkpoint"),
      stopQueue: stage("stop:queue"),
      closeDatabase: stage("stop:database"),
    };

    const service = await startAgentService({
      port: 0,
      host: "127.0.0.1",
      bootstrap,
      installSignalHandlers: false,
    });
    runningServices.push(service);

    expect(events).toEqual([
      "start:configuration",
      "start:storage",
      "start:database",
      "start:migrations",
      "start:queue",
      "start:codex",
      "start:supermemory",
      "start:spectrum",
    ]);
    await expect(fetchReadiness(service)).resolves.toMatchObject({
      status: 200,
      body: { ready: true, shuttingDown: false },
    });

    await expect(service.shutdown("SIGTERM")).resolves.toEqual({
      clean: true,
      failures: [],
    });
    expect(events.slice(8)).toEqual([
      "stop:abort-active-work",
      "stop:spectrum",
      "stop:codex",
      "stop:outbound-checkpoint",
      "stop:queue",
      "stop:database",
    ]);
    expect(service.readiness.snapshot(service.spectrumReadiness.snapshot())).toMatchObject(
      {
        ready: false,
        shuttingDown: true,
      },
    );
    expect(service.health.server.listening).toBe(false);
  });

  it("surfaces a Spectrum disconnect without leaking the provider error", async () => {
    const startupFailure = vi.fn<(code: string) => void>();
    const stopQueue = vi.fn(async () => undefined);
    const closeDatabase = vi.fn(async () => undefined);
    const providerError =
      "Spectrum rejected project secret photon-super-secret for +15555550123";
    async function* disconnectedStream(): AsyncGenerator<never, void, unknown> {
      throw new Error(providerError);
    }

    const service = await startAgentService({
      port: 0,
      host: "127.0.0.1",
      installSignalHandlers: false,
      onStartupFailure: startupFailure,
      bootstrap: {
        prepareConfiguration: async () => undefined,
        prepareStorage: async () => undefined,
        connectDatabase: async () => undefined,
        applyMigrations: async () => undefined,
        startQueue: async () => undefined,
        checkCodex: async () => ({ auth: "ok", capabilities: "ok" }),
        configureSupermemory: async () => "disabled",
        startSpectrum: async ({ signal, readiness }) =>
          runSpectrumMessageLoop({
            authorizeAndIngest: {
              authorizeAndIngest: async () => "accepted",
            },
            messages: disconnectedStream,
            readiness,
            restartPolicy: {
              maxRestarts: 0,
              initialDelayMs: 1,
              maximumDelayMs: 1,
            },
            signal,
          }),
        stopQueue,
        closeDatabase,
      },
    });
    runningServices.push(service);

    expect(startupFailure).toHaveBeenCalledWith("SPECTRUM_START_FAILED");
    const readiness = await fetchReadiness(service);
    expect(readiness.status).toBe(503);
    expect(readiness.body).toMatchObject({
      ready: false,
      components: {
        spectrum: {
          code: "SPECTRUM_STREAM_DISCONNECTED",
          state: "degraded",
        },
      },
    });
    expect(readiness.body.actions).toEqual([
      expect.stringContaining("Photon connectivity"),
    ]);
    expect(JSON.stringify(readiness.body)).not.toContain("photon-super-secret");
    expect(JSON.stringify(readiness.body)).not.toContain("+15555550123");

    await service.shutdown("test");
    expect(stopQueue).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it("pauses Spectrum startup and gives operator remediation when Codex auth expires", async () => {
    const startSpectrum = vi.fn(async () => undefined);
    const service = await startAgentService({
      port: 0,
      host: "127.0.0.1",
      installSignalHandlers: false,
      bootstrap: {
        prepareConfiguration: async () => undefined,
        prepareStorage: async () => undefined,
        connectDatabase: async () => undefined,
        applyMigrations: async () => undefined,
        startQueue: async () => undefined,
        checkCodex: async () => ({
          auth: "failed",
          capabilities: "unknown",
          authCode: "CODEX_AUTH_EXPIRED",
        }),
        configureSupermemory: async () => "disabled",
        startSpectrum,
      },
    });
    runningServices.push(service);

    expect(startSpectrum).not.toHaveBeenCalled();
    const address = service.health.server.address() as AddressInfo;
    const live = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    expect(live.status).toBe(200);
    const readiness = await fetchReadiness(service);
    expect(readiness.status).toBe(503);
    expect(readiness.body).toMatchObject({
      ready: false,
      components: {
        codexAuth: { code: "CODEX_AUTH_EXPIRED", state: "failed" },
        codexCapabilities: { state: "unknown" },
        spectrum: { state: "missing" },
      },
    });
    expect(readiness.body.actions).toEqual([
      expect.stringContaining("npm run codex:login again"),
    ]);
  });
});

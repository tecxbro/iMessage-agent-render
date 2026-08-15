import {
  ReadinessRegistry,
  SpectrumReadiness,
  type ReadinessState,
} from "./http/readiness.js";
import { startHealthServer, type HealthServer } from "./http/server.js";
import type { DeploymentPageOptions } from "./http/deployment-page.js";
import {
  GracefulShutdown,
  installShutdownSignals,
  type ShutdownResult,
} from "./runtime/graceful-shutdown.js";

export interface CodexStartupState {
  auth: Extract<ReadinessState, "ok" | "missing" | "failed">;
  capabilities: Extract<ReadinessState, "ok" | "unknown" | "failed">;
  authCode?: "CODEX_AUTH_MISSING" | "CODEX_AUTH_EXPIRED";
  capabilityCode?: "CODEX_CAPABILITY_FAILED";
}

export interface AgentServiceBootstrap {
  prepareConfiguration(): Promise<void>;
  prepareStorage(): Promise<void>;
  connectDatabase(): Promise<void>;
  applyMigrations(): Promise<void>;
  startQueue(): Promise<void>;
  checkCodex(): Promise<CodexStartupState>;
  configureSupermemory(): Promise<
    Extract<ReadinessState, "ok" | "disabled" | "degraded" | "failed">
  >;
  startSpectrum(input: {
    signal: AbortSignal;
    readiness: SpectrumReadiness;
  }): Promise<void>;
  stopSpectrum?(): Promise<void>;
  stopCodex?(): Promise<void>;
  checkpointOutbound?(): Promise<void>;
  stopQueue?(): Promise<void>;
  closeDatabase?(): Promise<void>;
}

export interface RunningAgentService {
  readiness: ReadinessRegistry;
  spectrumReadiness: SpectrumReadiness;
  health: HealthServer;
  shutdown(reason?: NodeJS.Signals | "test"): Promise<ShutdownResult>;
}

export interface StartAgentServiceOptions {
  port: number;
  host?: string;
  bootstrap: AgentServiceBootstrap;
  deploymentPage?: Omit<DeploymentPageOptions, "runtimeMode">;
  installSignalHandlers?: boolean;
  onStartupFailure?: (code: string) => void;
}

class StartupStageError extends Error {
  public constructor(public readonly code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "StartupStageError";
  }
}

async function runStartupStage(
  code: string,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    throw new StartupStageError(code, { cause: error });
  }
}

/**
 * Owns provider-neutral boot and shutdown ordering.
 *
 * HTTP starts first so `/healthz` remains available while private dependencies
 * initialize. Spectrum starts only after Codex authentication and capability
 * checks pass. Shutdown hooks are registered in reverse dependency order so
 * intake and active work stop before queues, PostgreSQL, and HTTP close.
 */
export async function startAgentService(
  options: StartAgentServiceOptions,
): Promise<RunningAgentService> {
  const readiness = new ReadinessRegistry();
  const spectrumReadiness = new SpectrumReadiness();
  const shutdown = new GracefulShutdown(readiness);
  const health = await startHealthServer({
    port: options.port,
    ...(options.host === undefined ? {} : { host: options.host }),
    readiness,
    spectrum: spectrumReadiness,
    deploymentPage: {
      ...(options.deploymentPage ?? {
        authMode: "chatgpt",
        supermemoryConfigured: false,
      }),
      runtimeMode: "agent",
    },
  });

  shutdown.register({
    name: "health-http",
    priority: 60,
    timeoutMs: 10_000,
    stop: () => health.close(),
  });

  try {
    readiness.mark("configuration", "starting");
    await runStartupStage(
      "CONFIGURATION_INVALID",
      options.bootstrap.prepareConfiguration,
    );
    readiness.mark("configuration", "ok");

    readiness.mark("disk", "starting");
    readiness.mark("workspace", "starting");
    await runStartupStage(
      "PERSISTENT_STORAGE_INVALID",
      options.bootstrap.prepareStorage,
    );
    readiness.mark("disk", "ok");
    readiness.mark("workspace", "ok");

    readiness.mark("database", "starting");
    await runStartupStage(
      "DATABASE_UNAVAILABLE",
      options.bootstrap.connectDatabase,
    );
    readiness.mark("database", "ok");
    if (options.bootstrap.closeDatabase !== undefined) {
      shutdown.register({
        name: "database",
        priority: 50,
        timeoutMs: 15_000,
        stop: options.bootstrap.closeDatabase,
      });
    }

    readiness.mark("migrations", "starting");
    await runStartupStage(
      "MIGRATIONS_PENDING",
      options.bootstrap.applyMigrations,
    );
    readiness.mark("migrations", "ok");

    readiness.mark("queue", "starting");
    await runStartupStage("QUEUE_UNAVAILABLE", options.bootstrap.startQueue);
    readiness.mark("queue", "ok");
    if (options.bootstrap.stopQueue !== undefined) {
      shutdown.register({
        name: "queue",
        priority: 40,
        timeoutMs: 30_000,
        stop: options.bootstrap.stopQueue,
      });
    }
    if (options.bootstrap.checkpointOutbound !== undefined) {
      shutdown.register({
        name: "outbound-checkpoint",
        priority: 30,
        timeoutMs: 25_000,
        stop: options.bootstrap.checkpointOutbound,
      });
    }

    readiness.mark("codexAuth", "starting");
    readiness.mark("codexCapabilities", "starting");
    const codex = await options.bootstrap.checkCodex();
    readiness.mark("codexAuth", codex.auth, codex.authCode);
    readiness.mark(
      "codexCapabilities",
      codex.capabilities,
      codex.capabilityCode,
    );
    if (options.bootstrap.stopCodex !== undefined) {
      shutdown.register({
        name: "codex",
        priority: 20,
        timeoutMs: 15_000,
        stop: options.bootstrap.stopCodex,
      });
    }

    const memoryState = await options.bootstrap.configureSupermemory();
    readiness.mark(
      "supermemory",
      memoryState,
      memoryState === "failed" ? "SUPERMEMORY_CONFIGURATION_INVALID" : undefined,
    );

    if (codex.auth === "ok" && codex.capabilities === "ok") {
      spectrumReadiness.markStarting();
      await runStartupStage("SPECTRUM_START_FAILED", () =>
        options.bootstrap.startSpectrum({
          signal: shutdown.signal,
          readiness: spectrumReadiness,
        }),
      );
      if (options.bootstrap.stopSpectrum !== undefined) {
        shutdown.register({
          name: "spectrum",
          priority: 10,
          timeoutMs: 10_000,
          stop: options.bootstrap.stopSpectrum,
        });
      }
    } else {
      spectrumReadiness.markStopped();
    }
  } catch (error) {
    const code =
      error instanceof StartupStageError ? error.code : "STARTUP_FAILED";
    if (code === "CONFIGURATION_INVALID") {
      readiness.mark("configuration", "failed", code);
    } else if (code === "PERSISTENT_STORAGE_INVALID") {
      readiness.mark("disk", "failed", code);
      readiness.mark("workspace", "failed", code);
    } else if (code === "DATABASE_UNAVAILABLE") {
      readiness.mark("database", "failed", code);
    } else if (code === "MIGRATIONS_PENDING") {
      readiness.mark("migrations", "failed", code);
    } else if (code === "QUEUE_UNAVAILABLE") {
      readiness.mark("queue", "failed", code);
    } else if (code === "SPECTRUM_START_FAILED") {
      spectrumReadiness.markDegraded("SPECTRUM_STREAM_DISCONNECTED", 1);
    }
    options.onStartupFailure?.(code);
  }

  if (options.installSignalHandlers ?? true) {
    installShutdownSignals({ shutdown });
  }

  return {
    readiness,
    spectrumReadiness,
    health,
    shutdown: (reason) => shutdown.shutdown(reason),
  };
}

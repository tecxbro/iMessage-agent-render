import { loadEnvironment } from "./config/env.js";
import { loadPromptBundle } from "./config/prompt-bundle.js";
import { ReadinessRegistry, SpectrumReadiness } from "./http/readiness.js";
import { startHealthServer } from "./http/server.js";
import { logger } from "./observability/logger.js";
import {
  GracefulShutdown,
  installShutdownSignals,
} from "./runtime/graceful-shutdown.js";

const environment = loadEnvironment();
const promptBundle = await loadPromptBundle();
const readiness = new ReadinessRegistry();
const spectrumReadiness = new SpectrumReadiness();
readiness.mark("configuration", "ok");

const health = await startHealthServer({
  port: environment.PORT,
  host: "0.0.0.0",
  readiness,
  spectrum: spectrumReadiness,
});
const shutdown = new GracefulShutdown(readiness);
shutdown.register({
  name: "health-http",
  priority: 60,
  timeoutMs: 10_000,
  stop: () => health.close(),
});
installShutdownSignals({
  shutdown,
  onResult: (result, signal) => {
    logger.info(
      {
        component: "bootstrap",
        signal,
        clean: result.clean,
        failureCodes: result.failures.map((failure) => failure.code),
      },
      "foundation service stopped",
    );
  },
});

logger.info(
  {
    component: "bootstrap",
    port: environment.PORT,
    promptBundleVersion: promptBundle.version,
  },
  "foundation service listening; operational composition is not ready",
);

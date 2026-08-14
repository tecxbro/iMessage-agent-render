import { buildCodexChildEnvironment } from "./agent/child-environment.js";
import { loadEnvironment } from "./config/env.js";
import { loadPromptBundle } from "./config/prompt-bundle.js";
import { ReadinessRegistry, SpectrumReadiness } from "./http/readiness.js";
import { startHealthServer } from "./http/server.js";
import { createLogger } from "./observability/logger.js";
import {
  GracefulShutdown,
  installShutdownSignals,
} from "./runtime/graceful-shutdown.js";
import { auditStartupSecretBoundaries } from "./security/secret-boundaries.js";

const environment = loadEnvironment();
const protectedValues = [
  environment.DATABASE_URL,
  environment.SPECTRUM_PROJECT_SECRET,
  environment.APP_ENCRYPTION_KEY,
  ...(environment.OPENAI_API_KEY === undefined
    ? []
    : [environment.OPENAI_API_KEY]),
  ...(environment.SUPERMEMORY_API_KEY === undefined
    ? []
    : [environment.SUPERMEMORY_API_KEY]),
];
const logger = createLogger({ protectedValues });
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

try {
  const childEnvironment = buildCodexChildEnvironment({
    parentEnvironment: {
      PATH: environment.PATH,
      ...(environment.LANG === undefined ? {} : { LANG: environment.LANG }),
      ...(environment.LANGUAGE === undefined
        ? {}
        : { LANGUAGE: environment.LANGUAGE }),
      ...(environment.LC_ALL === undefined ? {} : { LC_ALL: environment.LC_ALL }),
      ...(environment.LC_CTYPE === undefined
        ? {}
        : { LC_CTYPE: environment.LC_CTYPE }),
    },
    codexHome: environment.CODEX_HOME,
    authMode: environment.CODEX_AUTH_MODE,
    ...(environment.OPENAI_API_KEY === undefined
      ? {}
      : { openAiApiKey: environment.OPENAI_API_KEY }),
  });
  await auditStartupSecretBoundaries({
    codexHome: environment.CODEX_HOME,
    workspaceRoot: environment.AGENT_WORKSPACE_ROOT,
    authMode: environment.CODEX_AUTH_MODE,
    childEnvironment,
    protectedValues,
  });
  readiness.mark("disk", "ok");
  readiness.mark("workspace", "ok");
} catch {
  readiness.mark("disk", "failed", "PERSISTENT_STORAGE_INVALID");
  readiness.mark("workspace", "failed", "PERSISTENT_STORAGE_INVALID");
  logger.warn(
    {
      component: "bootstrap",
      errorCode: "PERSISTENT_STORAGE_INVALID",
    },
    "secret and persistent-storage boundary audit failed; execution remains paused",
  );
}

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

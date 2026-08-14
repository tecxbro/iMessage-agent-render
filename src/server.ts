import express from "express";

import { buildCodexChildEnvironment } from "./agent/child-environment.js";
import { loadEnvironment } from "./config/env.js";
import { loadPromptBundle } from "./config/prompt-bundle.js";
import { createLogger } from "./observability/logger.js";
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
const promptBundle = await loadPromptBundle();

const server = express();

server.get("/healthz", (_req, res) => {
  res.status(200).send("ok");
});

server.listen(environment.PORT, "0.0.0.0", () => {
  logger.info(
    {
      component: "bootstrap",
      port: environment.PORT,
      promptBundleVersion: promptBundle.version,
    },
    "foundation service listening",
  );
});

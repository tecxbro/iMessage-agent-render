import express from "express";

import { loadEnvironment } from "./config/env.js";
import { loadPromptBundle } from "./config/prompt-bundle.js";
import { logger } from "./observability/logger.js";

const environment = loadEnvironment();
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

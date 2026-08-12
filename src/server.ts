/**
 * HTTP server for Render. Transport only — Photon logic lives in photon.ts.
 * https://render.com/docs/web-services
 */
import express from "express";
import { spectrum } from "@spectrum-ts/express";
import { onMessage, photon } from "./photon.js";

const server = express();

// IMPORTANT:
// Spectrum must receive the raw webhook body for HMAC verification.
// Mount the Photon Express adapter BEFORE express.json() (or any body parser).
// https://photon.codes/docs/spectrum-ts/webhooks
// Default path: POST /spectrum/webhook
server.use(
  spectrum({
    app: photon,
    onMessage,
  }),
);

server.use(express.json());

// Render health check — https://render.com/docs/health-checks
server.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

// Render injects PORT; bind all interfaces so the platform can reach the process.
// https://render.com/docs/web-services#port-binding
const port = Number(process.env.PORT || 10000);
server.listen(port, "0.0.0.0", () => {
  console.log(`listening on 0.0.0.0:${port}`);
});

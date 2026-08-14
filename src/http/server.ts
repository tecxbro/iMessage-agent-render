import { type Server } from "node:http";

import express, { type Express } from "express";

import {
  ReadinessRegistry,
  type SpectrumReadiness,
} from "./readiness.js";

export interface HealthApplicationOptions {
  readiness: ReadinessRegistry;
  spectrum?: SpectrumReadiness;
}

export interface HealthServer {
  readonly application: Express;
  readonly server: Server;
  close(): Promise<void>;
}

export function createHealthApplication(
  options: HealthApplicationOptions,
): Express {
  const application = express();
  application.disable("x-powered-by");

  application.get("/healthz", (_request, response) => {
    response.set("cache-control", "no-store");
    response.status(200).json({ status: "ok" });
  });

  application.get("/readyz", (_request, response) => {
    const snapshot = options.readiness.snapshot(options.spectrum?.snapshot());
    response.set("cache-control", "no-store");
    response.status(snapshot.ready ? 200 : 503).json(snapshot);
  });

  return application;
}

export async function startHealthServer(input: {
  port: number;
  host?: string;
  readiness: ReadinessRegistry;
  spectrum?: SpectrumReadiness;
}): Promise<HealthServer> {
  const application = createHealthApplication(input);
  const server = await new Promise<Server>((resolve, reject) => {
    const listener = application.listen(
      input.port,
      input.host ?? "0.0.0.0",
      () => resolve(listener),
    );
    listener.once("error", reject);
  });

  return {
    application,
    server,
    async close() {
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
  };
}

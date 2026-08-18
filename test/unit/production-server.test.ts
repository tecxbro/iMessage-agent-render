import { readFile } from "node:fs/promises";
import { type AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createOperatorAuth } from "../../src/http/operator-auth.js";
import {
  startProductionServer,
  type ProductionServer,
} from "../../src/server.js";

let server: ProductionServer | undefined;

afterEach(async () => {
  await server?.shutdown("test");
  server = undefined;
});

describe("production executable entrypoint", () => {
  it("enables secure operator-session cookies in production composition", async () => {
    const source = await readFile(
      new URL("../../src/server.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      'secureSessionCookie: runtime.environment.NODE_ENV === "production"',
    );
  });

  it("starts the composed agent lifecycle instead of the foundation shell", async () => {
    const stages: string[] = [];
    const stage = (name: string) => async (): Promise<void> => {
      stages.push(name);
    };
    const operatorAuth = await createOperatorAuth({
      password: "test-dashboard-setup-secret-material-1234567890",
    });
    const closeOperatorAuth = vi.spyOn(operatorAuth, "close");

    server = await startProductionServer({
      port: 0,
      host: "127.0.0.1",
      installSignalHandlers: false,
      operatorAuth,
      deploymentPage: {
        authMode: "api_key",
        supermemoryConfigured: false,
      },
      bootstrap: {
        prepareConfiguration: stage("configuration"),
        prepareStorage: stage("storage"),
        connectDatabase: stage("database"),
        applyMigrations: stage("migrations"),
        startQueue: stage("queue"),
        checkCodex: async () => {
          stages.push("codex");
          return { auth: "ok", capabilities: "ok" };
        },
        configureSupermemory: async () => {
          stages.push("memory");
          return "disabled";
        },
        startSpectrum: async ({ readiness }) => {
          stages.push("spectrum");
          readiness.markConnected();
        },
      },
    });

    expect(stages).toEqual([
      "configuration",
      "storage",
      "database",
      "migrations",
      "queue",
      "codex",
      "memory",
      "spectrum",
    ]);

    const address = server.health.server.address() as AddressInfo;
    const ready = await fetch(`http://127.0.0.1:${address.port}/readyz`);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({
      ready: true,
      status: "ready",
    });

    const root = await fetch(`http://127.0.0.1:${address.port}/`, {
      redirect: "manual",
    });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/agent/dashboard");

    const deployment = await fetch(
      `http://127.0.0.1:${address.port}/agent/dashboard`,
    );
    const deploymentPage = await deployment.text();
    expect(deploymentPage).toContain("Agent password");
    expect(deploymentPage).not.toContain("Photon");
    expect(deploymentPage).not.toContain("ChatGPT");

    await server.shutdown("test");
    expect(closeOperatorAuth).toHaveBeenCalledOnce();
  });
});

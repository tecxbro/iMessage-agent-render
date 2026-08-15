import { type AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  ReadinessRegistry,
  SpectrumReadiness,
  type ReadinessComponent,
} from "../../src/http/readiness.js";
import { startHealthServer, type HealthServer } from "../../src/http/server.js";

let health: HealthServer | undefined;

afterEach(async () => {
  await health?.close();
  health = undefined;
});

function markCriticalComponentsReady(readiness: ReadinessRegistry): void {
  for (const component of [
    "configuration",
    "database",
    "migrations",
    "queue",
    "codexAuth",
    "codexCapabilities",
    "disk",
    "workspace",
  ] satisfies ReadinessComponent[]) {
    readiness.mark(component, "ok");
  }
  readiness.mark("supermemory", "disabled");
}

describe("health and readiness endpoints", () => {
  it("keeps liveness healthy while setup is incomplete", async () => {
    const readiness = new ReadinessRegistry();
    const spectrum = new SpectrumReadiness();
    readiness.mark("codexAuth", "missing", "CODEX_AUTH_MISSING");
    health = await startHealthServer({
      port: 0,
      host: "127.0.0.1",
      readiness,
      spectrum,
    });
    const address = health.server.address() as AddressInfo;

    const deployment = await fetch(`http://127.0.0.1:${address.port}/`);
    expect(deployment.status).toBe(200);
    expect(deployment.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(deployment.headers.get("x-frame-options")).toBe("DENY");
    const deploymentPage = await deployment.text();
    expect(deploymentPage).toContain("Infrastructure is live");
    expect(deploymentPage).toContain("The agent runtime is not connected yet");
    expect(deploymentPage).toContain("npm run codex:login");
    expect(deploymentPage).toContain("operator status page");
    expect(deploymentPage).not.toContain("photon-super-secret");

    const live = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toEqual({ status: "ok" });

    const ready = await fetch(`http://127.0.0.1:${address.port}/readyz`);
    expect(ready.status).toBe(503);
    const body = (await ready.json()) as {
      actions: string[];
      ready: boolean;
      components: Record<string, { state: string }>;
    };
    expect(body.ready).toBe(false);
    expect(body.components["codexAuth"]?.state).toBe("missing");
    expect(body.actions).toEqual([
      expect.stringContaining("npm run codex:login"),
    ]);
  });

  it("reports ready only when every critical component is ready", () => {
    const readiness = new ReadinessRegistry();
    const spectrum = new SpectrumReadiness();
    markCriticalComponentsReady(readiness);
    spectrum.markConnected();

    expect(readiness.snapshot(spectrum.snapshot())).toMatchObject({
      ready: true,
      status: "ready",
      components: { supermemory: { state: "disabled" } },
    });

    readiness.beginShutdown();
    expect(readiness.snapshot(spectrum.snapshot())).toMatchObject({
      ready: false,
      status: "not_ready",
      shuttingDown: true,
    });
  });

  it("shows ready on the deployment page only for a composed ready runtime", async () => {
    const readiness = new ReadinessRegistry();
    const spectrum = new SpectrumReadiness();
    markCriticalComponentsReady(readiness);
    spectrum.markConnected();
    health = await startHealthServer({
      port: 0,
      host: "127.0.0.1",
      readiness,
      spectrum,
      deploymentPage: {
        authMode: "api_key",
        runtimeMode: "agent",
        supermemoryConfigured: false,
      },
    });
    const address = health.server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    const page = await response.text();
    expect(page).toContain("Agent ready");
    expect(page).toContain("Your private iMessage agent is ready");
    expect(page).toContain("OPENAI_API_KEY");
    expect(page).not.toContain("npm run codex:login");
  });

  it("rejects raw error text at the readiness boundary", () => {
    const readiness = new ReadinessRegistry();
    expect(() =>
      readiness.mark(
        "database",
        "failed",
        "connection failed for postgresql://user:secret@example.test/db",
      ),
    ).toThrow(/bounded uppercase identifiers/);
  });
});

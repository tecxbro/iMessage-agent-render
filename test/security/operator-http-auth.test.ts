import { readFile } from "node:fs/promises";
import { type AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatGptSetupController } from "../../src/agent/codex-app-server-auth.js";
import {
  createOperatorAuth,
  type OperatorAuth,
  type OperatorAuthOptions,
} from "../../src/http/operator-auth.js";
import { ReadinessRegistry } from "../../src/http/readiness.js";
import { startHealthServer, type HealthServer } from "../../src/http/server.js";
import type {
  DeploymentIdentityController,
  DeploymentIdentityStatus,
} from "../../src/runtime/deployment-identity.js";
import type {
  PhotonSetupController,
  PhotonSetupStatus,
} from "../../src/transport/photon-setup.js";

const SETUP_SECRET = "security-test-dashboard-setup-secret-material-0001";
const PHOTON_DEVICE_CODE = "PHOTON-PRIVATE-CODE";
const CHATGPT_DEVICE_CODE = "CHATGPT-PRIVATE-CODE";
const ASSIGNED_NUMBER = "+16285550123";
const OWNER_PHONE_NUMBER = "+14155550123";

let health: HealthServer | undefined;
let operatorAuth: OperatorAuth | undefined;

afterEach(async () => {
  await health?.close();
  operatorAuth?.close();
  health = undefined;
  operatorAuth = undefined;
  vi.restoreAllMocks();
});

interface SessionCredentials {
  cookie: string;
  csrfToken: string;
}

interface TestServerOptions {
  secureSessionCookie?: boolean;
  operatorAuthOptions?: Omit<OperatorAuthOptions, "setupSecret">;
  deploymentIdentity?: DeploymentIdentityController;
  photonSetup?: PhotonSetupController;
  chatgptSetup?: ChatGptSetupController;
}

async function startTestServer(options: TestServerOptions = {}): Promise<string> {
  const readiness = new ReadinessRegistry();
  readiness.mark("disk", "ok");
  readiness.mark("codexAuth", "missing", "CODEX_AUTH_MISSING");
  operatorAuth = createOperatorAuth({
    setupSecret: SETUP_SECRET,
    ...options.operatorAuthOptions,
  });
  health = await startHealthServer({
    port: 0,
    host: "127.0.0.1",
    readiness,
    operatorAuth,
    deploymentIdentity:
      options.deploymentIdentity ?? configuredDeploymentIdentity(),
    ...(options.secureSessionCookie === undefined
      ? {}
      : { secureSessionCookie: options.secureSessionCookie }),
    ...(options.photonSetup === undefined
      ? {}
      : { photonSetup: options.photonSetup }),
    ...(options.chatgptSetup === undefined
      ? {}
      : { chatgptSetup: options.chatgptSetup }),
  });
  const address = health.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function configuredDeploymentIdentity(
  initialStatus: DeploymentIdentityStatus = {
    state: "configured",
    maskedPhoneNumber: "••••••0123",
  },
): DeploymentIdentityController {
  let status = initialStatus;
  return {
    initialize: async () => status,
    status: () => ({ ...status }),
    configureOwner: async () => {
      status = { state: "configured", maskedPhoneNumber: "••••••0123" };
      return status;
    },
    readOwnerPhoneNumber: async () =>
      status.state === "configured" ? OWNER_PHONE_NUMBER : undefined,
    onConfigured: () => () => undefined,
  };
}

async function login(
  base: string,
  setupSecret = SETUP_SECRET,
): Promise<{ response: Response; credentials?: SessionCredentials }> {
  const response = await fetch(`${base}/api/operator/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupSecret }),
  });
  if (!response.ok) {
    return { response };
  }
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  const body = (await response.clone().json()) as { csrfToken: string };
  expect(cookie).toBeDefined();
  return {
    response,
    credentials: { cookie: cookie!, csrfToken: body.csrfToken },
  };
}

function authenticatedRequest(credentials: SessionCredentials): RequestInit {
  return { headers: { cookie: credentials.cookie } };
}

function csrfRequest(
  base: string,
  credentials: SessionCredentials,
  overrides: {
    token?: string | null;
    origin?: string;
    fetchSite?: string;
    method?: "POST" | "DELETE";
    body?: string;
  } = {},
): RequestInit {
  const method = overrides.method ?? "POST";
  return {
    method,
    headers: {
      cookie: credentials.cookie,
      origin: overrides.origin ?? base,
      ...(method === "POST" || overrides.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
      ...(overrides.token === null
        ? {}
        : { "x-csrf-token": overrides.token ?? credentials.csrfToken }),
      ...(overrides.fetchSite === undefined
        ? {}
        : { "sec-fetch-site": overrides.fetchSite }),
    },
    ...(method === "POST" || overrides.body !== undefined
      ? { body: overrides.body ?? "{}" }
      : {}),
  };
}

function connectedPhotonSetup(): PhotonSetupController {
  return {
    status: () => ({
      state: "connected",
      assignedPhoneNumber: ASSIGNED_NUMBER,
    }),
    start: async () => ({
      state: "awaiting_authorization",
      userCode: PHOTON_DEVICE_CODE,
      verificationUrl: "https://app.photon.codes/device",
      expiresAt: "2026-08-18T00:00:00.000Z",
    }),
  };
}

function chatGptSetup(): ChatGptSetupController {
  return {
    initialize: async () => ({ state: "not_connected" }),
    status: () => ({ state: "not_connected" }),
    start: async () => ({
      state: "awaiting_authorization",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: CHATGPT_DEVICE_CODE,
    }),
    onConnected: () => () => undefined,
    close: async () => undefined,
  };
}

describe("operator HTTP authentication and CSRF boundary", () => {
  it("shows only the login page and denies every private route before authentication", async () => {
    const photonStatus: PhotonSetupStatus = {
      state: "awaiting_authorization",
      userCode: PHOTON_DEVICE_CODE,
      verificationUrl: "https://app.photon.codes/device",
      expiresAt: "2026-08-18T00:00:00.000Z",
    };
    const photonStart = vi.fn(async () => photonStatus);
    const chatGptStart = vi.fn(async () => ({
      state: "awaiting_authorization" as const,
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: CHATGPT_DEVICE_CODE,
    }));
    const base = await startTestServer({
      photonSetup: { status: () => photonStatus, start: photonStart },
      chatgptSetup: {
        ...chatGptSetup(),
        status: () => ({
          state: "failed" as const,
          code: "CHATGPT_LOGIN_FAILED" as const,
        }),
        start: chatGptStart,
      },
    });

    const dashboard = await fetch(`${base}/agent/dashboard`);
    const html = await dashboard.text();
    expect(dashboard.status).toBe(200);
    expect(html).toContain("Deployment setup code");
    for (const privateValue of [
      "Photon",
      "ChatGPT",
      PHOTON_DEVICE_CODE,
      CHATGPT_DEVICE_CODE,
      "https://app.photon.codes/device",
      ASSIGNED_NUMBER,
      OWNER_PHONE_NUMBER,
      "CODEX_AUTH_MISSING",
      "CHATGPT_LOGIN_FAILED",
    ]) {
      expect(html).not.toContain(privateValue);
    }

    const oldHeader = { "x-agent-setup": "dashboard" };
    const oldHeaderDashboard = await fetch(`${base}/agent/dashboard`, {
      headers: oldHeader,
    });
    const oldHeaderDashboardHtml = await oldHeaderDashboard.text();
    expect(oldHeaderDashboard.status).toBe(200);
    expect(oldHeaderDashboardHtml).toContain("Deployment setup code");
    expect(oldHeaderDashboardHtml).not.toContain(PHOTON_DEVICE_CODE);

    const responses = await Promise.all([
      fetch(`${base}/agent/dashboard.js`, { headers: oldHeader }),
      fetch(`${base}/api/setup/owner/status`, { headers: oldHeader }),
      fetch(`${base}/api/setup/photon/status`, { headers: oldHeader }),
      fetch(`${base}/api/setup/chatgpt/status`, { headers: oldHeader }),
      fetch(`${base}/api/setup/owner`, {
        method: "POST",
        headers: oldHeader,
      }),
      fetch(`${base}/api/setup/photon/start`, {
        method: "POST",
        headers: oldHeader,
      }),
      fetch(`${base}/api/setup/chatgpt/start`, {
        method: "POST",
        headers: oldHeader,
      }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([
      401, 401, 401, 401, 403, 403, 403,
    ]);
    for (const response of responses) {
      const deniedBody = await response.text();
      for (const privateValue of [
        SETUP_SECRET,
        PHOTON_DEVICE_CODE,
        CHATGPT_DEVICE_CODE,
        "https://app.photon.codes/device",
        "https://auth.openai.com/codex/device",
        ASSIGNED_NUMBER,
        OWNER_PHONE_NUMBER,
        "CODEX_AUTH_MISSING",
        "CHATGPT_LOGIN_FAILED",
      ]) {
        expect(deniedBody).not.toContain(privateValue);
      }
    }
    expect(photonStart).not.toHaveBeenCalled();
    expect(chatGptStart).not.toHaveBeenCalled();

    const loginScript = await fetch(`${base}/agent/operator-login.js`);
    const loginJavascript = await loginScript.text();
    expect(loginScript.status).toBe(200);
    expect(loginJavascript).toContain("/api/operator/session");
    expect(loginJavascript).not.toContain(PHOTON_DEVICE_CODE);
    expect(loginJavascript).not.toContain(CHATGPT_DEVICE_CODE);

    const live = await fetch(`${base}/healthz`);
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toEqual({ status: "ok" });
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(503);
    await expect(ready.json()).resolves.toEqual({
      status: "not_ready",
      ready: false,
    });
  });

  it("does not leak seeded ChatGPT codes or assigned numbers in denied responses", async () => {
    const base = await startTestServer({
      photonSetup: connectedPhotonSetup(),
      chatgptSetup: {
        ...chatGptSetup(),
        status: () => ({
          state: "awaiting_authorization" as const,
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: CHATGPT_DEVICE_CODE,
        }),
      },
    });

    const deniedResponses = await Promise.all([
      fetch(`${base}/api/setup/owner/status`),
      fetch(`${base}/api/setup/photon/status`),
      fetch(`${base}/api/setup/chatgpt/status`),
      fetch(`${base}/agent/dashboard`),
    ]);
    expect(deniedResponses.map(({ status }) => status)).toEqual([
      401, 401, 401, 200,
    ]);
    for (const response of deniedResponses) {
      const body = await response.text();
      expect(body).not.toContain(ASSIGNED_NUMBER);
      expect(body).not.toContain(OWNER_PHONE_NUMBER);
      expect(body).not.toContain(CHATGPT_DEVICE_CODE);
      expect(body).not.toContain("https://auth.openai.com/codex/device");
    }
  });

  it("strictly parses login JSON, rejects invalid secrets, and rate-limits failures", async () => {
    const base = await startTestServer();

    const extraField = await fetch(`${base}/api/operator/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupSecret: SETUP_SECRET, unexpected: true }),
    });
    expect(extraField.status).toBe(400);

    const primitive = await fetch(`${base}/api/operator/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify("not-an-object"),
    });
    expect(primitive.status).toBe(400);

    const oversized = await fetch(`${base}/api/operator/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupSecret: "x".repeat(3_000) }),
    });
    expect(oversized.status).toBe(413);

    const responses: Response[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      responses.push((await login(base, `invalid-secret-material-${attempt}`)).response);
    }
    expect(responses.slice(0, 4).map(({ status }) => status)).toEqual([
      403, 403, 403, 403,
    ]);
    expect(responses[4]!.status).toBe(429);
    for (const response of responses) {
      expect(await response.text()).not.toContain(SETUP_SECRET);
    }

    const validAfterFailures = await login(base);
    expect(validAfterFailures.response.status).toBe(201);
    expect(validAfterFailures.credentials).toBeDefined();
  });

  it("creates a server-side session with the required production cookie attributes", async () => {
    const base = await startTestServer({ secureSessionCookie: true });
    const { response, credentials } = await login(base);

    expect(response.status).toBe(201);
    expect(credentials).toBeDefined();
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toContain("agent_operator_session=");
    expect(setCookie).toMatch(/; Path=\//u);
    expect(setCookie).toMatch(/; HttpOnly/u);
    expect(setCookie).toMatch(/; Secure/u);
    expect(setCookie).toMatch(/; SameSite=Strict/u);
    expect(setCookie).not.toMatch(/; Domain=/iu);
    expect(await response.text()).not.toContain(SETUP_SECRET);
  });

  it("rejects missing or invalid CSRF tokens, foreign origins, and cross-site fetches", async () => {
    const identity = configuredDeploymentIdentity();
    const configureOwner = vi.fn(identity.configureOwner);
    const photonStart = vi.fn(connectedPhotonSetup().start);
    const chatGptStart = vi.fn(chatGptSetup().start);
    const base = await startTestServer({
      deploymentIdentity: { ...identity, configureOwner },
      photonSetup: {
        status: connectedPhotonSetup().status,
        start: photonStart,
      },
      chatgptSetup: {
        ...chatGptSetup(),
        start: chatGptStart,
      },
    });
    const credentials = (await login(base)).credentials!;

    for (const target of [
      { endpoint: "/api/setup/owner", method: "POST" as const },
      { endpoint: "/api/setup/photon/start", method: "POST" as const },
      { endpoint: "/api/setup/chatgpt/start", method: "POST" as const },
      { endpoint: "/api/operator/session", method: "DELETE" as const },
    ]) {
      const denials = await Promise.all([
        fetch(
          `${base}${target.endpoint}`,
          csrfRequest(base, credentials, {
            method: target.method,
            token: null,
          }),
        ),
        fetch(
          `${base}${target.endpoint}`,
          csrfRequest(base, credentials, {
            method: target.method,
            token: "wrong-token",
          }),
        ),
        fetch(
          `${base}${target.endpoint}`,
          csrfRequest(base, credentials, {
            method: target.method,
            origin: "https://attacker.example",
          }),
        ),
        fetch(
          `${base}${target.endpoint}`,
          csrfRequest(base, credentials, {
            method: target.method,
            fetchSite: "cross-site",
          }),
        ),
      ]);

      for (const response of denials) {
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({ error: "FORBIDDEN" });
      }
    }
    expect(configureOwner).not.toHaveBeenCalled();
    expect(photonStart).not.toHaveBeenCalled();
    expect(chatGptStart).not.toHaveBeenCalled();
  });

  it("preserves authenticated Photon and ChatGPT onboarding through unit fakes", async () => {
    const photon = connectedPhotonSetup();
    const chatgpt = chatGptSetup();
    const base = await startTestServer({
      photonSetup: photon,
      chatgptSetup: chatgpt,
    });
    const credentials = (await login(base)).credentials!;

    const dashboard = await fetch(
      `${base}/agent/dashboard`,
      authenticatedRequest(credentials),
    );
    const html = await dashboard.text();
    expect(html).toContain(credentials.csrfToken);
    expect(html).not.toContain(SETUP_SECRET);

    const unexpectedStartBody = await fetch(
      `${base}/api/setup/photon/start`,
      csrfRequest(base, credentials, {
        body: JSON.stringify({ unexpected: true }),
      }),
    );
    expect(unexpectedStartBody.status).toBe(400);

    const photonStatus = await fetch(
      `${base}/api/setup/photon/status`,
      authenticatedRequest(credentials),
    );
    await expect(photonStatus.json()).resolves.toMatchObject({
      state: "connected",
      assignedPhoneNumber: ASSIGNED_NUMBER,
    });
    const chatGptStatus = await fetch(
      `${base}/api/setup/chatgpt/status`,
      authenticatedRequest(credentials),
    );
    await expect(chatGptStatus.json()).resolves.toEqual({
      state: "not_connected",
    });

    const chatGptStart = await fetch(
      `${base}/api/setup/chatgpt/start`,
      csrfRequest(base, credentials),
    );
    expect(chatGptStart.status).toBe(202);
    await expect(chatGptStart.json()).resolves.toMatchObject({
      state: "awaiting_authorization",
      userCode: CHATGPT_DEVICE_CODE,
    });
    const photonStart = await fetch(
      `${base}/api/setup/photon/start`,
      csrfRequest(base, credentials),
    );
    expect(photonStart.status).toBe(202);
    await expect(photonStart.json()).resolves.toMatchObject({
      state: "awaiting_authorization",
      userCode: PHOTON_DEVICE_CODE,
    });
  });

  it("revokes sessions on logout and rejects expired sessions", async () => {
    let now = 1_000;
    const base = await startTestServer({
      operatorAuthOptions: {
        now: () => now,
        sessionTtlMs: 500,
      },
    });
    const first = (await login(base)).credentials!;
    const unexpectedLogoutBody = await fetch(
      `${base}/api/operator/session`,
      csrfRequest(base, first, {
        method: "DELETE",
        body: JSON.stringify({ unexpected: true }),
      }),
    );
    expect(unexpectedLogoutBody.status).toBe(400);

    const logout = await fetch(`${base}/api/operator/session`, {
      method: "DELETE",
      headers: {
        cookie: first.cookie,
        origin: base,
        "x-csrf-token": first.csrfToken,
      },
    });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain(
      "agent_operator_session=;",
    );
    const revoked = await fetch(
      `${base}/api/setup/photon/status`,
      authenticatedRequest(first),
    );
    expect(revoked.status).toBe(401);

    const second = (await login(base)).credentials!;
    now += 501;
    const expired = await fetch(
      `${base}/api/setup/chatgpt/status`,
      authenticatedRequest(second),
    );
    expect(expired.status).toBe(401);
  });

  it("does not log setup secrets, sessions, CSRF tokens, or provider device codes", async () => {
    const captured: string[] = [];
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...values: unknown[]) => {
        captured.push(values.map((value) => String(value)).join(" "));
      });
    }
    const base = await startTestServer({
      photonSetup: connectedPhotonSetup(),
      chatgptSetup: chatGptSetup(),
    });
    const credentials = (await login(base)).credentials!;
    await fetch(
      `${base}/api/setup/owner`,
      csrfRequest(base, credentials, {
        body: JSON.stringify({ phoneNumber: OWNER_PHONE_NUMBER }),
      }),
    );
    await fetch(
      `${base}/api/setup/chatgpt/start`,
      csrfRequest(base, credentials),
    );
    await fetch(
      `${base}/api/setup/photon/start`,
      csrfRequest(base, credentials),
    );

    const output = captured.join("\n");
    const sessionId = credentials.cookie.slice(
      credentials.cookie.indexOf("=") + 1,
    );
    for (const privateValue of [
      SETUP_SECRET,
      sessionId,
      credentials.csrfToken,
      PHOTON_DEVICE_CODE,
      CHATGPT_DEVICE_CODE,
      OWNER_PHONE_NUMBER,
    ]) {
      expect(output).not.toContain(privateValue);
    }
  });

  it("bounds active server sessions and makes close and revocation idempotent", () => {
    const auth = createOperatorAuth({
      setupSecret: SETUP_SECRET,
      maximumActiveSessions: 2,
    });
    const first = auth.createSession();
    const second = auth.createSession();
    const third = auth.createSession();

    expect(auth.readSession(first.id)).toBeUndefined();
    expect(auth.readSession(second.id)).toBeDefined();
    expect(auth.readSession(third.id)).toBeDefined();
    auth.revokeSession(second.id);
    auth.revokeSession(second.id);
    expect(auth.readSession(second.id)).toBeUndefined();
    auth.close();
    auth.close();
    expect(auth.readSession(third.id)).toBeUndefined();
  });

  it("removes the legacy dashboard header from production HTTP source", async () => {
    const productionSources = await Promise.all([
      readFile(new URL("../../src/http/server.ts", import.meta.url), "utf8"),
      readFile(
        new URL("../../src/http/deployment-page.ts", import.meta.url),
        "utf8",
      ),
    ]);

    expect(productionSources.join("\n")).not.toContain("x-agent-setup");
  });
});

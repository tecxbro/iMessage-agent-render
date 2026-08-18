import { type Server } from "node:http";

import express, {
  type CookieOptions,
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response,
} from "express";

import type { ChatGptSetupController } from "../agent/codex-app-server-auth.js";
import {
  OwnerPhoneNumberValidationError,
  type DeploymentIdentityController,
} from "../runtime/deployment-identity.js";
import type { PhotonSetupController } from "../transport/photon-setup.js";
import {
  OPERATOR_SESSION_COOKIE,
  operatorSessionFromResponse,
  readOperatorSession,
  requireOperatorCsrf,
} from "./csrf.js";
import {
  renderDashboardScript,
  renderDeploymentPage,
  type DeploymentPageOptions,
} from "./deployment-page.js";
import type { OperatorAuth, OperatorSession } from "./operator-auth.js";
import {
  renderOperatorLoginPage,
  renderOperatorLoginScript,
} from "./operator-login-page.js";
import { PHOTON_LOGO_BASE64 } from "./photon-logo.js";
import {
  ReadinessRegistry,
  type SpectrumReadiness,
} from "./readiness.js";

export interface HealthApplicationOptions {
  readiness: ReadinessRegistry;
  operatorAuth: OperatorAuth;
  secureSessionCookie?: boolean;
  spectrum?: SpectrumReadiness;
  deploymentPage?: DeploymentPageOptions;
  deploymentIdentity?: DeploymentIdentityController;
  photonSetup?: PhotonSetupController;
  chatgptSetup?: ChatGptSetupController;
}

export interface HealthServer {
  readonly application: Express;
  readonly server: Server;
  close(): Promise<void>;
}

const LOGIN_ATTEMPT_LIMIT = 5;
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1_000;

class LoginAttemptLimiter {
  #failedAt: number[] = [];

  public isLimited(now = Date.now()): boolean {
    this.#removeExpired(now);
    return this.#failedAt.length >= LOGIN_ATTEMPT_LIMIT;
  }

  public recordFailure(now = Date.now()): void {
    this.#removeExpired(now);
    if (this.#failedAt.length < LOGIN_ATTEMPT_LIMIT) {
      this.#failedAt.push(now);
    }
  }

  public reset(): void {
    this.#failedAt = [];
  }

  #removeExpired(now: number): void {
    const cutoff = now - LOGIN_ATTEMPT_WINDOW_MS;
    this.#failedAt = this.#failedAt.filter((failedAt) => failedAt > cutoff);
  }
}

function sessionCookieOptions(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: "/",
  };
}

function setPrivateResponseHeaders(response: Response): void {
  response.set({
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
}

function sendUnauthorized(response: Response): void {
  response.set("cache-control", "no-store");
  response.status(401).json({ error: "UNAUTHORIZED" });
}

function requireReadSession(
  request: Request,
  response: Response,
  operatorAuth: OperatorAuth,
): OperatorSession | undefined {
  const session = readOperatorSession(request, operatorAuth);
  if (session === undefined) {
    sendUnauthorized(response);
  }
  return session;
}

function isExactObject(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function sendInvalidRequest(response: Response): void {
  response.set("cache-control", "no-store");
  response.status(400).json({ error: "INVALID_REQUEST" });
}

const jsonErrorHandler: ErrorRequestHandler = (
  error,
  _request,
  response,
  next,
) => {
  const errorType =
    error !== null && typeof error === "object" && "type" in error
      ? error.type
      : undefined;
  if (errorType === "entity.too.large") {
    response.set("cache-control", "no-store");
    response.status(413).json({ error: "REQUEST_TOO_LARGE" });
    return;
  }
  if (error instanceof SyntaxError) {
    sendInvalidRequest(response);
    return;
  }
  next(error);
};

export function createHealthApplication(
  options: HealthApplicationOptions,
): Express {
  const application = express();
  application.disable("x-powered-by");
  application.use(
    express.json({
      limit: "2kb",
      strict: true,
    }),
  );
  const secureSessionCookie = options.secureSessionCookie ?? false;
  const loginAttempts = new LoginAttemptLimiter();
  const csrf = requireOperatorCsrf({
    operatorAuth: options.operatorAuth,
    secureSessionCookie,
  });
  const chatGptStatus = () => {
    if (options.chatgptSetup !== undefined) {
      return options.chatgptSetup.status();
    }
    if (options.deploymentPage?.authMode === "api_key") {
      const snapshot = options.readiness.snapshot(options.spectrum?.snapshot());
      return snapshot.components.codexAuth.state === "ok"
        ? ({ state: "connected" } as const)
        : ({ state: "not_connected" } as const);
    }
    return { state: "not_connected" } as const;
  };

  application.get("/", (_request, response) => {
    response.set("cache-control", "no-store");
    response.redirect(302, "/agent/dashboard");
  });

  application.get("/agent/dashboard", (request, response) => {
    const session = readOperatorSession(request, options.operatorAuth);
    setPrivateResponseHeaders(response);
    if (session === undefined) {
      response.set(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      response.status(200).type("html").send(renderOperatorLoginPage());
      return;
    }

    const snapshot = options.readiness.snapshot(options.spectrum?.snapshot());
    response.set(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; font-src https://framerusercontent.com; img-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    response
      .status(200)
      .type("html")
      .send(
        renderDeploymentPage(
          snapshot,
          options.deploymentPage ?? {
            authMode: "chatgpt",
            runtimeMode: "foundation",
            supermemoryConfigured: false,
          },
          session.csrfToken,
          options.deploymentIdentity?.status() ?? {
            state: "not_configured",
          },
          options.photonSetup?.status() ?? { state: "not_connected" },
          chatGptStatus(),
        ),
      );
  });

  application.get("/agent/operator-login.js", (_request, response) => {
    response.set({
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    });
    response
      .status(200)
      .type("application/javascript")
      .send(renderOperatorLoginScript());
  });

  application.get("/agent/dashboard.js", (request, response) => {
    if (requireReadSession(request, response, options.operatorAuth) === undefined) {
      return;
    }
    response.set({
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    });
    response.status(200).type("application/javascript").send(renderDashboardScript());
  });

  application.get("/agent/photon-logo.png", (_request, response) => {
    response.set({
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": "image/png",
      "x-content-type-options": "nosniff",
    });
    response.status(200).send(Buffer.from(PHOTON_LOGO_BASE64, "base64"));
  });

  application.post("/api/operator/session", async (request, response) => {
    response.set("cache-control", "no-store");
    if (
      !isExactObject(request.body, ["password"]) ||
      typeof request.body["password"] !== "string"
    ) {
      sendInvalidRequest(response);
      return;
    }
    let password = request.body["password"];
    request.body["password"] = "";
    let authenticated = false;
    try {
      authenticated = await options.operatorAuth.authenticatePassword(password);
    } catch {
      response.status(503).json({ error: "OPERATOR_AUTH_UNAVAILABLE" });
      return;
    } finally {
      password = "";
    }
    if (!authenticated) {
      const wasLimited = loginAttempts.isLimited();
      loginAttempts.recordFailure();
      // Continue returning a stable throttled response for failures without
      // turning anonymous failures into an operator-wide availability attack.
      if (wasLimited || loginAttempts.isLimited()) {
        response.status(429).json({ error: "RATE_LIMITED" });
      } else {
        response.status(403).json({ error: "INVALID_PASSWORD" });
      }
      return;
    }

    loginAttempts.reset();
    let session: OperatorSession;
    try {
      session = options.operatorAuth.createSession();
    } catch {
      response.status(503).json({ error: "OPERATOR_SESSION_UNAVAILABLE" });
      return;
    }
    response.cookie(
      OPERATOR_SESSION_COOKIE,
      session.id,
      sessionCookieOptions(secureSessionCookie),
    );
    response.status(201).json({ csrfToken: session.csrfToken });
  });

  application.delete("/api/operator/session", csrf, (request, response) => {
    if (request.body !== undefined && !isExactObject(request.body, [])) {
      sendInvalidRequest(response);
      return;
    }
    const session = operatorSessionFromResponse(response);
    if (session !== undefined) {
      options.operatorAuth.revokeSession(session.id);
    }
    response.clearCookie(
      OPERATOR_SESSION_COOKIE,
      sessionCookieOptions(secureSessionCookie),
    );
    response.set("cache-control", "no-store");
    response.status(200).json({ success: true });
  });

  application.get("/api/setup/owner/status", (request, response) => {
    if (requireReadSession(request, response, options.operatorAuth) === undefined) {
      return;
    }
    response.set("cache-control", "no-store");
    const status = options.deploymentIdentity?.status();
    if (status?.state === "configured") {
      response.status(200).json({
        state: status.state,
        maskedPhoneNumber: status.maskedPhoneNumber,
      });
      return;
    }
    if (status?.state === "not_configured") {
      response.status(200).json({ state: status.state });
      return;
    }
    response.status(503).json({
      error:
        status?.state === "failed"
          ? status.code
          : "OWNER_IDENTITY_UNAVAILABLE",
    });
  });

  application.post("/api/setup/owner", csrf, async (request, response) => {
    response.set("cache-control", "no-store");
    if (!isExactObject(request.body, ["phoneNumber"])) {
      sendInvalidRequest(response);
      return;
    }
    if (typeof request.body["phoneNumber"] !== "string") {
      response.status(400).json({ error: "OWNER_PHONE_NUMBER_INVALID" });
      return;
    }
    if (options.deploymentIdentity === undefined) {
      response.status(503).json({
        error: "OWNER_IDENTITY_STORAGE_FAILED",
      });
      return;
    }
    try {
      const status = await options.deploymentIdentity.configureOwner(
        request.body["phoneNumber"],
      );
      if (status.state === "configured") {
        response.status(200).json({
          state: status.state,
          maskedPhoneNumber: status.maskedPhoneNumber,
        });
        return;
      }
      response.status(503).json({
        error: "OWNER_IDENTITY_STORAGE_FAILED",
      });
    } catch (error) {
      if (error instanceof OwnerPhoneNumberValidationError) {
        response.status(400).json({ error: error.code });
        return;
      }
      response.status(503).json({
        error: "OWNER_IDENTITY_STORAGE_FAILED",
      });
    }
  });

  application.post("/api/setup/photon/start", csrf, async (request, response) => {
    response.set("cache-control", "no-store");
    if (!isExactObject(request.body, [])) {
      sendInvalidRequest(response);
      return;
    }
    if (options.photonSetup === undefined) {
      response.status(503).json({
        state: "failed",
        code: "PHOTON_SETUP_UNAVAILABLE",
      });
      return;
    }
    try {
      const status = await options.photonSetup.start();
      response
        .status(
          status.state === "failed"
            ? 502
            : status.state === "connected"
              ? 200
              : 202,
        )
        .json(status);
    } catch {
      response.status(502).json({
        state: "failed",
        code: "PHOTON_SETUP_FAILED",
      });
    }
  });

  application.get("/api/setup/photon/status", (request, response) => {
    if (requireReadSession(request, response, options.operatorAuth) === undefined) {
      return;
    }
    response.set("cache-control", "no-store");
    response.status(200).json(
      options.photonSetup?.status() ?? { state: "not_connected" },
    );
  });

  application.post("/api/setup/chatgpt/start", csrf, async (request, response) => {
    response.set("cache-control", "no-store");
    if (!isExactObject(request.body, [])) {
      sendInvalidRequest(response);
      return;
    }
    const snapshot = options.readiness.snapshot(options.spectrum?.snapshot());
    const photonConnected =
      options.photonSetup === undefined ||
      options.photonSetup.status().state === "connected";
    if (
      options.chatgptSetup === undefined ||
      snapshot.components.disk.state !== "ok" ||
      !photonConnected
    ) {
      response.status(503).json({
        state: "failed",
        code: "CHATGPT_SETUP_UNAVAILABLE",
      });
      return;
    }
    try {
      const status = await options.chatgptSetup.start();
      response
        .status(
          status.state === "failed"
            ? 502
            : status.state === "connected"
              ? 200
              : 202,
        )
        .json(status);
    } catch {
      response.status(502).json({
        state: "failed",
        code: "CHATGPT_SETUP_UNAVAILABLE",
      });
    }
  });

  application.get("/api/setup/chatgpt/status", (request, response) => {
    if (requireReadSession(request, response, options.operatorAuth) === undefined) {
      return;
    }
    response.set("cache-control", "no-store");
    response.status(200).json(chatGptStatus());
  });

  application.get("/healthz", (_request, response) => {
    response.set("cache-control", "no-store");
    response.status(200).json({ status: "ok" });
  });

  application.get("/readyz", (request, response) => {
    const snapshot = options.readiness.snapshot(options.spectrum?.snapshot());
    response.set("cache-control", "no-store");
    const session = readOperatorSession(request, options.operatorAuth);
    response
      .status(snapshot.ready ? 200 : 503)
      .json(
        session === undefined
          ? { status: snapshot.status, ready: snapshot.ready }
          : snapshot,
      );
  });

  application.use(jsonErrorHandler);
  return application;
}

export async function startHealthServer(input: {
  port: number;
  host?: string;
  readiness: ReadinessRegistry;
  operatorAuth: OperatorAuth;
  secureSessionCookie?: boolean;
  spectrum?: SpectrumReadiness;
  deploymentPage?: DeploymentPageOptions;
  deploymentIdentity?: DeploymentIdentityController;
  photonSetup?: PhotonSetupController;
  chatgptSetup?: ChatGptSetupController;
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

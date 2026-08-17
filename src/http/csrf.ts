import type { Request, RequestHandler, Response } from "express";

import {
  constantTimeCsrfTokenEqual,
  type OperatorAuth,
  type OperatorSession,
} from "./operator-auth.js";

export const OPERATOR_SESSION_COOKIE = "agent_operator_session";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const ALLOWED_FETCH_SITES = new Set(["same-origin", "same-site", "none"]);

function sessionIdFromCookieHeader(header: string | undefined): string | undefined {
  if (header === undefined || header.length > 8_192) {
    return undefined;
  }
  let sessionId: string | undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) {
      continue;
    }
    if (part.slice(0, separator).trim() !== OPERATOR_SESSION_COOKIE) {
      continue;
    }
    if (sessionId !== undefined) {
      return undefined;
    }
    const value = part.slice(separator + 1).trim();
    if (!SESSION_ID_PATTERN.test(value)) {
      return undefined;
    }
    sessionId = value;
  }
  return sessionId;
}

export function readOperatorSession(
  request: Request,
  operatorAuth: OperatorAuth,
): OperatorSession | undefined {
  const sessionId = sessionIdFromCookieHeader(request.get("cookie"));
  return sessionId === undefined
    ? undefined
    : operatorAuth.readSession(sessionId);
}

function requestTargetOrigin(
  request: Request,
  secureSessionCookie: boolean,
): string | undefined {
  const host = request.get("host");
  if (host === undefined || host.length > 512) {
    return undefined;
  }
  try {
    return new URL(
      `${secureSessionCookie ? "https" : request.protocol}://${host}`,
    ).origin;
  } catch {
    return undefined;
  }
}

function hasSameOrigin(
  request: Request,
  secureSessionCookie: boolean,
): boolean {
  const submittedOrigin = request.get("origin");
  const targetOrigin = requestTargetOrigin(request, secureSessionCookie);
  if (submittedOrigin === undefined || targetOrigin === undefined) {
    return false;
  }
  try {
    return new URL(submittedOrigin).origin === targetOrigin;
  } catch {
    return false;
  }
}

function hasAllowedFetchSite(request: Request): boolean {
  const fetchSite = request.get("sec-fetch-site");
  return fetchSite === undefined || ALLOWED_FETCH_SITES.has(fetchSite);
}

export function sendForbidden(response: Response): void {
  response.set("cache-control", "no-store");
  response.status(403).json({ error: "FORBIDDEN" });
}

export function requireOperatorCsrf(options: {
  operatorAuth: OperatorAuth;
  secureSessionCookie: boolean;
}): RequestHandler {
  return (request, response, next) => {
    const session = readOperatorSession(request, options.operatorAuth);
    const submittedToken = request.get("x-csrf-token");
    if (
      session === undefined ||
      submittedToken === undefined ||
      !constantTimeCsrfTokenEqual(submittedToken, session.csrfToken) ||
      !hasSameOrigin(request, options.secureSessionCookie) ||
      !hasAllowedFetchSite(request)
    ) {
      sendForbidden(response);
      return;
    }
    response.locals["operatorSession"] = session;
    next();
  };
}

export function operatorSessionFromResponse(
  response: Response,
): OperatorSession | undefined {
  const value = response.locals["operatorSession"];
  if (
    value === null ||
    typeof value !== "object" ||
    !("id" in value) ||
    !("csrfToken" in value)
  ) {
    return undefined;
  }
  return value as OperatorSession;
}

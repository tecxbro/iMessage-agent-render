import {
  createHash,
  randomBytes as createRandomBytes,
  timingSafeEqual,
} from "node:crypto";

export interface OperatorSession {
  id: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
}

export interface OperatorAuth {
  authenticateSetupSecret(secret: string): boolean;
  createSession(): OperatorSession;
  readSession(sessionId: string): OperatorSession | undefined;
  revokeSession(sessionId: string): void;
  close(): void;
}

export interface OperatorAuthOptions {
  setupSecret: string;
  sessionTtlMs?: number;
  maximumActiveSessions?: number;
  failedAttemptLimit?: number;
  failedAttemptWindowMs?: number;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
}

const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const DEFAULT_MAXIMUM_ACTIVE_SESSIONS = 8;
const DEFAULT_FAILED_ATTEMPT_LIMIT = 5;
const DEFAULT_FAILED_ATTEMPT_WINDOW_MS = 15 * 60 * 1_000;
const RANDOM_VALUE_BYTES = 32;

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function secretDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function constantTimeTextEqual(left: string, rightDigest: Buffer): boolean {
  return timingSafeEqual(secretDigest(left), rightDigest);
}

function cloneSession(session: OperatorSession): OperatorSession {
  return { ...session };
}

class InMemoryOperatorAuth implements OperatorAuth {
  readonly #setupSecretDigest: Buffer;
  readonly #sessionTtlMs: number;
  readonly #maximumActiveSessions: number;
  readonly #failedAttemptLimit: number;
  readonly #failedAttemptWindowMs: number;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #sessions = new Map<string, OperatorSession>();
  readonly #cleanupTimer: NodeJS.Timeout;
  #failedAttemptTimes: number[] = [];
  #closed = false;

  public constructor(options: OperatorAuthOptions) {
    if (
      typeof options.setupSecret !== "string" ||
      Buffer.byteLength(options.setupSecret.trim(), "utf8") < 32
    ) {
      throw new Error(
        "DASHBOARD_SETUP_SECRET must contain at least 32 bytes of secret material.",
      );
    }
    this.#setupSecretDigest = secretDigest(options.setupSecret);
    this.#sessionTtlMs = positiveInteger(
      options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
      "sessionTtlMs",
    );
    this.#maximumActiveSessions = positiveInteger(
      options.maximumActiveSessions ?? DEFAULT_MAXIMUM_ACTIVE_SESSIONS,
      "maximumActiveSessions",
    );
    this.#failedAttemptLimit = positiveInteger(
      options.failedAttemptLimit ?? DEFAULT_FAILED_ATTEMPT_LIMIT,
      "failedAttemptLimit",
    );
    this.#failedAttemptWindowMs = positiveInteger(
      options.failedAttemptWindowMs ?? DEFAULT_FAILED_ATTEMPT_WINDOW_MS,
      "failedAttemptWindowMs",
    );
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? createRandomBytes;

    const cleanupIntervalMs = Math.min(this.#sessionTtlMs, 60_000);
    this.#cleanupTimer = setInterval(
      () => this.#removeExpiredSessions(this.#now()),
      cleanupIntervalMs,
    );
    this.#cleanupTimer.unref();
  }

  public authenticateSetupSecret(secret: string): boolean {
    if (this.#closed || typeof secret !== "string") {
      return false;
    }
    const now = this.#now();
    this.#removeExpiredFailures(now);
    const authenticated = constantTimeTextEqual(
      secret,
      this.#setupSecretDigest,
    );
    if (authenticated) {
      // A correct high-entropy secret is not a failed attempt. Let it clear the
      // failure window so anonymous failures cannot lock out the operator.
      this.#failedAttemptTimes = [];
      return true;
    }

    if (this.#failedAttemptTimes.length < this.#failedAttemptLimit) {
      this.#failedAttemptTimes.push(now);
    }
    return false;
  }

  public createSession(): OperatorSession {
    if (this.#closed) {
      throw new Error("Operator authentication is closed.");
    }
    const now = this.#now();
    this.#removeExpiredSessions(now);
    while (this.#sessions.size >= this.#maximumActiveSessions) {
      const oldestSessionId = this.#sessions.keys().next().value as
        | string
        | undefined;
      if (oldestSessionId === undefined) {
        break;
      }
      this.#sessions.delete(oldestSessionId);
    }

    let id: string;
    do {
      id = Buffer.from(this.#randomBytes(RANDOM_VALUE_BYTES)).toString(
        "base64url",
      );
    } while (this.#sessions.has(id));
    const session = {
      id,
      csrfToken: Buffer.from(this.#randomBytes(RANDOM_VALUE_BYTES)).toString(
        "base64url",
      ),
      createdAt: now,
      expiresAt: now + this.#sessionTtlMs,
    } satisfies OperatorSession;
    this.#sessions.set(id, session);
    return cloneSession(session);
  }

  public readSession(sessionId: string): OperatorSession | undefined {
    if (this.#closed || typeof sessionId !== "string") {
      return undefined;
    }
    const now = this.#now();
    this.#removeExpiredSessions(now);
    const session = this.#sessions.get(sessionId);
    return session === undefined ? undefined : cloneSession(session);
  }

  public revokeSession(sessionId: string): void {
    if (typeof sessionId === "string") {
      this.#sessions.delete(sessionId);
    }
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    clearInterval(this.#cleanupTimer);
    this.#sessions.clear();
    this.#failedAttemptTimes = [];
  }

  #removeExpiredSessions(now: number): void {
    for (const [sessionId, session] of this.#sessions) {
      if (session.expiresAt <= now) {
        this.#sessions.delete(sessionId);
      }
    }
  }

  #removeExpiredFailures(now: number): void {
    const cutoff = now - this.#failedAttemptWindowMs;
    this.#failedAttemptTimes = this.#failedAttemptTimes.filter(
      (attemptedAt) => attemptedAt > cutoff,
    );
  }
}

export function createOperatorAuth(
  options: OperatorAuthOptions,
): OperatorAuth {
  return new InMemoryOperatorAuth(options);
}

export function constantTimeCsrfTokenEqual(
  submittedToken: string,
  expectedToken: string,
): boolean {
  return constantTimeTextEqual(submittedToken, secretDigest(expectedToken));
}

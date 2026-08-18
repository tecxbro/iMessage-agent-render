import {
  createHash,
  randomBytes as createRandomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

export interface OperatorSession {
  id: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
}

export interface OperatorAuth {
  authenticatePassword(password: string): Promise<boolean>;
  createSession(): OperatorSession;
  readSession(sessionId: string): OperatorSession | undefined;
  revokeSession(sessionId: string): void;
  close(): void;
}

export interface OperatorAuthOptions {
  password: string;
  sessionTtlMs?: number;
  maximumActiveSessions?: number;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
}

const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const DEFAULT_MAXIMUM_ACTIVE_SESSIONS = 8;
const RANDOM_VALUE_BYTES = 32;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_VERIFIER_BYTES = 64;

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function textDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function constantTimeTextEqual(left: string, rightDigest: Buffer): boolean {
  return timingSafeEqual(textDigest(left), rightDigest);
}

function derivePasswordVerifier(
  password: Buffer,
  salt: Buffer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, PASSWORD_VERIFIER_BYTES, (error, derivedKey) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

function cloneSession(session: OperatorSession): OperatorSession {
  return { ...session };
}

class InMemoryOperatorAuth implements OperatorAuth {
  readonly #passwordSalt: Buffer;
  readonly #passwordVerifier: Buffer;
  readonly #sessionTtlMs: number;
  readonly #maximumActiveSessions: number;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #sessions = new Map<string, OperatorSession>();
  readonly #cleanupTimer: NodeJS.Timeout;
  #closed = false;

  public constructor(
    options: Omit<OperatorAuthOptions, "password">,
    passwordSalt: Buffer,
    passwordVerifier: Buffer,
  ) {
    this.#passwordSalt = passwordSalt;
    this.#passwordVerifier = passwordVerifier;
    this.#sessionTtlMs = positiveInteger(
      options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
      "sessionTtlMs",
    );
    this.#maximumActiveSessions = positiveInteger(
      options.maximumActiveSessions ?? DEFAULT_MAXIMUM_ACTIVE_SESSIONS,
      "maximumActiveSessions",
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

  public async authenticatePassword(password: string): Promise<boolean> {
    if (this.#closed || typeof password !== "string") {
      return false;
    }
    const submittedPassword = Buffer.from(password, "utf8");
    password = "";
    let submittedVerifier: Buffer | undefined;
    try {
      submittedVerifier = await derivePasswordVerifier(
        submittedPassword,
        this.#passwordSalt,
      );
      return timingSafeEqual(submittedVerifier, this.#passwordVerifier);
    } finally {
      submittedPassword.fill(0);
      submittedVerifier?.fill(0);
    }
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
    this.#passwordSalt.fill(0);
    this.#passwordVerifier.fill(0);
  }

  #removeExpiredSessions(now: number): void {
    for (const [sessionId, session] of this.#sessions) {
      if (session.expiresAt <= now) {
        this.#sessions.delete(sessionId);
      }
    }
  }
}

export async function createOperatorAuth(
  options: OperatorAuthOptions,
): Promise<OperatorAuth> {
  if (
    typeof options.password !== "string" ||
    [...options.password].length < 15 ||
    [...options.password].length > 128
  ) {
    throw new Error("Operator password must contain 15 to 128 characters.");
  }
  const randomBytes = options.randomBytes ?? createRandomBytes;
  const passwordSalt = Buffer.from(randomBytes(PASSWORD_SALT_BYTES));
  const configuredPassword = Buffer.from(options.password, "utf8");
  let passwordVerifier: Buffer;
  try {
    passwordVerifier = await derivePasswordVerifier(
      configuredPassword,
      passwordSalt,
    );
  } finally {
    configuredPassword.fill(0);
  }
  return new InMemoryOperatorAuth(options, passwordSalt, passwordVerifier);
}

export function constantTimeCsrfTokenEqual(
  submittedToken: string,
  expectedToken: string,
): boolean {
  return constantTimeTextEqual(submittedToken, textDigest(expectedToken));
}

import {
  randomBytes,
  randomInt,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

import { and, count, eq, gte, gt, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import {
  channelIdentities,
  deployments,
  owners,
  pairingAttempts,
  pairingChallenges,
} from "../db/schema.js";
import type { InboundTextForAuthorization } from "../transport/message-loop.js";
import type { UnknownSenderPairing } from "./authorize-sender.js";

const scrypt = promisify(scryptCallback);
const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1_000;
const pairingCredentialPattern = /^\/pair\s+([a-f0-9-]{36})\.([0-9]{8})$/iu;

export interface PairingChallengeRecord {
  id: string;
  deploymentId: string;
  ownerId: string;
  role: "collaborator";
  salt: string;
  codeHash: string;
  status: "pending" | "consumed" | "expired";
  expiresAt: Date;
  createdAt: Date;
}

export interface PairingAttempt {
  deploymentId: string;
  handleFingerprint: string;
  now: Date;
  handleLimit: number;
  deploymentLimit: number;
  windowMs: number;
}

export interface ConsumePairingInput {
  challengeId: string;
  deploymentId: string;
  ownerId: string;
  handleFingerprint: string;
  normalizedHandleCiphertext: string;
  expectedCodeHash: string;
  role: "collaborator";
  now: Date;
}

/** Persistent implementations must make attempt registration and consume atomic. */
export interface PairingStore {
  create(record: PairingChallengeRecord): Promise<void>;
  find(challengeId: string, deploymentId: string): Promise<PairingChallengeRecord | undefined>;
  registerAttempt(input: PairingAttempt): Promise<boolean>;
  consumeAndCreateIdentity(input: ConsumePairingInput): Promise<boolean>;
  expire(challengeId: string, deploymentId: string, now: Date): Promise<void>;
}

export class DatabasePairingStore implements PairingStore {
  public constructor(private readonly database: Database) {}

  public async create(record: PairingChallengeRecord): Promise<void> {
    await this.database.insert(pairingChallenges).values({
      id: record.id,
      deploymentId: record.deploymentId,
      ownerId: record.ownerId,
      role: record.role,
      salt: record.salt,
      codeHash: record.codeHash,
      status: record.status,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      updatedAt: record.createdAt,
    });
  }

  public async find(
    challengeId: string,
    deploymentId: string,
  ): Promise<PairingChallengeRecord | undefined> {
    const [row] = await this.database
      .select({
        id: pairingChallenges.id,
        deploymentId: pairingChallenges.deploymentId,
        ownerId: pairingChallenges.ownerId,
        role: pairingChallenges.role,
        salt: pairingChallenges.salt,
        codeHash: pairingChallenges.codeHash,
        status: pairingChallenges.status,
        expiresAt: pairingChallenges.expiresAt,
        createdAt: pairingChallenges.createdAt,
      })
      .from(pairingChallenges)
      .where(
        and(
          eq(pairingChallenges.id, challengeId),
          eq(pairingChallenges.deploymentId, deploymentId),
        ),
      )
      .limit(1);
    if (row === undefined || row.role !== "collaborator") {
      return undefined;
    }
    return { ...row, role: "collaborator" };
  }

  public async registerAttempt(input: PairingAttempt): Promise<boolean> {
    const cutoff = new Date(input.now.getTime() - input.windowMs);
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${input.deploymentId}:pairing`}, 0))`,
      );
      const [handleCount] = await transaction
        .select({ value: count() })
        .from(pairingAttempts)
        .where(
          and(
            eq(pairingAttempts.deploymentId, input.deploymentId),
            eq(pairingAttempts.handleFingerprint, input.handleFingerprint),
            gte(pairingAttempts.attemptedAt, cutoff),
          ),
        );
      const [deploymentCount] = await transaction
        .select({ value: count() })
        .from(pairingAttempts)
        .where(
          and(
            eq(pairingAttempts.deploymentId, input.deploymentId),
            gte(pairingAttempts.attemptedAt, cutoff),
          ),
        );
      if (
        (handleCount?.value ?? 0) >= input.handleLimit ||
        (deploymentCount?.value ?? 0) >= input.deploymentLimit
      ) {
        return false;
      }
      await transaction.insert(pairingAttempts).values({
        id: randomUUID(),
        deploymentId: input.deploymentId,
        handleFingerprint: input.handleFingerprint,
        attemptedAt: input.now,
      });
      return true;
    });
  }

  public async consumeAndCreateIdentity(
    input: ConsumePairingInput,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${input.deploymentId}:${input.challengeId}`}, 0))`,
      );
      const [challenge] = await transaction
        .select({ id: pairingChallenges.id })
        .from(pairingChallenges)
        .innerJoin(owners, eq(owners.id, pairingChallenges.ownerId))
        .innerJoin(
          deployments,
          eq(deployments.id, pairingChallenges.deploymentId),
        )
        .where(
          and(
            eq(pairingChallenges.id, input.challengeId),
            eq(pairingChallenges.deploymentId, input.deploymentId),
            eq(pairingChallenges.ownerId, input.ownerId),
            eq(pairingChallenges.role, input.role),
            eq(pairingChallenges.codeHash, input.expectedCodeHash),
            eq(pairingChallenges.status, "pending"),
            gt(pairingChallenges.expiresAt, input.now),
            eq(owners.status, "active"),
            eq(deployments.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (challenge === undefined) {
        return false;
      }
      const inserted = await transaction
        .insert(channelIdentities)
        .values({
          id: randomUUID(),
          deploymentId: input.deploymentId,
          ownerId: input.ownerId,
          platform: "imessage",
          normalizedHandleCiphertext: input.normalizedHandleCiphertext,
          handleFingerprint: input.handleFingerprint,
          role: "collaborator",
          verifiedAt: input.now,
        })
        .onConflictDoNothing()
        .returning({ id: channelIdentities.id });
      if (inserted.length !== 1) {
        return false;
      }
      const consumed = await transaction
        .update(pairingChallenges)
        .set({ status: "consumed", consumedAt: input.now, updatedAt: input.now })
        .where(
          and(
            eq(pairingChallenges.id, input.challengeId),
            eq(pairingChallenges.status, "pending"),
          ),
        )
        .returning({ id: pairingChallenges.id });
      return consumed.length === 1;
    });
  }

  public async expire(
    challengeId: string,
    deploymentId: string,
    now: Date,
  ): Promise<void> {
    await this.database
      .update(pairingChallenges)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          eq(pairingChallenges.id, challengeId),
          eq(pairingChallenges.deploymentId, deploymentId),
          eq(pairingChallenges.status, "pending"),
        ),
      );
  }
}

export interface PairingServiceOptions {
  mode: "off" | "on";
  deploymentId: string;
  ownerId: string;
  pepper: string | Uint8Array;
  store: PairingStore;
  ttlMs?: number;
  handleAttemptLimit?: number;
  deploymentAttemptLimit?: number;
  attemptWindowMs?: number;
  now?: () => Date;
  encryptHandle(normalizedHandle: string): Promise<string>;
}

export interface CreatedPairingChallenge {
  /** One-time secret. Show only in the protected operator channel. */
  credential: string;
  expiresAt: Date;
}

function requirePepper(pepper: string | Uint8Array): Uint8Array {
  const bytes = typeof pepper === "string" ? Buffer.from(pepper, "utf8") : pepper;
  if (bytes.byteLength < 32) {
    throw new Error("Pairing pepper must contain at least 32 secret bytes.");
  }
  return bytes;
}

async function hashPairingCode(
  code: string,
  salt: string,
  pepper: Uint8Array,
): Promise<string> {
  const derived = (await scrypt(
    Buffer.concat([Buffer.from(code, "utf8"), Buffer.from(pepper)]),
    Buffer.from(salt, "base64url"),
    32,
  )) as Buffer;
  return derived.toString("hex");
}

function safeHashEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export class PairingService {
  private readonly pepper: Uint8Array;
  private readonly ttlMs: number;
  private readonly handleAttemptLimit: number;
  private readonly deploymentAttemptLimit: number;
  private readonly attemptWindowMs: number;

  public constructor(private readonly options: PairingServiceOptions) {
    this.pepper = requirePepper(options.pepper);
    this.ttlMs = options.ttlMs ?? DEFAULT_PAIRING_TTL_MS;
    this.handleAttemptLimit = options.handleAttemptLimit ?? 5;
    this.deploymentAttemptLimit = options.deploymentAttemptLimit ?? 50;
    this.attemptWindowMs = options.attemptWindowMs ?? DEFAULT_PAIRING_TTL_MS;
    for (const value of [
      this.ttlMs,
      this.handleAttemptLimit,
      this.deploymentAttemptLimit,
      this.attemptWindowMs,
    ]) {
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("Pairing expiry and attempt limits must be positive integers.");
      }
    }
  }

  public async createChallenge(
    operatorAuthorized: boolean,
  ): Promise<CreatedPairingChallenge> {
    if (this.options.mode !== "on" || !operatorAuthorized) {
      throw new Error(
        "Pairing challenge creation requires enabled pairing and an authenticated operator channel.",
      );
    }
    const now = this.options.now?.() ?? new Date();
    const challengeId = randomUUID();
    const code = randomInt(0, 100_000_000).toString().padStart(8, "0");
    const salt = randomBytes(16).toString("base64url");
    const codeHash = await hashPairingCode(code, salt, this.pepper);
    const expiresAt = new Date(now.getTime() + this.ttlMs);
    await this.options.store.create({
      id: challengeId,
      deploymentId: this.options.deploymentId,
      ownerId: this.options.ownerId,
      role: "collaborator",
      salt,
      codeHash,
      status: "pending",
      expiresAt,
      createdAt: now,
    });
    return { credential: `${challengeId}.${code}`, expiresAt };
  }

  public async tryConsume(
    credential: string,
    handleFingerprint: string,
    normalizedHandle: string,
  ): Promise<boolean> {
    if (this.options.mode !== "on") {
      return false;
    }
    const match = /^([a-f0-9-]{36})\.([0-9]{8})$/iu.exec(credential.trim());
    if (match?.[1] === undefined || match[2] === undefined) {
      return false;
    }
    const now = this.options.now?.() ?? new Date();
    const attemptAllowed = await this.options.store.registerAttempt({
      deploymentId: this.options.deploymentId,
      handleFingerprint,
      now,
      handleLimit: this.handleAttemptLimit,
      deploymentLimit: this.deploymentAttemptLimit,
      windowMs: this.attemptWindowMs,
    });
    if (!attemptAllowed) {
      return false;
    }

    const record = await this.options.store.find(
      match[1],
      this.options.deploymentId,
    );
    if (
      record === undefined ||
      record.status !== "pending" ||
      record.expiresAt.getTime() <= now.getTime()
    ) {
      if (record?.status === "pending") {
        await this.options.store.expire(record.id, record.deploymentId, now);
      }
      return false;
    }
    const candidateHash = await hashPairingCode(match[2], record.salt, this.pepper);
    if (!safeHashEqual(candidateHash, record.codeHash)) {
      return false;
    }
    const normalizedHandleCiphertext = await this.options.encryptHandle(
      normalizedHandle,
    );
    return this.options.store.consumeAndCreateIdentity({
      challengeId: record.id,
      deploymentId: record.deploymentId,
      ownerId: record.ownerId,
      handleFingerprint,
      normalizedHandleCiphertext,
      expectedCodeHash: record.codeHash,
      role: "collaborator",
      now,
    });
  }
}

/** Pairing is intercepted before persistence/model work and accepts only `/pair`. */
export class PairingCommandHandler implements UnknownSenderPairing {
  public constructor(private readonly service: PairingService) {}

  public async tryPair(
    inbound: InboundTextForAuthorization,
    handleFingerprint: string,
  ): Promise<boolean> {
    const match = pairingCredentialPattern.exec(inbound.text.trim());
    if (match?.[1] === undefined || match[2] === undefined) {
      return false;
    }
    return this.service.tryConsume(
      `${match[1]}.${match[2]}`,
      handleFingerprint,
      inbound.sender.address,
    );
  }
}

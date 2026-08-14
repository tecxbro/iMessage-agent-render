import { describe, expect, it } from "vitest";

import {
  PairingService,
  type ConsumePairingInput,
  type PairingAttempt,
  type PairingChallengeRecord,
  type PairingStore,
} from "../../src/security/pairing.js";

const deploymentId = "00000000-0000-4000-8000-000000000001";
const ownerId = "00000000-0000-4000-8000-000000000002";

class MemoryPairingStore implements PairingStore {
  public readonly challenges = new Map<string, PairingChallengeRecord>();
  public readonly attempts: Array<{
    deploymentId: string;
    handleFingerprint: string;
    at: Date;
  }> = [];
  public readonly identities = new Map<string, ConsumePairingInput>();

  public async create(record: PairingChallengeRecord): Promise<void> {
    this.challenges.set(record.id, structuredClone(record));
  }

  public async find(
    challengeId: string,
    requestedDeploymentId: string,
  ): Promise<PairingChallengeRecord | undefined> {
    const record = this.challenges.get(challengeId);
    return record?.deploymentId === requestedDeploymentId
      ? structuredClone(record)
      : undefined;
  }

  public async registerAttempt(input: PairingAttempt): Promise<boolean> {
    const cutoff = input.now.getTime() - input.windowMs;
    const deploymentAttempts = this.attempts.filter(
      (attempt) =>
        attempt.deploymentId === input.deploymentId &&
        attempt.at.getTime() >= cutoff,
    );
    const handleAttempts = deploymentAttempts.filter(
      (attempt) => attempt.handleFingerprint === input.handleFingerprint,
    );
    if (
      handleAttempts.length >= input.handleLimit ||
      deploymentAttempts.length >= input.deploymentLimit
    ) {
      return false;
    }
    this.attempts.push({
      deploymentId: input.deploymentId,
      handleFingerprint: input.handleFingerprint,
      at: input.now,
    });
    return true;
  }

  public async consumeAndCreateIdentity(input: ConsumePairingInput): Promise<boolean> {
    const record = this.challenges.get(input.challengeId);
    if (
      record === undefined ||
      record.status !== "pending" ||
      record.deploymentId !== input.deploymentId ||
      record.ownerId !== input.ownerId ||
      record.codeHash !== input.expectedCodeHash ||
      record.expiresAt <= input.now ||
      this.identities.has(input.handleFingerprint)
    ) {
      return false;
    }
    record.status = "consumed";
    this.identities.set(input.handleFingerprint, structuredClone(input));
    return true;
  }

  public async expire(
    challengeId: string,
    requestedDeploymentId: string,
    now: Date,
  ): Promise<void> {
    const record = this.challenges.get(challengeId);
    if (
      record?.deploymentId === requestedDeploymentId &&
      record.status === "pending" &&
      record.expiresAt <= now
    ) {
      record.status = "expired";
    }
  }
}

function service(
  store: MemoryPairingStore,
  options: {
    mode?: "off" | "on";
    now?: () => Date;
    handleAttemptLimit?: number;
    deploymentAttemptLimit?: number;
    ttlMs?: number;
  } = {},
) {
  return new PairingService({
    mode: options.mode ?? "on",
    deploymentId,
    ownerId,
    pepper: "pairing-pepper-with-at-least-thirty-two-secret-bytes",
    store,
    encryptHandle: async (handle) => `encrypted:${handle}`,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.handleAttemptLimit === undefined
      ? {}
      : { handleAttemptLimit: options.handleAttemptLimit }),
    ...(options.deploymentAttemptLimit === undefined
      ? {}
      : { deploymentAttemptLimit: options.deploymentAttemptLimit }),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  });
}

function wrongCredential(credential: string): string {
  const last = credential.at(-1);
  return `${credential.slice(0, -1)}${last === "0" ? "1" : "0"}`;
}

describe("optional single-use pairing", () => {
  it("creates codes only through an authenticated operator path and stores only a salted hash", async () => {
    const store = new MemoryPairingStore();
    const pairing = service(store);
    await expect(pairing.createChallenge(false)).rejects.toThrow(
      /authenticated operator channel/,
    );
    const created = await pairing.createChallenge(true);
    const [challengeId, code] = created.credential.split(".");
    const stored = store.challenges.get(challengeId!);
    expect(code).toMatch(/^\d{8}$/u);
    expect(stored?.codeHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(stored?.codeHash).not.toContain(code);
    expect(JSON.stringify(stored)).not.toContain(code);
    expect(stored?.role).toBe("collaborator");
  });

  it("binds a successful code to the observed handle and rejects replay", async () => {
    const store = new MemoryPairingStore();
    const pairing = service(store);
    const created = await pairing.createChallenge(true);

    await expect(
      pairing.tryConsume(created.credential, "fingerprint-a", "new@example.com"),
    ).resolves.toBe(true);
    expect(store.identities.get("fingerprint-a")).toMatchObject({
      ownerId,
      deploymentId,
      role: "collaborator",
      normalizedHandleCiphertext: "encrypted:new@example.com",
    });
    await expect(
      pairing.tryConsume(created.credential, "fingerprint-b", "other@example.com"),
    ).resolves.toBe(false);
    expect(store.identities.has("fingerprint-b")).toBe(false);
  });

  it("blocks brute force per handle before a later correct guess", async () => {
    const store = new MemoryPairingStore();
    const pairing = service(store, {
      handleAttemptLimit: 2,
      deploymentAttemptLimit: 10,
    });
    const created = await pairing.createChallenge(true);
    const wrong = wrongCredential(created.credential);
    await expect(pairing.tryConsume(wrong, "attacker", "attacker@example.com")).resolves.toBe(false);
    await expect(pairing.tryConsume(wrong, "attacker", "attacker@example.com")).resolves.toBe(false);
    await expect(
      pairing.tryConsume(created.credential, "attacker", "attacker@example.com"),
    ).resolves.toBe(false);
    expect(store.identities.size).toBe(0);
  });

  it("rejects expired codes and every code while pairing mode is off", async () => {
    let now = new Date("2026-08-14T12:00:00Z");
    const store = new MemoryPairingStore();
    const pairing = service(store, { now: () => now, ttlMs: 1_000 });
    const created = await pairing.createChallenge(true);
    now = new Date("2026-08-14T12:00:02Z");
    await expect(
      pairing.tryConsume(created.credential, "late", "late@example.com"),
    ).resolves.toBe(false);
    expect([...store.challenges.values()][0]?.status).toBe("expired");

    const off = service(new MemoryPairingStore(), { mode: "off" });
    await expect(off.createChallenge(true)).rejects.toThrow();
    await expect(
      off.tryConsume(created.credential, "unknown", "unknown@example.com"),
    ).resolves.toBe(false);
  });
});

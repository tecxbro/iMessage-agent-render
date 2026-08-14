import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { z } from "zod";

import {
  actionTypeSchema,
  jsonValueSchema,
  proposedActionSchema,
  type ActionType,
  type JsonValue,
  type ProposedAction,
} from "./action-schema.js";
import type { SenderRole } from "./authorize-sender.js";

const ACTION_HASH_DOMAIN = "imessage-agent-approved-action-v1";
export const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1_000;

const uuidSchema = z.uuid();
const storedActionEnvelopeSchema = z
  .object({
    actionType: actionTypeSchema,
    target: z.string().trim().min(1).max(512),
    payload: jsonValueSchema,
  })
  .strict();

export interface ApprovalScope {
  ownerId: string;
  spaceId: string;
  executionTaskId: string;
  chainId: string;
}

export interface ImmutableApprovalRequest {
  readonly id: string;
  readonly ownerId: string;
  readonly spaceId: string;
  readonly requestedByTaskId: string;
  readonly actionType: ActionType;
  readonly normalizedPayload: JsonValue;
  readonly actionHash: string;
  readonly humanSummary: string;
  readonly expiresAt: string;
  readonly status: "pending";
}

export interface StoredApprovalRecord {
  id: string;
  chainId: string;
  executionTaskId: string;
  ownerId: string;
  spaceId: string;
  actionType: string;
  normalizedPayloadCiphertext: string | null;
  actionHash: string;
  humanSummary: string;
  status: "pending" | "approved" | "rejected" | "expired" | "consumed";
  expiresAt: Date;
}

export interface CreateStoredApprovalInput extends ApprovalScope {
  id?: string;
  actionType: string;
  normalizedPayloadCiphertext: string;
  actionHash: string;
  humanSummary: string;
  expiresAt: Date;
}

export interface ApprovalActor {
  ownerId: string;
  identityId: string;
  role: SenderRole;
  canApprove: boolean;
}

export interface ApprovalPersistence {
  createPending(input: CreateStoredApprovalInput): Promise<string>;
  findBound(
    approvalId: string,
    ownerId: string,
    spaceId: string,
  ): Promise<StoredApprovalRecord | undefined>;
  listPending(
    ownerId: string,
    spaceId: string,
    now: Date,
  ): Promise<StoredApprovalRecord[]>;
  compareAndSetResponse(input: {
    approvalId: string;
    ownerId: string;
    spaceId: string;
    approvedByIdentityId?: string;
    status: "approved" | "rejected";
    now: Date;
  }): Promise<boolean>;
  consumeApprovedAction(input: {
    approvalId: string;
    ownerId: string;
    spaceId: string;
    executionTaskId: string;
    expectedActionHash: string;
    expectedPayloadCiphertext: string;
    now: Date;
  }): Promise<boolean>;
  expireStale(ownerId: string, spaceId: string, now: Date): Promise<number>;
}

export interface ApprovalPayloadCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

function encryptionKeyBytes(key: string | Uint8Array): Buffer {
  if (key instanceof Uint8Array) {
    if (key.byteLength !== 32) {
      throw new Error("Approval encryption key must be exactly 32 bytes.");
    }
    return Buffer.from(key);
  }
  if (/^[a-f0-9]{64}$/iu.test(key)) {
    return Buffer.from(key, "hex");
  }
  const decoded = Buffer.from(key, "base64");
  if (decoded.byteLength !== 32) {
    throw new Error("Approval encryption key must be 32-byte hex or base64.");
  }
  return decoded;
}

export function createApprovalPayloadCipher(
  key: string | Uint8Array,
): ApprovalPayloadCipher {
  const keyBytes = encryptionKeyBytes(key);
  return {
    encrypt(plaintext) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", keyBytes, nonce);
      cipher.setAAD(Buffer.from(ACTION_HASH_DOMAIN, "utf8"));
      const encrypted = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      return [
        "v1",
        nonce.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        encrypted.toString("base64url"),
      ].join(".");
    },
    decrypt(ciphertext) {
      const [version, nonceText, tagText, encryptedText, extra] =
        ciphertext.split(".");
      if (
        version !== "v1" ||
        nonceText === undefined ||
        tagText === undefined ||
        encryptedText === undefined ||
        extra !== undefined
      ) {
        throw new Error("Stored approval payload has an unsupported envelope.");
      }
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          keyBytes,
          Buffer.from(nonceText, "base64url"),
        );
        decipher.setAAD(Buffer.from(ACTION_HASH_DOMAIN, "utf8"));
        decipher.setAuthTag(Buffer.from(tagText, "base64url"));
        return Buffer.concat([
          decipher.update(Buffer.from(encryptedText, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch (error) {
        throw new Error(
          "Stored approval payload failed authenticated decryption. Reject execution and inspect the approval record.",
          { cause: error },
        );
      }
    },
  };
}

function canonicalize(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Approval payload numbers must be finite.");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key]!)}`)
    .join(",")}}`;
}

export function canonicalJson(value: JsonValue): string {
  return canonicalize(jsonValueSchema.parse(value));
}

function actionHashInput(
  scope: Pick<ApprovalScope, "ownerId" | "spaceId" | "executionTaskId">,
  envelope: z.infer<typeof storedActionEnvelopeSchema>,
): JsonValue {
  return {
    domain: ACTION_HASH_DOMAIN,
    ownerId: scope.ownerId,
    spaceId: scope.spaceId,
    executionTaskId: scope.executionTaskId,
    action: {
      actionType: envelope.actionType,
      target: envelope.target,
      payload: envelope.payload,
    },
  };
}

export function hashApprovedAction(
  scope: Pick<ApprovalScope, "ownerId" | "spaceId" | "executionTaskId">,
  action: Pick<ProposedAction, "actionType" | "target" | "normalizedPayload">,
): string {
  const parsedScope = {
    ownerId: uuidSchema.parse(scope.ownerId),
    spaceId: uuidSchema.parse(scope.spaceId),
    executionTaskId: uuidSchema.parse(scope.executionTaskId),
  };
  const envelope = storedActionEnvelopeSchema.parse({
    actionType: action.actionType,
    target: action.target,
    payload: action.normalizedPayload,
  });
  return createHash("sha256")
    .update(canonicalJson(actionHashInput(parsedScope, envelope)), "utf8")
    .digest("hex");
}

function hashesEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

const ACTION_EFFECTS: Record<ActionType, string> = {
  "filesystem.destructive": "Important filesystem data may be deleted or overwritten.",
  "external.send": "Content will be sent through an external account.",
  purchase: "A purchase, booking, transfer, or paid action may occur.",
  "authentication.change": "Authentication state or credentials will change.",
  "permission.change": "Access permissions will change.",
  "deployment.change": "A deployment or production configuration will change.",
  "secret.access": "Protected secret material will be accessed.",
  "network.broad": "Broad or sensitive network access will occur.",
  "dependency.install": "Executable dependencies will be installed persistently.",
  "other.consequential": "A consequential action with material effects will occur.",
};

function confirmationSummary(action: ProposedAction): string {
  return `${action.actionType} on ${action.target}. ${ACTION_EFFECTS[action.actionType]}`;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

export interface ConsumedApprovedAction {
  approvalId: string;
  executionTaskId: string;
  action: Readonly<{
    actionType: ActionType;
    target: string;
    normalizedPayload: JsonValue;
  }>;
}

export class ApprovalService {
  public constructor(
    private readonly persistence: ApprovalPersistence,
    private readonly cipher: ApprovalPayloadCipher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async create(
    scope: ApprovalScope,
    proposed: unknown,
    ttlMs = DEFAULT_APPROVAL_TTL_MS,
  ): Promise<ImmutableApprovalRequest> {
    const parsedScope = {
      chainId: uuidSchema.parse(scope.chainId),
      ownerId: uuidSchema.parse(scope.ownerId),
      spaceId: uuidSchema.parse(scope.spaceId),
      executionTaskId: uuidSchema.parse(scope.executionTaskId),
    };
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 24 * 60 * 60 * 1_000) {
      throw new Error("Approval expiry must be between 1 ms and 24 hours.");
    }
    const action = proposedActionSchema.parse(proposed);
    const envelope = storedActionEnvelopeSchema.parse({
      actionType: action.actionType,
      target: action.target,
      payload: action.normalizedPayload,
    });
    const plaintext = canonicalJson(envelope);
    const actionHash = hashApprovedAction(parsedScope, action);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const id = randomUUID();
    const humanSummary = confirmationSummary(action);
    const ciphertext = this.cipher.encrypt(plaintext);
    const storedId = await this.persistence.createPending({
      id,
      ...parsedScope,
      actionType: action.actionType,
      normalizedPayloadCiphertext: ciphertext,
      actionHash,
      humanSummary,
      expiresAt,
    });
    if (storedId !== id) {
      throw new Error("Approval persistence changed the code-owned request ID.");
    }

    return deepFreeze({
      id,
      ownerId: parsedScope.ownerId,
      spaceId: parsedScope.spaceId,
      requestedByTaskId: parsedScope.executionTaskId,
      actionType: action.actionType,
      normalizedPayload: structuredClone(action.normalizedPayload),
      actionHash,
      humanSummary,
      expiresAt: expiresAt.toISOString(),
      status: "pending" as const,
    });
  }

  public async listPending(
    actor: ApprovalActor,
    spaceId: string,
  ): Promise<StoredApprovalRecord[]> {
    this.requireOwnerActor(actor);
    const now = this.now();
    await this.persistence.expireStale(actor.ownerId, spaceId, now);
    return this.persistence.listPending(actor.ownerId, spaceId, now);
  }

  public async respond(
    actor: ApprovalActor,
    spaceId: string,
    approvalId: string,
    status: "approved" | "rejected",
  ): Promise<boolean> {
    this.requireOwnerActor(actor);
    uuidSchema.parse(spaceId);
    uuidSchema.parse(approvalId);
    return this.persistence.compareAndSetResponse({
      approvalId,
      ownerId: actor.ownerId,
      spaceId,
      approvedByIdentityId: actor.identityId,
      status,
      now: this.now(),
    });
  }

  /**
   * Decrypts, validates, and re-hashes the stored payload; atomically consumes
   * that exact ciphertext and returns it as the only permissible executor input.
   */
  public async consume(
    approvalId: string,
    ownerId: string,
    spaceId: string,
  ): Promise<ConsumedApprovedAction | undefined> {
    const now = this.now();
    const record = await this.persistence.findBound(
      uuidSchema.parse(approvalId),
      uuidSchema.parse(ownerId),
      uuidSchema.parse(spaceId),
    );
    if (
      record === undefined ||
      record.status !== "approved" ||
      record.expiresAt.getTime() <= now.getTime() ||
      record.normalizedPayloadCiphertext === null
    ) {
      await this.persistence.expireStale(ownerId, spaceId, now);
      return undefined;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(
        this.cipher.decrypt(record.normalizedPayloadCiphertext),
      ) as unknown;
    } catch {
      return undefined;
    }
    const parsed = storedActionEnvelopeSchema.safeParse(raw);
    if (!parsed.success || parsed.data.actionType !== record.actionType) {
      return undefined;
    }
    const recomputedHash = hashApprovedAction(
      {
        ownerId: record.ownerId,
        spaceId: record.spaceId,
        executionTaskId: record.executionTaskId,
      },
      {
        actionType: parsed.data.actionType,
        target: parsed.data.target,
        normalizedPayload: parsed.data.payload,
      },
    );
    if (!hashesEqual(recomputedHash, record.actionHash)) {
      return undefined;
    }
    const consumed = await this.persistence.consumeApprovedAction({
      approvalId: record.id,
      ownerId: record.ownerId,
      spaceId: record.spaceId,
      executionTaskId: record.executionTaskId,
      expectedActionHash: record.actionHash,
      expectedPayloadCiphertext: record.normalizedPayloadCiphertext,
      now,
    });
    if (!consumed) {
      return undefined;
    }
    return deepFreeze({
      approvalId: record.id,
      executionTaskId: record.executionTaskId,
      action: {
        actionType: parsed.data.actionType,
        target: parsed.data.target,
        normalizedPayload: structuredClone(parsed.data.payload),
      },
    });
  }

  private requireOwnerActor(actor: ApprovalActor): void {
    uuidSchema.parse(actor.ownerId);
    uuidSchema.parse(actor.identityId);
    if (actor.role !== "owner" || !actor.canApprove) {
      throw new Error("Only an active deterministic owner identity may respond to approvals.");
    }
  }
}

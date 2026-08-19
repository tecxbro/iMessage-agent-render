import type { InteractionRunState } from "../conversation/state.js";
import type { RateLimitResult } from "./rate-limits.js";
import type {
  InteractionAuthorizationRepositoryPort,
  InteractionAuthorizationSnapshot,
} from "./interaction-authorization-repository.js";

export const INTERACTION_APP_SERVER_ACTIONS = [
  "turn/start",
  "turn/steer",
  "turn/interrupt",
] as const;

export type InteractionAppServerAction =
  (typeof INTERACTION_APP_SERVER_ACTIONS)[number];

export interface SecureInteractionPermitRequest {
  action: InteractionAppServerAction;
  spaceId: string;
  interactionRunId: string;
  generation: number;
  selectedModelId: string;
  selectedReasoningEffort: string;
}

export type SecureInteractionPermitTarget = Pick<
  SecureInteractionPermitRequest,
  "action" | "spaceId" | "interactionRunId" | "generation"
>;

export interface InteractionRateLimitPolicy {
  consume(input: {
    ownerId: string;
    action: InteractionAppServerAction;
    now: Date;
  }): RateLimitResult;
}

export interface InteractionSemaphoreLease {
  release(): void;
}

export interface InteractionSemaphorePort {
  tryAcquire(input: {
    ownerId: string;
    spaceId: string;
    interactionRunId: string;
  }): Promise<InteractionSemaphoreLease | null>;
}

export type InteractionStartDeniedCode =
  | "INTERACTION_START_STALE_RUN"
  | "INTERACTION_START_ACTION_STATE_INVALID"
  | "INTERACTION_START_DEPLOYMENT_INACTIVE"
  | "INTERACTION_START_OWNER_INACTIVE"
  | "INTERACTION_START_PRINCIPAL_REVOKED"
  | "INTERACTION_START_CONTRIBUTOR_UNAUTHORIZED"
  | "INTERACTION_START_AUTHORIZATION_REVISION_STALE"
  | "INTERACTION_START_MODEL_UNAVAILABLE"
  | "INTERACTION_START_RATE_LIMITED"
  | "INTERACTION_START_SEMAPHORE_UNAVAILABLE";

const SAFE_DENIAL_MESSAGES: Readonly<
  Record<InteractionStartDeniedCode, string>
> = {
  INTERACTION_START_STALE_RUN:
    "The interaction action was denied because its run is no longer current.",
  INTERACTION_START_ACTION_STATE_INVALID:
    "The interaction action was denied because the run is in the wrong state.",
  INTERACTION_START_DEPLOYMENT_INACTIVE:
    "The interaction action was denied because the deployment is inactive.",
  INTERACTION_START_OWNER_INACTIVE:
    "The interaction action was denied because the owner is inactive.",
  INTERACTION_START_PRINCIPAL_REVOKED:
    "The interaction action was denied because the principal is no longer authorized.",
  INTERACTION_START_CONTRIBUTOR_UNAUTHORIZED:
    "The interaction action was denied because a captured contributor is no longer authorized.",
  INTERACTION_START_AUTHORIZATION_REVISION_STALE:
    "The interaction action was denied because its authorization revision is stale.",
  INTERACTION_START_MODEL_UNAVAILABLE:
    "The interaction action was denied because its selected model is unavailable.",
  INTERACTION_START_RATE_LIMITED:
    "The interaction action was denied by the interaction rate limit.",
  INTERACTION_START_SEMAPHORE_UNAVAILABLE:
    "The interaction start was denied by the interaction concurrency limit.",
};

export class InteractionStartDeniedError extends Error {
  public readonly retryable = false as const;

  public constructor(public readonly code: InteractionStartDeniedCode) {
    super(SAFE_DENIAL_MESSAGES[code]);
    this.name = "InteractionStartDeniedError";
  }
}

export type InteractionPermitErrorCode =
  | "INTERACTION_PERMIT_INVALID"
  | "INTERACTION_PERMIT_EXPIRED"
  | "INTERACTION_PERMIT_ALREADY_USED"
  | "INTERACTION_PERMIT_ACTION_MISMATCH"
  | "INTERACTION_PERMIT_TARGET_MISMATCH";

export class InteractionPermitError extends Error {
  public constructor(public readonly code: InteractionPermitErrorCode) {
    super(code);
    this.name = "InteractionPermitError";
  }
}

const PERMIT_CONSTRUCTOR_SECRET = Symbol("secure-interaction-permit");

/**
 * Nominal, one-use, action-and-target-bound permit. Its constructor rejects
 * callers that do not hold this module's private secret, and a start permit
 * owns the semaphore lease until use, disposal, or expiry.
 */
export class SecureInteractionPermit {
  readonly #expiresAtMs: number;
  readonly #lease: InteractionSemaphoreLease | null;
  #state: "active" | "used" | "disposed" = "active";
  #timer: NodeJS.Timeout;

  public readonly action: InteractionAppServerAction;
  public readonly spaceId: string;
  public readonly interactionRunId: string;
  public readonly generation: number;
  public readonly expiresAt: Date;

  public constructor(
    constructorSecret: symbol,
    input: {
      action: InteractionAppServerAction;
      spaceId: string;
      interactionRunId: string;
      generation: number;
      expiresAtMs: number;
      ttlMs: number;
      lease: InteractionSemaphoreLease | null;
    },
  ) {
    if (constructorSecret !== PERMIT_CONSTRUCTOR_SECRET) {
      throw new InteractionPermitError("INTERACTION_PERMIT_INVALID");
    }
    this.action = input.action;
    this.spaceId = input.spaceId;
    this.interactionRunId = input.interactionRunId;
    this.generation = input.generation;
    this.#expiresAtMs = input.expiresAtMs;
    this.expiresAt = new Date(input.expiresAtMs);
    this.#lease = input.lease;
    this.#timer = setTimeout(() => this.#dispose(), input.ttlMs);
    this.#timer.unref();
  }

  /** The app-server adapter must invoke the action through this method. */
  public async execute<Value>(
    target: SecureInteractionPermitTarget,
    operation: () => Promise<Value>,
    now = new Date(),
  ): Promise<Value> {
    if (this.#state === "used") {
      throw new InteractionPermitError("INTERACTION_PERMIT_ALREADY_USED");
    }
    if (this.#state === "disposed" || now.getTime() >= this.#expiresAtMs) {
      this.#dispose();
      throw new InteractionPermitError("INTERACTION_PERMIT_EXPIRED");
    }
    if (target.action !== this.action) {
      throw new InteractionPermitError("INTERACTION_PERMIT_ACTION_MISMATCH");
    }
    if (
      target.spaceId !== this.spaceId ||
      target.interactionRunId !== this.interactionRunId ||
      target.generation !== this.generation
    ) {
      throw new InteractionPermitError("INTERACTION_PERMIT_TARGET_MISMATCH");
    }

    this.#state = "used";
    clearTimeout(this.#timer);
    try {
      return await operation();
    } finally {
      this.#lease?.release();
    }
  }

  public dispose(): void {
    this.#dispose();
  }

  #dispose(): void {
    if (this.#state !== "active") return;
    this.#state = "disposed";
    clearTimeout(this.#timer);
    this.#lease?.release();
  }
}

const ACTION_STATES: Readonly<
  Record<InteractionAppServerAction, ReadonlySet<InteractionRunState>>
> = {
  "turn/start": new Set(["starting"]),
  "turn/steer": new Set(["active"]),
  "turn/interrupt": new Set(["starting", "active", "finalizing"]),
};

function validIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 512 && value.trim() === value;
}

function deny(code: InteractionStartDeniedCode): never {
  throw new InteractionStartDeniedError(code);
}

function revalidateSnapshot(
  request: SecureInteractionPermitRequest,
  snapshot: InteractionAuthorizationSnapshot | null,
): asserts snapshot is InteractionAuthorizationSnapshot {
  if (
    snapshot === null ||
    snapshot.spaceId !== request.spaceId ||
    snapshot.interactionRunId !== request.interactionRunId ||
    snapshot.generation !== request.generation ||
    snapshot.currentInteractionRunId !== request.interactionRunId ||
    snapshot.currentGeneration !== request.generation
  ) {
    deny("INTERACTION_START_STALE_RUN");
  }
  if (!ACTION_STATES[request.action].has(snapshot.runState)) {
    deny("INTERACTION_START_ACTION_STATE_INVALID");
  }
  if (snapshot.deploymentStatus !== "active") {
    deny("INTERACTION_START_DEPLOYMENT_INACTIVE");
  }
  if (snapshot.ownerStatus !== "active") {
    deny("INTERACTION_START_OWNER_INACTIVE");
  }
  if (
    snapshot.principal === null ||
    snapshot.principal.identityId.length === 0 ||
    snapshot.principal.deploymentId !== snapshot.deploymentId ||
    snapshot.principal.ownerId !== snapshot.ownerId ||
    snapshot.principal.revokedAt !== null
  ) {
    deny("INTERACTION_START_PRINCIPAL_REVOKED");
  }
  if (
    snapshot.capturedMessageCount < 1 ||
    snapshot.unauthorizedMessageCount !== 0 ||
    snapshot.unauthorizedContributorIdentityIds.length !== 0
  ) {
    deny("INTERACTION_START_CONTRIBUTOR_UNAUTHORIZED");
  }
  if (
    snapshot.currentAuthorizationRevision === null ||
    snapshot.capturedAuthorizationRevision !==
      snapshot.currentAuthorizationRevision
  ) {
    deny("INTERACTION_START_AUTHORIZATION_REVISION_STALE");
  }
  if (
    snapshot.selectedModelId !== request.selectedModelId ||
    snapshot.selectedReasoningEffort !== request.selectedReasoningEffort ||
    !snapshot.selectedModelAvailable
  ) {
    deny("INTERACTION_START_MODEL_UNAVAILABLE");
  }
}

export interface SecureInteractionStartGateOptions {
  repository: InteractionAuthorizationRepositoryPort;
  rateLimits: InteractionRateLimitPolicy;
  semaphore: InteractionSemaphorePort;
  permitTtlMs?: number;
  now?: () => Date;
}

/** Final code-owned reauthorization boundary for every app-server action. */
export class SecureInteractionStartGate {
  readonly #permitTtlMs: number;
  readonly #now: () => Date;

  public constructor(
    private readonly options: SecureInteractionStartGateOptions,
  ) {
    this.#permitTtlMs = options.permitTtlMs ?? 1_000;
    if (
      !Number.isSafeInteger(this.#permitTtlMs) ||
      this.#permitTtlMs < 1 ||
      this.#permitTtlMs > 5_000
    ) {
      throw new Error("Interaction permit TTL must be between 1 and 5000 ms.");
    }
    this.#now = options.now ?? (() => new Date());
  }

  public async issuePermit(
    request: SecureInteractionPermitRequest,
  ): Promise<SecureInteractionPermit> {
    if (
      !validIdentifier(request.spaceId) ||
      !validIdentifier(request.interactionRunId) ||
      !Number.isSafeInteger(request.generation) ||
      request.generation < 0 ||
      !validIdentifier(request.selectedModelId) ||
      !validIdentifier(request.selectedReasoningEffort)
    ) {
      deny("INTERACTION_START_STALE_RUN");
    }

    const snapshot = await this.options.repository.loadCurrent({
      spaceId: request.spaceId,
      interactionRunId: request.interactionRunId,
      generation: request.generation,
    });
    revalidateSnapshot(request, snapshot);

    const rateLimitCheckedAt = this.#now();
    const rateLimit = this.options.rateLimits.consume({
      ownerId: snapshot.ownerId,
      action: request.action,
      now: rateLimitCheckedAt,
    });
    if (!rateLimit.allowed) {
      deny("INTERACTION_START_RATE_LIMITED");
    }

    const lease =
      request.action === "turn/start"
        ? await this.options.semaphore.tryAcquire({
            ownerId: snapshot.ownerId,
            spaceId: request.spaceId,
            interactionRunId: request.interactionRunId,
          })
        : null;
    if (request.action === "turn/start" && lease === null) {
      deny("INTERACTION_START_SEMAPHORE_UNAVAILABLE");
    }

    if (lease !== null) {
      try {
        const finalSnapshot = await this.options.repository.loadCurrent({
          spaceId: request.spaceId,
          interactionRunId: request.interactionRunId,
          generation: request.generation,
        });
        revalidateSnapshot(request, finalSnapshot);
      } catch (error) {
        lease.release();
        throw error;
      }
    }

    const issuedAt = this.#now();

    return new SecureInteractionPermit(PERMIT_CONSTRUCTOR_SECRET, {
      action: request.action,
      spaceId: request.spaceId,
      interactionRunId: request.interactionRunId,
      generation: request.generation,
      expiresAtMs: issuedAt.getTime() + this.#permitTtlMs,
      ttlMs: this.#permitTtlMs,
      lease,
    });
  }
}

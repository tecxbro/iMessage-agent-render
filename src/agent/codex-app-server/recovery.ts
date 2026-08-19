import { createHash } from "node:crypto";

import type { UserInput } from "./generated/v2/UserInput.js";
import type {
  CodexAppServerInteractionClient,
  CodexAppServerThreadView,
  CodexAppServerTurnView,
  TurnSteerSubmissionResult,
} from "./interaction-client.js";

export type SteerRecoveryResult =
  | {
      state: "accepted";
      threadId: string;
      turnId: string;
      clientUserMessageId: string;
    }
  | {
      state: "absent";
      threadId: string;
      expectedTurnId: string;
      clientUserMessageId: string;
    }
  | {
      state: "still_uncertain";
      threadId: string;
      expectedTurnId: string;
      clientUserMessageId: string;
    };

export async function recoverUncertainSteer(
  client: CodexAppServerInteractionClient,
  submission: Extract<
    TurnSteerSubmissionResult,
    { state: "uncertain_submission" }
  >,
): Promise<SteerRecoveryResult> {
  let thread: CodexAppServerThreadView;
  try {
    ({ thread } = await client.threadRead({
      threadId: submission.threadId,
      includeTurns: true,
    }));
  } catch {
    return { state: "still_uncertain", ...recoveryIdentity(submission) };
  }

  for (const turn of thread.turns) {
    if (
      turn.items.some(
        (item) =>
          item.type === "userMessage" &&
          item.clientId === submission.clientUserMessageId,
      )
    ) {
      return {
        state: "accepted",
        threadId: submission.threadId,
        turnId: turn.id,
        clientUserMessageId: submission.clientUserMessageId,
      };
    }
  }

  if (thread.turns.every((turn) => turn.itemsView === "full")) {
    return { state: "absent", ...recoveryIdentity(submission) };
  }
  return { state: "still_uncertain", ...recoveryIdentity(submission) };
}

export type RestartRunReconciliation =
  | { state: "terminal"; turn: CodexAppServerTurnView }
  | { state: "orphaned_nonterminal"; turnId: string }
  | { state: "missing"; turnId: string };

export async function reconcileRunAfterRestart(
  client: CodexAppServerInteractionClient,
  identifiers: { threadId: string; turnId: string },
): Promise<RestartRunReconciliation> {
  const { thread } = await client.threadRead({
    threadId: identifiers.threadId,
    includeTurns: true,
  });
  const turn = thread.turns.find(
    (candidate) => candidate.id === identifiers.turnId,
  );
  if (turn === undefined) {
    return { state: "missing", turnId: identifiers.turnId };
  }
  if (turn.status === "inProgress") {
    // A process restart invalidates old liveness even when persisted history
    // still says the turn had been in progress.
    return { state: "orphaned_nonterminal", turnId: turn.id };
  }
  return { state: "terminal", turn };
}

export interface AbsentSteerReplacementKey {
  threadId: string;
  expectedTurnId: string;
  clientUserMessageId: string;
}

export type AbsentSteerReplacementReserveResult =
  | { state: "reserved"; reservationId: string }
  | { state: "unavailable" };

/**
 * Durable boundary used to coordinate replacement work across actor instances.
 *
 * Implementations must make `reserve` atomic for a key. A committed key remains
 * unavailable permanently, while `release` makes a reservation available again
 * only when `reservationId` still owns it.
 */
export interface AbsentSteerReplacementReservationStore {
  reserve(
    key: AbsentSteerReplacementKey,
    rangeFingerprint: string,
  ): Promise<AbsentSteerReplacementReserveResult>;
  commit(key: AbsentSteerReplacementKey, reservationId: string): Promise<void>;
  release(key: AbsentSteerReplacementKey, reservationId: string): Promise<void>;
}

export interface AbsentSteerReplacementReservation {
  readonly key: AbsentSteerReplacementKey;
  readonly rangeFingerprint: string;
  readonly range: readonly UserInput[];
  commit(): Promise<void>;
  release(): Promise<void>;
}

/**
 * Coordinates the one-time inclusion of an absent steer in replacement work.
 * Persistence and atomicity deliberately belong to the injected store rather
 * than this process-local coordinator.
 */
export class AbsentSteerReplacementCoordinator {
  readonly #store: AbsentSteerReplacementReservationStore;

  public constructor(store: AbsentSteerReplacementReservationStore) {
    this.#store = store;
  }

  public async reserve(
    recovery: SteerRecoveryResult,
    range: readonly UserInput[],
  ): Promise<AbsentSteerReplacementReservation | undefined> {
    if (recovery.state !== "absent") {
      return undefined;
    }
    const rangeJson = canonicalJson(range);
    const copiedRange = freezeJson(
      JSON.parse(rangeJson) as UserInput[],
    ) as readonly UserInput[];
    const key: AbsentSteerReplacementKey = Object.freeze({
      threadId: recovery.threadId,
      expectedTurnId: recovery.expectedTurnId,
      clientUserMessageId: recovery.clientUserMessageId,
    });
    const rangeFingerprint = createHash("sha256")
      .update(rangeJson)
      .digest("hex");
    const result = await this.#store.reserve(key, rangeFingerprint);
    if (result.state === "unavailable") {
      return undefined;
    }
    return new StoreBackedAbsentSteerReplacementReservation(
      this.#store,
      key,
      rangeFingerprint,
      result.reservationId,
      copiedRange,
    );
  }
}

class StoreBackedAbsentSteerReplacementReservation
  implements AbsentSteerReplacementReservation
{
  readonly #store: AbsentSteerReplacementReservationStore;
  readonly #reservationId: string;
  #state: "active" | "committed" | "released" = "active";
  public readonly key: AbsentSteerReplacementKey;
  public readonly rangeFingerprint: string;
  public readonly range: readonly UserInput[];

  public constructor(
    store: AbsentSteerReplacementReservationStore,
    key: AbsentSteerReplacementKey,
    rangeFingerprint: string,
    reservationId: string,
    range: readonly UserInput[],
  ) {
    this.#store = store;
    this.key = key;
    this.rangeFingerprint = rangeFingerprint;
    this.#reservationId = reservationId;
    this.range = range;
  }

  public async commit(): Promise<void> {
    this.#assertActive("commit");
    await this.#store.commit(this.key, this.#reservationId);
    this.#state = "committed";
  }

  public async release(): Promise<void> {
    this.#assertActive("release");
    await this.#store.release(this.key, this.#reservationId);
    this.#state = "released";
  }

  #assertActive(operation: "commit" | "release"): void {
    if (this.#state !== "active") {
      throw new Error(
        `Cannot ${operation} an absent-steer replacement reservation after it was ${this.#state}.`,
      );
    }
  }
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Replacement input contains a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new TypeError("Replacement input is not JSON-serializable.");
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      freezeJson(item);
    }
    return Object.freeze(value);
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      freezeJson(item);
    }
    return Object.freeze(value);
  }
  return value;
}

function recoveryIdentity(submission: {
  threadId: string;
  expectedTurnId: string;
  clientUserMessageId: string;
}): {
  threadId: string;
  expectedTurnId: string;
  clientUserMessageId: string;
} {
  return {
    threadId: submission.threadId,
    expectedTurnId: submission.expectedTurnId,
    clientUserMessageId: submission.clientUserMessageId,
  };
}

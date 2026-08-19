import type { InteractionCoordinateReason } from "../queue/payloads.js";
import type { ConversationSnapshot } from "./contracts.js";
import { CoalescingMailbox } from "./coalescing-mailbox.js";

export interface ConversationObservationRepository {
  loadConversation(
    spaceId: string,
    signal?: AbortSignal,
  ): Promise<ConversationSnapshot | null>;
}

export interface ConversationObservation {
  spaceId: string;
  observedThroughSequence: number;
  legacyFinalizedThroughSequence: number;
  actorGeneration: number;
  actorState: ConversationSnapshot["state"]["state"];
  reasons: readonly InteractionCoordinateReason[];
  observationCount: number;
  observedAt: Date;
}

export interface ConversationObservationMetricsOptions {
  maximumTrackedSpaces?: number;
  onRecord?: (observation: ConversationObservation) => void;
}

export class ConversationObservationMetrics {
  readonly #observations = new Map<string, ConversationObservation>();
  readonly #maximumTrackedSpaces: number;
  readonly #onRecord: ((observation: ConversationObservation) => void) | undefined;

  public constructor(options: ConversationObservationMetricsOptions = {}) {
    const maximumTrackedSpaces = options.maximumTrackedSpaces ?? 1_000;
    if (!Number.isSafeInteger(maximumTrackedSpaces) || maximumTrackedSpaces < 1) {
      throw new Error(
        "Conversation observation metric capacity must be a positive integer.",
      );
    }
    this.#maximumTrackedSpaces = maximumTrackedSpaces;
    this.#onRecord = options.onRecord;
  }

  public record(input: {
    snapshot: ConversationSnapshot;
    reasons: ReadonlySet<InteractionCoordinateReason>;
    observedAt: Date;
  }): ConversationObservation {
    const { state } = input.snapshot;
    const current = this.#observations.get(state.spaceId);
    const reasons = [...new Set([
      ...(current?.reasons ?? []),
      ...input.reasons,
    ])].sort();
    const cursorChanged =
      current === undefined ||
      current.observedThroughSequence !== state.latestInputSequence ||
      current.legacyFinalizedThroughSequence !==
        state.finalizedThroughSequence ||
      current.actorGeneration !== state.actorGeneration ||
      current.actorState !== state.state;
    const observation: ConversationObservation = {
      spaceId: state.spaceId,
      observedThroughSequence: state.latestInputSequence,
      legacyFinalizedThroughSequence: state.finalizedThroughSequence,
      actorGeneration: state.actorGeneration,
      actorState: state.state,
      reasons,
      observationCount:
        current === undefined
          ? 1
          : current.observationCount + (cursorChanged ? 1 : 0),
      observedAt: input.observedAt,
    };
    if (current !== undefined) {
      this.#observations.delete(state.spaceId);
    } else if (this.#observations.size >= this.#maximumTrackedSpaces) {
      const oldestSpaceId = this.#observations.keys().next().value;
      if (oldestSpaceId !== undefined) {
        this.#observations.delete(oldestSpaceId);
      }
    }
    this.#observations.set(state.spaceId, observation);
    const recorded = structuredClone(observation);
    if (cursorChanged) {
      try {
        this.#onRecord?.(recorded);
      } catch {
        // Telemetry consumers cannot interrupt passive observation.
      }
    }
    return recorded;
  }

  public get(spaceId: string): ConversationObservation | undefined {
    const observation = this.#observations.get(spaceId);
    return observation === undefined
      ? undefined
      : structuredClone(observation);
  }

  public snapshot(): readonly ConversationObservation[] {
    return [...this.#observations.values()]
      .sort((left, right) => left.spaceId.localeCompare(right.spaceId))
      .map((observation) => structuredClone(observation));
  }
}

export interface ObserveConversationActorOptions {
  spaceId: string;
  repository: ConversationObservationRepository;
  metrics: ConversationObservationMetrics;
  now?: () => Date;
  readTimeoutMs?: number;
}

/**
 * Observe-mode actor. It can only reload the authoritative cursor snapshot and
 * update process-local metrics. The narrowed repository port intentionally
 * makes model, task, delivery, and conversation-state mutations unavailable.
 */
export class ObserveConversationActor {
  readonly #mailbox = new CoalescingMailbox<InteractionCoordinateReason>();
  readonly #spaceId: string;
  readonly #repository: ConversationObservationRepository;
  readonly #metrics: ConversationObservationMetrics;
  readonly #now: () => Date;
  readonly #readTimeoutMs: number;
  readonly #disposeController = new AbortController();
  #loopPromise: Promise<void> | null = null;
  #disposed = false;

  public constructor(options: ObserveConversationActorOptions) {
    this.#spaceId = options.spaceId;
    this.#repository = options.repository;
    this.#metrics = options.metrics;
    this.#now = options.now ?? (() => new Date());
    this.#readTimeoutMs = options.readTimeoutMs ?? 2_000;
    if (!Number.isSafeInteger(this.#readTimeoutMs) || this.#readTimeoutMs < 1) {
      throw new Error("Observe conversation actor read timeout must be positive.");
    }
  }

  public wake(reason: InteractionCoordinateReason): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(
        new DOMException("Observe conversation actor was disposed.", "AbortError"),
      );
    }
    this.#mailbox.wake(reason);
    return this.#ensureLoop();
  }

  public dispose(): void {
    this.#disposed = true;
    this.#disposeController.abort(
      new DOMException("Observe conversation actor was disposed.", "AbortError"),
    );
  }

  #ensureLoop(): Promise<void> {
    if (this.#loopPromise !== null) {
      return this.#loopPromise;
    }
    const loop = Promise.resolve().then(async () => this.#runLoop());
    const tracked = loop.finally(() => {
      if (this.#loopPromise === tracked) {
        this.#loopPromise = null;
      }
    });
    this.#loopPromise = tracked;
    return tracked;
  }

  async #runLoop(): Promise<void> {
    while (!this.#disposed) {
      const reasons = this.#mailbox.drain();
      if (reasons.size === 0) {
        return;
      }
      const snapshot = await this.#loadConversation();
      if (!this.#disposed && snapshot !== null) {
        this.#metrics.record({
          snapshot,
          reasons,
          observedAt: this.#now(),
        });
      }

      const quietVersion = this.#mailbox.version;
      await Promise.resolve();
      if (
        !this.#mailbox.hasPending &&
        this.#mailbox.version === quietVersion
      ) {
        return;
      }
    }
  }

  async #loadConversation(): Promise<ConversationSnapshot | null> {
    const disposeSignal = this.#disposeController.signal;
    if (disposeSignal.aborted) {
      throw disposeSignal.reason;
    }

    return await new Promise<ConversationSnapshot | null>((resolve, reject) => {
      let settled = false;
      const loadController = new AbortController();
      const finish = (
        outcome: "resolve" | "reject",
        value: ConversationSnapshot | null | unknown,
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        disposeSignal.removeEventListener("abort", onDispose);
        if (outcome === "resolve") {
          resolve(value as ConversationSnapshot | null);
        } else {
          reject(value);
        }
      };
      const onDispose = (): void => {
        loadController.abort(disposeSignal.reason);
        finish("reject", disposeSignal.reason);
      };
      const timeout = setTimeout(() => {
        const timeoutError = new Error(
          `Observe conversation snapshot read exceeded ${this.#readTimeoutMs}ms. Check PostgreSQL health before retrying.`,
        );
        loadController.abort(timeoutError);
        finish(
          "reject",
          timeoutError,
        );
      }, this.#readTimeoutMs);
      timeout.unref?.();
      disposeSignal.addEventListener("abort", onDispose, { once: true });

      void this.#repository.loadConversation(
        this.#spaceId,
        loadController.signal,
      ).then(
        (snapshot) => finish("resolve", snapshot),
        (error: unknown) => finish("reject", error),
      );
    });
  }
}

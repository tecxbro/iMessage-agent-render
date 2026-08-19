import type {
  InteractionPresenceLease,
  InteractionPresencePort,
} from "../conversation/contracts.js";

export const DEFAULT_INTERACTION_PRESENCE_REFRESH_INTERVAL_MS = 10_000;
export const DEFAULT_INTERACTION_PRESENCE_OPERATION_TIMEOUT_MS = 2_000;

export type InteractionPresenceOperation = "start" | "refresh" | "stop";

/**
 * Provider-only typing/presence boundary. It deliberately has no outbound
 * message primitive so interaction coordination cannot send user content.
 */
export interface InteractionPresenceTransport {
  start(spaceId: string): Promise<void>;
  refresh(spaceId: string): Promise<void>;
  stop(spaceId: string): Promise<void>;
}

export interface InteractionPresenceFailure {
  interactionRunId: string;
  operation: InteractionPresenceOperation;
  reason: "failed" | "timed_out";
  spaceId: string;
}

export interface InteractionPresenceOptions {
  transport: InteractionPresenceTransport;
  refreshIntervalMs?: number;
  operationTimeoutMs?: number;
  onFailure?: (
    failure: InteractionPresenceFailure,
  ) => void | Promise<void>;
}

type PresenceAttemptOutcome = "completed" | "failed" | "timed_out";
type PresenceSettledOutcome = Exclude<PresenceAttemptOutcome, "timed_out">;

interface BoundedPresenceAttempt {
  outcome: PresenceAttemptOutcome;
  settled: Promise<PresenceSettledOutcome>;
}

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

async function runBoundedAttempt(
  attempt: () => Promise<void>,
  timeoutMs: number,
): Promise<BoundedPresenceAttempt> {
  const settled = Promise.resolve()
    .then(attempt)
    .then<PresenceSettledOutcome, PresenceSettledOutcome>(
      () => "completed",
      () => "failed",
    );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<PresenceAttemptOutcome>((resolve) => {
    timeout = setTimeout(() => resolve("timed_out"), timeoutMs);
    timeout.unref?.();
  });

  const outcome = await Promise.race([settled, timedOut]);
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
  return { outcome, settled };
}

class BestEffortPresenceLease implements InteractionPresenceLease {
  readonly #transport: InteractionPresenceTransport;
  readonly #spaceId: string;
  readonly #interactionRunId: string;
  readonly #signal: AbortSignal;
  readonly #refreshIntervalMs: number;
  readonly #operationTimeoutMs: number;
  readonly #onFailure:
    | ((failure: InteractionPresenceFailure) => void | Promise<void>)
    | undefined;
  readonly #onStopped: (
    stopOutcome: PresenceAttemptOutcome | "not_started",
  ) => void;
  readonly #onLateAttempt: (
    settled: Promise<PresenceSettledOutcome>,
    intendedActive: boolean,
  ) => void;
  readonly #abortHandler: () => void;
  #tail: Promise<void> = Promise.resolve();
  #refreshTimer: ReturnType<typeof setInterval> | undefined;
  #stopPromise: Promise<void> | undefined;
  #refreshPending = false;
  #startScheduled = false;
  #stopped = false;
  #lastStopOutcome: PresenceAttemptOutcome | undefined;

  public constructor(input: {
    transport: InteractionPresenceTransport;
    spaceId: string;
    interactionRunId: string;
    signal: AbortSignal;
    refreshIntervalMs: number;
    operationTimeoutMs: number;
    onFailure?: (
      failure: InteractionPresenceFailure,
    ) => void | Promise<void>;
    onStopped: (
      stopOutcome: PresenceAttemptOutcome | "not_started",
    ) => void;
    onLateAttempt: (
      settled: Promise<PresenceSettledOutcome>,
      intendedActive: boolean,
    ) => void;
  }) {
    this.#transport = input.transport;
    this.#spaceId = input.spaceId;
    this.#interactionRunId = input.interactionRunId;
    this.#signal = input.signal;
    this.#refreshIntervalMs = input.refreshIntervalMs;
    this.#operationTimeoutMs = input.operationTimeoutMs;
    this.#onFailure = input.onFailure;
    this.#onStopped = input.onStopped;
    this.#onLateAttempt = input.onLateAttempt;
    this.#abortHandler = () => {
      void this.stop();
    };
  }

  public async activate(): Promise<void> {
    if (this.#signal.aborted) {
      this.#stopped = true;
      this.#onStopped("not_started");
      return;
    }

    this.#signal.addEventListener("abort", this.#abortHandler, { once: true });
    if (this.#signal.aborted) {
      await this.stop();
      return;
    }

    this.#startScheduled = true;
    await this.#enqueue("start");
    if (this.#stopped) {
      await this.#stopPromise;
      return;
    }

    this.#refreshTimer = setInterval(() => {
      if (!this.#stopped && !this.#refreshPending) {
        this.#refreshPending = true;
        void this.#enqueue("refresh").finally(() => {
          this.#refreshPending = false;
        });
      }
    }, this.#refreshIntervalMs);
    this.#refreshTimer.unref?.();
  }

  public stop(): Promise<void> {
    if (this.#stopPromise !== undefined) {
      return this.#stopPromise;
    }

    this.#stopped = true;
    if (this.#refreshTimer !== undefined) {
      clearInterval(this.#refreshTimer);
      this.#refreshTimer = undefined;
    }
    this.#signal.removeEventListener("abort", this.#abortHandler);

    const stopped = this.#startScheduled
      ? this.#enqueue("stop")
      : Promise.resolve();
    this.#stopPromise = stopped.finally(() => {
      this.#onStopped(this.#lastStopOutcome ?? "not_started");
    });
    return this.#stopPromise;
  }

  #enqueue(operation: InteractionPresenceOperation): Promise<void> {
    this.#tail = this.#tail.then(() => this.#attempt(operation));
    return this.#tail;
  }

  async #attempt(operation: InteractionPresenceOperation): Promise<void> {
    const attempt = await runBoundedAttempt(() => {
      switch (operation) {
        case "start":
          return this.#transport.start(this.#spaceId);
        case "refresh":
          return this.#transport.refresh(this.#spaceId);
        case "stop":
          return this.#transport.stop(this.#spaceId);
      }
    }, this.#operationTimeoutMs);
    if (operation === "stop") {
      this.#lastStopOutcome = attempt.outcome;
    }
    if (attempt.outcome === "timed_out") {
      this.#onLateAttempt(attempt.settled, operation !== "stop");
    }

    if (attempt.outcome === "completed") {
      return;
    }

    try {
      const diagnostic = this.#onFailure?.({
        interactionRunId: this.#interactionRunId,
        operation,
        reason: attempt.outcome,
        spaceId: this.#spaceId,
      });
      if (diagnostic !== undefined) {
        void Promise.resolve(diagnostic).catch(() => undefined);
      }
    } catch {
      // Best-effort diagnostics must not fail or delay the interaction.
    }
  }

}

/**
 * Owns best-effort typing presence for active interaction runs. Provider
 * failures are bounded and contained; callers remain responsible only for
 * keeping the lease in a finally block (or using runWithPresence).
 */
export class InteractionPresence implements InteractionPresencePort {
  readonly #transport: InteractionPresenceTransport;
  readonly #refreshIntervalMs: number;
  readonly #operationTimeoutMs: number;
  readonly #onFailure:
    | ((failure: InteractionPresenceFailure) => void | Promise<void>)
    | undefined;
  readonly #activeLeases = new Set<BestEffortPresenceLease>();
  readonly #activeLeasesBySpace = new Map<
    string,
    Set<BestEffortPresenceLease>
  >();
  readonly #reconciliationTails = new Map<string, Promise<void>>();
  readonly #latePresenceAttempts = new Set<Promise<void>>();
  #shutdownPromise: Promise<void> | undefined;

  public constructor(options: InteractionPresenceOptions) {
    this.#transport = options.transport;
    this.#refreshIntervalMs = requirePositiveInteger(
      "refreshIntervalMs",
      options.refreshIntervalMs ??
        DEFAULT_INTERACTION_PRESENCE_REFRESH_INTERVAL_MS,
    );
    this.#operationTimeoutMs = requirePositiveInteger(
      "operationTimeoutMs",
      options.operationTimeoutMs ??
        DEFAULT_INTERACTION_PRESENCE_OPERATION_TIMEOUT_MS,
    );
    this.#onFailure = options.onFailure;
  }

  public async start(input: {
    spaceId: string;
    interactionRunId: string;
    signal: AbortSignal;
  }): Promise<InteractionPresenceLease> {
    if (this.#shutdownPromise !== undefined) {
      return { stop: async () => undefined };
    }

    let lease!: BestEffortPresenceLease;
    lease = new BestEffortPresenceLease({
      transport: this.#transport,
      spaceId: input.spaceId,
      interactionRunId: input.interactionRunId,
      signal: input.signal,
      refreshIntervalMs: this.#refreshIntervalMs,
      operationTimeoutMs: this.#operationTimeoutMs,
      ...(this.#onFailure === undefined ? {} : { onFailure: this.#onFailure }),
      onLateAttempt: (settled, intendedActive) => {
        this.#trackLatePresenceAttempt(
          input.spaceId,
          settled,
          intendedActive,
        );
      },
      onStopped: (stopOutcome) => {
        this.#activeLeases.delete(lease);
        const leasesForSpace = this.#activeLeasesBySpace.get(input.spaceId);
        leasesForSpace?.delete(lease);
        if (leasesForSpace?.size === 0) {
          this.#activeLeasesBySpace.delete(input.spaceId);
        }
        const presenceDesired = this.#presenceDesired(input.spaceId);
        if (
          stopOutcome !== "not_started" &&
          (stopOutcome !== "completed" || presenceDesired)
        ) {
          void this.#scheduleReconciliation(input.spaceId);
        }
      },
    });
    this.#activeLeases.add(lease);
    const leasesForSpace =
      this.#activeLeasesBySpace.get(input.spaceId) ??
      new Set<BestEffortPresenceLease>();
    leasesForSpace.add(lease);
    this.#activeLeasesBySpace.set(input.spaceId, leasesForSpace);
    await lease.activate();
    return lease;
  }

  public shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) {
      return this.#shutdownPromise;
    }

    const activeLeases = [...this.#activeLeases];
    this.#shutdownPromise = (async () => {
      await Promise.all(activeLeases.map(async (lease) => lease.stop()));
      await this.#awaitReconciliations();
      await this.#drainLatePresenceAttempts();
      await this.#awaitReconciliations();
    })();
    return this.#shutdownPromise;
  }

  #presenceDesired(spaceId: string): boolean {
    return (this.#activeLeasesBySpace.get(spaceId)?.size ?? 0) > 0;
  }

  #trackLatePresenceAttempt(
    spaceId: string,
    settled: Promise<PresenceSettledOutcome>,
    intendedActive: boolean,
  ): void {
    let reconciliation!: Promise<void>;
    reconciliation = settled
      .then(async () => {
        if (this.#presenceDesired(spaceId) !== intendedActive) {
          await this.#scheduleReconciliation(spaceId);
        }
      })
      .finally(() => {
        this.#latePresenceAttempts.delete(reconciliation);
      });
    this.#latePresenceAttempts.add(reconciliation);
    void reconciliation.catch(() => undefined);
  }

  #scheduleReconciliation(spaceId: string): Promise<void> {
    const previous =
      this.#reconciliationTails.get(spaceId) ?? Promise.resolve();
    let queued!: Promise<void>;
    queued = previous
      .catch(() => undefined)
      .then(async () => this.#reconcileSpace(spaceId))
      .finally(() => {
        if (this.#reconciliationTails.get(spaceId) === queued) {
          this.#reconciliationTails.delete(spaceId);
        }
      });
    this.#reconciliationTails.set(spaceId, queued);
    return queued;
  }

  async #reconcileSpace(spaceId: string): Promise<void> {
    const intendedActive = this.#presenceDesired(spaceId);
    const attempt = await runBoundedAttempt(
      intendedActive
        ? async () => this.#transport.refresh(spaceId)
        : async () => this.#transport.stop(spaceId),
      this.#operationTimeoutMs,
    );
    if (attempt.outcome === "timed_out") {
      this.#trackLatePresenceAttempt(
        spaceId,
        attempt.settled,
        intendedActive,
      );
    }
    if (this.#presenceDesired(spaceId) !== intendedActive) {
      void this.#scheduleReconciliation(spaceId);
    }
  }

  async #awaitReconciliations(): Promise<void> {
    while (this.#reconciliationTails.size > 0) {
      await Promise.allSettled([...this.#reconciliationTails.values()]);
    }
  }

  async #drainLatePresenceAttempts(): Promise<void> {
    const pending = [...this.#latePresenceAttempts];
    if (pending.length === 0) {
      return;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const budgetElapsed = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, this.#operationTimeoutMs);
      timeout.unref?.();
    });
    await Promise.race([
      Promise.allSettled(pending).then(() => undefined),
      budgetElapsed,
    ]);
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export async function runWithPresence<Result>(
  presence: InteractionPresencePort,
  input: {
    spaceId: string;
    interactionRunId: string;
    signal: AbortSignal;
  },
  run: () => Result | Promise<Result>,
): Promise<Result> {
  const lease = await presence.start(input);
  try {
    return await run();
  } finally {
    await lease.stop();
  }
}

import type { ActorRegistryPort } from "./contracts.js";
import type { InteractionCoordinatePayload } from "../queue/payloads.js";

export const DEFAULT_ACTOR_IDLE_TTL_MS = 5 * 60 * 1_000;

export type ConversationActorWakeReason = InteractionCoordinatePayload["reason"];

export interface ConversationActorHandle {
  wake(reason: ConversationActorWakeReason): Promise<void>;
  dispose?(): void | Promise<void>;
}

export interface ActorRegistryOptions {
  createActor(spaceId: string): ConversationActorHandle;
  idleTtlMs?: number;
}

interface ActorEntry {
  readonly actor: ConversationActorHandle;
  inFlightWakes: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  disposed: boolean;
  disposeFinished: boolean;
  retirement: Promise<void> | undefined;
  finishRetirement: (() => void) | undefined;
}

export class ActorRegistry implements ActorRegistryPort {
  readonly #actors = new Map<string, ActorEntry>();
  readonly #retiring = new Map<string, Promise<void>>();
  readonly #exclusiveTails = new Map<string, Promise<void>>();
  readonly #createActor: ActorRegistryOptions["createActor"];
  readonly #idleTtlMs: number;
  #disposed = false;

  public constructor(options: ActorRegistryOptions) {
    const idleTtlMs = options.idleTtlMs ?? DEFAULT_ACTOR_IDLE_TTL_MS;
    if (!Number.isSafeInteger(idleTtlMs) || idleTtlMs < 1) {
      throw new RangeError("Actor idle TTL must be a positive safe integer.");
    }
    this.#createActor = options.createActor;
    this.#idleTtlMs = idleTtlMs;
  }

  public get actorCount(): number {
    return this.#actors.size;
  }

  public async wake(
    spaceId: string,
    reason: ConversationActorWakeReason,
  ): Promise<void> {
    this.#assertOpen();
    const retiring = this.#retiring.get(spaceId);
    if (retiring !== undefined) {
      await retiring;
      this.#assertOpen();
    }
    const entry = this.#getOrCreate(spaceId);
    this.#clearIdleTimer(entry);
    entry.inFlightWakes += 1;

    try {
      await entry.actor.wake(reason);
    } catch (error) {
      if (this.#actors.get(spaceId) === entry) {
        this.#actors.delete(spaceId);
        this.#clearIdleTimer(entry);
        this.#beginRetirement(spaceId, entry);
        await this.#disposeEntry(entry);
      }
      throw error;
    } finally {
      entry.inFlightWakes -= 1;
      this.#maybeFinishRetirement(entry);
      if (
        this.#actors.get(spaceId) === entry &&
        entry.inFlightWakes === 0
      ) {
        this.#scheduleIdleExpiration(spaceId, entry);
      }
    }
  }

  public async runExclusive<Result>(
    spaceId: string,
    actor: () => Promise<Result>,
  ): Promise<Result> {
    this.#assertOpen();
    const previous = this.#exclusiveTails.get(spaceId) ?? Promise.resolve();
    let releaseTurn: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    this.#exclusiveTails.set(spaceId, current);

    await previous;
    try {
      this.#assertOpen();
      return await actor();
    } finally {
      releaseTurn?.();
      if (this.#exclusiveTails.get(spaceId) === current) {
        this.#exclusiveTails.delete(spaceId);
      }
    }
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    const entries = [...this.#actors.values()];
    this.#actors.clear();
    for (const entry of entries) {
      this.#clearIdleTimer(entry);
      this.#beginRetirement(undefined, entry);
    }
    await Promise.all([
      ...entries.map(async (entry) => this.#disposeEntry(entry)),
      ...entries.map((entry) => entry.retirement as Promise<void>),
      ...this.#retiring.values(),
    ]);
  }

  #getOrCreate(spaceId: string): ActorEntry {
    const current = this.#actors.get(spaceId);
    if (current !== undefined) {
      return current;
    }
    const entry: ActorEntry = {
      actor: this.#createActor(spaceId),
      inFlightWakes: 0,
      idleTimer: undefined,
      disposed: false,
      disposeFinished: false,
      retirement: undefined,
      finishRetirement: undefined,
    };
    this.#actors.set(spaceId, entry);
    return entry;
  }

  #scheduleIdleExpiration(spaceId: string, entry: ActorEntry): void {
    this.#clearIdleTimer(entry);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (
        this.#actors.get(spaceId) !== entry ||
        entry.inFlightWakes !== 0
      ) {
        return;
      }
      this.#actors.delete(spaceId);
      this.#beginRetirement(spaceId, entry);
      void this.#disposeEntry(entry);
    }, this.#idleTtlMs);
    entry.idleTimer.unref?.();
  }

  #clearIdleTimer(entry: ActorEntry): void {
    if (entry.idleTimer === undefined) {
      return;
    }
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  async #disposeEntry(entry: ActorEntry): Promise<void> {
    if (entry.disposed) {
      return;
    }
    entry.disposed = true;
    try {
      await entry.actor.dispose?.();
    } catch {
      // Disposal is best-effort and must not mask an actor failure.
    } finally {
      entry.disposeFinished = true;
      this.#maybeFinishRetirement(entry);
    }
  }

  #beginRetirement(spaceId: string | undefined, entry: ActorEntry): void {
    if (entry.retirement !== undefined) {
      return;
    }
    let finishRetirement!: () => void;
    const retirement = new Promise<void>((resolve) => {
      finishRetirement = resolve;
    });
    entry.retirement = retirement;
    entry.finishRetirement = finishRetirement;
    if (spaceId !== undefined) {
      this.#retiring.set(spaceId, retirement);
      void retirement.then(() => {
        if (this.#retiring.get(spaceId) === retirement) {
          this.#retiring.delete(spaceId);
        }
      });
    }
    this.#maybeFinishRetirement(entry);
  }

  #maybeFinishRetirement(entry: ActorEntry): void {
    if (
      entry.retirement === undefined ||
      entry.inFlightWakes !== 0 ||
      !entry.disposeFinished
    ) {
      return;
    }
    const finish = entry.finishRetirement;
    entry.finishRetirement = undefined;
    finish?.();
  }

  #assertOpen(): void {
    if (this.#disposed) {
      throw new Error("Actor registry is disposed and cannot accept new work.");
    }
  }
}

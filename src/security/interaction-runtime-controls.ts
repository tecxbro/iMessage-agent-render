import type {
  InteractionAppServerAction,
  InteractionRateLimitPolicy,
  InteractionSemaphoreLease,
  InteractionSemaphorePort,
} from "./secure-interaction-start-gate.js";
import { SlidingWindowRateLimiter } from "./rate-limits.js";

export class InteractionActionRateLimits implements InteractionRateLimitPolicy {
  readonly #limiter = new SlidingWindowRateLimiter();

  public constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("Interaction action rate limit must be positive.");
    }
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
      throw new Error("Interaction action rate window must be positive.");
    }
  }

  public consume(input: {
    ownerId: string;
    action: InteractionAppServerAction;
    now: Date;
  }) {
    return this.#limiter.consume(
      `${input.action}:${input.ownerId}`,
      { limit: this.limit, windowMs: this.windowMs },
      input.now,
    );
  }
}

/** Nonblocking global/per-owner permit cap used by the secure App Server gate. */
export class InteractionPermitSemaphore implements InteractionSemaphorePort {
  #active = 0;
  readonly #perOwner = new Map<string, number>();

  public constructor(
    private readonly maximum: number,
    private readonly maximumPerOwner: number,
  ) {
    if (
      !Number.isSafeInteger(maximum) ||
      !Number.isSafeInteger(maximumPerOwner) ||
      maximum < 1 ||
      maximumPerOwner < 1 ||
      maximumPerOwner > maximum
    ) {
      throw new Error(
        "Interaction permit concurrency must be positive and the owner cap must not exceed the global cap.",
      );
    }
  }

  public async tryAcquire(input: {
    ownerId: string;
    spaceId: string;
    interactionRunId: string;
  }): Promise<InteractionSemaphoreLease | null> {
    const ownerActive = this.#perOwner.get(input.ownerId) ?? 0;
    if (this.#active >= this.maximum || ownerActive >= this.maximumPerOwner) {
      return null;
    }
    this.#active += 1;
    this.#perOwner.set(input.ownerId, ownerActive + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#active -= 1;
        const remaining = (this.#perOwner.get(input.ownerId) ?? 1) - 1;
        if (remaining === 0) this.#perOwner.delete(input.ownerId);
        else this.#perOwner.set(input.ownerId, remaining);
      },
    };
  }
}

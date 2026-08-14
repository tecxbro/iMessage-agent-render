export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

function validateRule(rule: RateLimitRule): void {
  if (!Number.isInteger(rule.limit) || rule.limit < 1) {
    throw new Error("Rate-limit count must be a positive integer.");
  }
  if (!Number.isInteger(rule.windowMs) || rule.windowMs < 1) {
    throw new Error("Rate-limit window must be a positive integer.");
  }
}

/**
 * Single-process sliding-window limiter. Calls are synchronous, so check and
 * record are atomic within one Node.js event loop. Pairing additionally relies
 * on its injected persistent store for restart-safe attempt accounting.
 */
export class SlidingWindowRateLimiter {
  private readonly attempts = new Map<string, number[]>();

  public consume(
    key: string,
    rule: RateLimitRule,
    now = new Date(),
  ): RateLimitResult {
    validateRule(rule);
    if (key.length === 0 || key.length > 512) {
      throw new Error("Rate-limit keys must be bounded nonempty identifiers.");
    }

    const nowMs = now.getTime();
    const cutoff = nowMs - rule.windowMs;
    const recent = (this.attempts.get(key) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    if (recent.length >= rule.limit) {
      this.attempts.set(key, recent);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(1, recent[0]! + rule.windowMs - nowMs),
      };
    }

    recent.push(nowMs);
    this.attempts.set(key, recent);
    return {
      allowed: true,
      remaining: rule.limit - recent.length,
      retryAfterMs: 0,
    };
  }

  public reset(key: string): void {
    this.attempts.delete(key);
  }
}

export interface OperationalRateLimitOptions {
  messagesPerOwner: RateLimitRule;
  tasksPerOwner: RateLimitRule;
}

export interface OwnerRateLimitPolicy {
  consumeMessage(ownerId: string, now?: Date): RateLimitResult;
  consumeTask(ownerId: string, now?: Date): RateLimitResult;
}

export class OperationalRateLimits implements OwnerRateLimitPolicy {
  private readonly limiter = new SlidingWindowRateLimiter();

  public constructor(private readonly options: OperationalRateLimitOptions) {
    validateRule(options.messagesPerOwner);
    validateRule(options.tasksPerOwner);
  }

  public consumeMessage(ownerId: string, now = new Date()): RateLimitResult {
    return this.limiter.consume(
      `message:${ownerId}`,
      this.options.messagesPerOwner,
      now,
    );
  }

  public consumeTask(ownerId: string, now = new Date()): RateLimitResult {
    return this.limiter.consume(
      `task:${ownerId}`,
      this.options.tasksPerOwner,
      now,
    );
  }
}

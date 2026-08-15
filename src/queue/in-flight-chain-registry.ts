export type ChainScopedOperation = (signal: AbortSignal) => Promise<void>;

export class ChainSupersededError extends Error {
  public constructor() {
    super("A newer message superseded this conversation turn.");
    this.name = "ChainSupersededError";
  }
}

/**
 * Bridges durable chain supersession into the AbortSignal used by active
 * in-process queue handlers. PostgreSQL remains authoritative; this registry
 * only interrupts work that is currently running in this single instance.
 */
export class InFlightChainRegistry {
  readonly #controllers = new Map<string, Set<AbortController>>();

  public async run(
    chainId: string,
    parentSignal: AbortSignal,
    operation: ChainScopedOperation,
  ): Promise<void> {
    const controller = new AbortController();
    const abortFromParent = (): void => {
      controller.abort(parentSignal.reason);
    };
    if (parentSignal.aborted) {
      abortFromParent();
    } else {
      parentSignal.addEventListener("abort", abortFromParent, { once: true });
    }

    const active = this.#controllers.get(chainId) ?? new Set<AbortController>();
    active.add(controller);
    this.#controllers.set(chainId, active);

    try {
      controller.signal.throwIfAborted();
      await operation(controller.signal);
    } catch (error) {
      if (controller.signal.reason instanceof ChainSupersededError) {
        return;
      }
      throw error;
    } finally {
      parentSignal.removeEventListener("abort", abortFromParent);
      active.delete(controller);
      if (active.size === 0) {
        this.#controllers.delete(chainId);
      }
    }
  }

  public cancel(chainIds: readonly string[]): number {
    let canceled = 0;
    for (const chainId of new Set(chainIds)) {
      const active = this.#controllers.get(chainId);
      if (active === undefined) {
        continue;
      }
      for (const controller of active) {
        if (!controller.signal.aborted) {
          controller.abort(new ChainSupersededError());
          canceled += 1;
        }
      }
    }
    return canceled;
  }
}

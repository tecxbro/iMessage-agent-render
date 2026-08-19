interface DeferredSlot {
  resolve(): void;
}

/**
 * Process-local coordination for delivery loops. Database leases remain the
 * cross-process authority; this registry only removes duplicate work inside a
 * process and preserves local per-space ordering around provider sends.
 */
export class DeliveryRegistry {
  readonly #activeBatches = new Map<string, Promise<void>>();
  readonly #spaceTails = new Map<string, Promise<void>>();
  readonly #slotWaiters: DeferredSlot[] = [];
  readonly #maxConcurrentBatches: number;
  #activeSlotCount = 0;

  public constructor(maxConcurrentBatches = 1) {
    if (!Number.isInteger(maxConcurrentBatches) || maxConcurrentBatches < 1) {
      throw new Error(
        "Delivery coordinator concurrency must be a positive integer.",
      );
    }
    this.#maxConcurrentBatches = maxConcurrentBatches;
  }

  public wake(
    outboundBatchId: string,
    run: () => Promise<void>,
  ): Promise<void> {
    const active = this.#activeBatches.get(outboundBatchId);
    if (active !== undefined) {
      return active;
    }

    const started = this.#withCoordinatorSlot(run).finally(() => {
      if (this.#activeBatches.get(outboundBatchId) === started) {
        this.#activeBatches.delete(outboundBatchId);
      }
    });
    this.#activeBatches.set(outboundBatchId, started);
    return started;
  }

  public async withSpaceSlot<Result>(
    spaceId: string,
    run: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.#spaceTails.get(spaceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#spaceTails.set(spaceId, current);

    await previous.catch(() => undefined);
    try {
      return await run();
    } finally {
      release();
      if (this.#spaceTails.get(spaceId) === current) {
        this.#spaceTails.delete(spaceId);
      }
    }
  }

  public isActive(outboundBatchId: string): boolean {
    return this.#activeBatches.has(outboundBatchId);
  }

  public get activeBatchCount(): number {
    return this.#activeBatches.size;
  }

  async #withCoordinatorSlot<Result>(
    run: () => Promise<Result>,
  ): Promise<Result> {
    await this.#acquireCoordinatorSlot();
    try {
      return await run();
    } finally {
      this.#releaseCoordinatorSlot();
    }
  }

  async #acquireCoordinatorSlot(): Promise<void> {
    if (this.#activeSlotCount < this.#maxConcurrentBatches) {
      this.#activeSlotCount += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.#slotWaiters.push({ resolve });
    });
  }

  #releaseCoordinatorSlot(): void {
    const waiter = this.#slotWaiters.shift();
    if (waiter !== undefined) {
      waiter.resolve();
      return;
    }
    this.#activeSlotCount -= 1;
  }
}

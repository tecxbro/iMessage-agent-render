interface SemaphoreWaiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

/** A bounded FIFO semaphore for the interaction lane. */
export class InteractionSemaphore {
  readonly #waiters: SemaphoreWaiter[] = [];
  #activeCount = 0;

  public constructor(public readonly maximumConcurrency: number) {
    if (
      !Number.isSafeInteger(maximumConcurrency) ||
      maximumConcurrency < 1
    ) {
      throw new RangeError(
        "Interaction semaphore concurrency must be a positive safe integer.",
      );
    }
  }

  public get activeCount(): number {
    return this.#activeCount;
  }

  public get pendingCount(): number {
    return this.#waiters.length;
  }

  public acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) {
      return Promise.reject(signal.reason);
    }

    if (this.#activeCount < this.maximumConcurrency) {
      this.#activeCount += 1;
      return Promise.resolve(this.#createRelease());
    }

    return new Promise<() => void>((resolve, reject) => {
      if (signal === undefined) {
        this.#waiters.push({
          resolve,
          reject,
          signal: undefined,
          onAbort: undefined,
        });
        return;
      }

      let waiter: SemaphoreWaiter;
      const onAbort = (): void => {
        const index = this.#waiters.indexOf(waiter);
        if (index < 0) {
          return;
        }
        this.#waiters.splice(index, 1);
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason);
      };
      waiter = { resolve, reject, signal, onAbort };
      this.#waiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  public async runExclusive<Result>(
    operation: () => Promise<Result>,
    signal?: AbortSignal,
  ): Promise<Result> {
    const release = await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      release();
    }
  }

  #createRelease(): () => void {
    let released = false;
    return (): void => {
      if (released) {
        return;
      }
      released = true;
      this.#activeCount -= 1;
      this.#grantNext();
    };
  }

  #grantNext(): void {
    while (this.#activeCount < this.maximumConcurrency) {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) {
        return;
      }
      if (waiter.onAbort !== undefined) {
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
      }
      if (waiter.signal?.aborted === true) {
        waiter.reject(waiter.signal.reason);
        continue;
      }
      this.#activeCount += 1;
      waiter.resolve(this.#createRelease());
    }
  }
}

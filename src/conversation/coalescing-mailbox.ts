interface MailboxWaiter {
  readonly resolve: (version: number) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

/**
 * A process-local hint mailbox. Values coalesce until drained, while every
 * wake advances the version so an actor blocked on runtime completion can
 * notice newly committed input without polling.
 */
export class CoalescingMailbox<Value> {
  readonly #pending = new Set<Value>();
  readonly #waiters = new Set<MailboxWaiter>();
  #version = 0;

  public get version(): number {
    return this.#version;
  }

  public get hasPending(): boolean {
    return this.#pending.size > 0;
  }

  public wake(value: Value): void {
    this.#pending.add(value);
    this.#version =
      this.#version === Number.MAX_SAFE_INTEGER ? 0 : this.#version + 1;

    for (const waiter of this.#waiters) {
      this.#settleWaiter(waiter, this.#version);
    }
  }

  public drain(): ReadonlySet<Value> {
    const values = new Set(this.#pending);
    this.#pending.clear();
    return values;
  }

  public waitForChange(
    afterVersion: number,
    signal?: AbortSignal,
  ): Promise<number> {
    if (this.#version !== afterVersion) {
      return Promise.resolve(this.#version);
    }
    if (signal?.aborted === true) {
      return Promise.reject(signal.reason);
    }

    return new Promise<number>((resolve, reject) => {
      let waiter: MailboxWaiter;
      const onAbort =
        signal === undefined
          ? undefined
          : (): void => {
              this.#rejectWaiter(waiter, signal.reason);
            };
      waiter = { resolve, reject, signal, onAbort };
      this.#waiters.add(waiter);
      signal?.addEventListener("abort", onAbort as () => void, { once: true });
    });
  }

  #settleWaiter(waiter: MailboxWaiter, version: number): void {
    if (!this.#waiters.delete(waiter)) {
      return;
    }
    if (waiter.onAbort !== undefined) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
    }
    waiter.resolve(version);
  }

  #rejectWaiter(waiter: MailboxWaiter, reason: unknown): void {
    if (!this.#waiters.delete(waiter)) {
      return;
    }
    if (waiter.onAbort !== undefined) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
    }
    waiter.reject(reason);
  }
}

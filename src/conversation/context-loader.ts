import {
  boundUntrustedMemory,
  DEFAULT_CACHED_OWNER_PROFILE_BUDGET,
  DEFAULT_REMOTE_MEMORY_BUDGET,
  type BoundedMemoryContent,
  type MemoryBudget,
  type MemoryContent,
  validateMemoryBudget,
} from "./memory-budget.js";
import type {
  InteractionContext,
  InteractionContextLoaderPort,
} from "./contracts.js";

export interface InteractionContextLoadInput {
  spaceId: string;
  interactionRunId: string;
  fromSequence: number;
  throughSequence: number;
  signal?: AbortSignal;
}

export interface CachedOwnerDeploymentContext<Configuration> {
  configuration: Configuration;
  cachedOwnerProfile: readonly MemoryContent[];
}

export interface InteractionContextLoaderDependencies<
  OwnerDeploymentConfiguration,
  ThreadPreparation,
> {
  loadLocalConversation(
    input: InteractionContextLoadInput,
  ): Promise<InteractionContext>;
  loadCachedOwnerDeployment(
    input: InteractionContextLoadInput,
  ): Promise<CachedOwnerDeploymentContext<OwnerDeploymentConfiguration>>;
  prepareThread(
    input: InteractionContextLoadInput,
  ): Promise<ThreadPreparation>;
  recallRemoteMemory(
    input: InteractionContextLoadInput,
    signal: AbortSignal,
  ): Promise<readonly MemoryContent[]>;
}

export type RemoteMemoryDegradedReason = "aborted" | "failed" | "timeout";

export interface RemoteInteractionMemory extends BoundedMemoryContent {
  available: boolean;
  degradedReason?: RemoteMemoryDegradedReason;
}

export interface LoadedInteractionContext<
  OwnerDeploymentConfiguration,
  ThreadPreparation,
> extends InteractionContext {
  ownerDeployment: OwnerDeploymentConfiguration;
  threadPreparation: ThreadPreparation;
  memory: {
    cachedOwnerProfile: BoundedMemoryContent;
    remote: RemoteInteractionMemory;
  };
}

export interface InteractionContextLoaderOptions {
  remoteMemoryTimeoutMs: number;
  cachedOwnerProfileBudget?: MemoryBudget;
  remoteMemoryBudget?: MemoryBudget;
  signal?: AbortSignal;
}

type RemoteRecallOutcome =
  | { kind: "available"; content: readonly MemoryContent[] }
  | { kind: RemoteMemoryDegradedReason };

function start<Output>(operation: () => Promise<Output>): Promise<Output> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

function unavailableRemoteMemory(
  reason: RemoteMemoryDegradedReason,
): RemoteInteractionMemory {
  return {
    available: false,
    degradedReason: reason,
    items: [],
    totalCharacters: 0,
    truncated: false,
  };
}

/**
 * Loads immutable snapshots needed to begin or resume one interaction.
 *
 * The loader owns no actor mutex or database transaction. Callers must invoke
 * `load` only after releasing actor and database locks. Dependency callbacks
 * must return snapshots and must not transfer a held lock to the loader. All
 * four callbacks are invoked before any result is awaited, so remote I/O
 * cannot extend a local critical section.
 */
export class InteractionContextLoader<
  OwnerDeploymentConfiguration,
  ThreadPreparation,
> implements InteractionContextLoaderPort {
  private readonly remoteMemoryTimeoutMs: number;
  private readonly cachedOwnerProfileBudget: MemoryBudget;
  private readonly remoteMemoryBudget: MemoryBudget;
  private readonly lifecycleSignal: AbortSignal | undefined;

  public constructor(
    private readonly dependencies: InteractionContextLoaderDependencies<
      OwnerDeploymentConfiguration,
      ThreadPreparation
    >,
    options: InteractionContextLoaderOptions,
  ) {
    if (
      !Number.isInteger(options.remoteMemoryTimeoutMs) ||
      options.remoteMemoryTimeoutMs <= 0
    ) {
      throw new Error("remoteMemoryTimeoutMs must be a positive integer.");
    }
    this.remoteMemoryTimeoutMs = options.remoteMemoryTimeoutMs;
    this.cachedOwnerProfileBudget = validateMemoryBudget(
      options.cachedOwnerProfileBudget ??
        DEFAULT_CACHED_OWNER_PROFILE_BUDGET,
    );
    this.remoteMemoryBudget = validateMemoryBudget(
      options.remoteMemoryBudget ?? DEFAULT_REMOTE_MEMORY_BUDGET,
    );
    this.lifecycleSignal = options.signal;
  }

  public async load(
    input: InteractionContextLoadInput,
  ): Promise<
    LoadedInteractionContext<
      OwnerDeploymentConfiguration,
      ThreadPreparation
    >
  > {
    // Do not await between these calls. Local history/configuration/thread
    // preparation are mandatory; only the remote-memory branch may degrade.
    const localConversation = start(async () =>
      await this.dependencies.loadLocalConversation(input),
    );
    const ownerDeployment = start(async () =>
      await this.dependencies.loadCachedOwnerDeployment(input),
    );
    const threadPreparation = start(async () =>
      await this.dependencies.prepareThread(input),
    );
    const remoteMemory = this.loadRemoteMemory(input);

    const [local, owner, thread, remote] = await Promise.all([
      localConversation,
      ownerDeployment,
      threadPreparation,
      remoteMemory,
    ]);

    return {
      ...local,
      ownerDeployment: owner.configuration,
      threadPreparation: thread,
      memory: {
        cachedOwnerProfile: boundUntrustedMemory(
          owner.cachedOwnerProfile,
          this.cachedOwnerProfileBudget,
        ),
        remote,
      },
    };
  }

  private async loadRemoteMemory(
    input: InteractionContextLoadInput,
  ): Promise<RemoteInteractionMemory> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const removeAbortListeners: Array<() => void> = [];

    const stopped = new Promise<RemoteRecallOutcome>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ kind: "timeout" });
      }, this.remoteMemoryTimeoutMs);

      const abortSignals = [input.signal, this.lifecycleSignal].filter(
        (signal, index, signals): signal is AbortSignal =>
          signal !== undefined && signals.indexOf(signal) === index,
      );
      for (const signal of abortSignals) {
        const aborted = () => {
          controller.abort();
          resolve({ kind: "aborted" });
        };
        if (signal.aborted) {
          aborted();
        } else {
          signal.addEventListener("abort", aborted, { once: true });
          removeAbortListeners.push(() =>
            signal.removeEventListener("abort", aborted),
          );
        }
      }
    });

    const recall = start(async () =>
      await this.dependencies.recallRemoteMemory(input, controller.signal),
    ).then<RemoteRecallOutcome, RemoteRecallOutcome>(
      (content) => ({ kind: "available", content }),
      () => ({ kind: "failed" }),
    );

    try {
      const outcome = await Promise.race([recall, stopped]);
      if (outcome.kind !== "available") {
        return unavailableRemoteMemory(outcome.kind);
      }
      if (!Array.isArray(outcome.content)) {
        return unavailableRemoteMemory("failed");
      }
      try {
        return {
          available: true,
          ...boundUntrustedMemory(outcome.content, this.remoteMemoryBudget),
        };
      } catch {
        return unavailableRemoteMemory("failed");
      }
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      for (const removeListener of removeAbortListeners) {
        removeListener();
      }
    }
  }
}

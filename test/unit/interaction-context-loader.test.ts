import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InteractionContextLoader,
  type InteractionContextLoadInput,
  type InteractionContextLoaderDependencies,
} from "../../src/conversation/context-loader.js";
import { boundUntrustedMemory } from "../../src/conversation/memory-budget.js";
import type { InteractionContext } from "../../src/conversation/contracts.js";
import type { InteractionContextLoaderPort } from "../../src/conversation/contracts.js";

const input: InteractionContextLoadInput = {
  spaceId: "00000000-0000-4000-8000-000000000001",
  interactionRunId: "00000000-0000-4000-8000-000000000002",
  fromSequence: 3,
  throughSequence: 5,
};

interface OwnerDeploymentConfiguration {
  deploymentId: string;
  ownerId: string;
}

interface ThreadPreparation {
  mode: "start" | "resume";
  threadId?: string;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function localContext(history: readonly string[]): InteractionContext {
  return {
    spaceId: input.spaceId,
    interactionRunId: input.interactionRunId,
    fromSequence: input.fromSequence,
    throughSequence: input.throughSequence,
    messages: [],
    conversationHistory: history,
    taskResults: [],
  };
}

function resolvedDependencies(): InteractionContextLoaderDependencies<
  OwnerDeploymentConfiguration,
  ThreadPreparation
> {
  return {
    loadLocalConversation: vi.fn(async () => localContext(["local history"])),
    loadCachedOwnerDeployment: vi.fn(async () => ({
      configuration: { deploymentId: "deployment-1", ownerId: "owner-1" },
      cachedOwnerProfile: [{ text: "cached profile" }],
    })),
    prepareThread: vi.fn(async () => ({
      mode: "resume" as const,
      threadId: "thread-1",
    })),
    recallRemoteMemory: vi.fn(async () => [{ text: "remote memory" }]),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("interaction context loader", () => {
  it("starts all four snapshots before awaiting and retains every required local result", async () => {
    const local = deferred<InteractionContext>();
    const owner = deferred<{
      configuration: OwnerDeploymentConfiguration;
      cachedOwnerProfile: readonly { text: string }[];
    }>();
    const thread = deferred<ThreadPreparation>();
    const remote = deferred<readonly { text: string }[]>();
    const started: string[] = [];
    const dependencies: InteractionContextLoaderDependencies<
      OwnerDeploymentConfiguration,
      ThreadPreparation
    > = {
      loadLocalConversation: vi.fn(() => {
        started.push("local");
        return local.promise;
      }),
      loadCachedOwnerDeployment: vi.fn(() => {
        started.push("owner");
        return owner.promise;
      }),
      prepareThread: vi.fn(() => {
        started.push("thread");
        return thread.promise;
      }),
      recallRemoteMemory: vi.fn((_request, signal) => {
        expect(signal.aborted).toBe(false);
        started.push("remote");
        return remote.promise;
      }),
    };
    const loader = new InteractionContextLoader(dependencies, {
      remoteMemoryTimeoutMs: 1_000,
    });

    const loaded = loader.load(input);

    // The pending local/database-shaped snapshots do not serialize remote I/O.
    expect(started).toEqual(["local", "owner", "thread", "remote"]);
    local.resolve(localContext(["authoritative local history"]));
    owner.resolve({
      configuration: { deploymentId: "deployment-1", ownerId: "owner-1" },
      cachedOwnerProfile: [{ text: "cached profile" }],
    });
    thread.resolve({ mode: "resume", threadId: "thread-1" });
    remote.resolve([{ text: "remote memory" }]);

    await expect(loaded).resolves.toEqual({
      ...localContext(["authoritative local history"]),
      ownerDeployment: {
        deploymentId: "deployment-1",
        ownerId: "owner-1",
      },
      threadPreparation: { mode: "resume", threadId: "thread-1" },
      memory: {
        cachedOwnerProfile: {
          items: [{ text: "cached profile", trust: "untrusted_context" }],
          totalCharacters: 14,
          truncated: false,
        },
        remote: {
          available: true,
          items: [{ text: "remote memory", trust: "untrusted_context" }],
          totalCharacters: 13,
          truncated: false,
        },
      },
    });
  });

  it("fails open on remote-memory failure while preserving cached profile and local history", async () => {
    const dependencies = resolvedDependencies();
    dependencies.recallRemoteMemory = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const loader = new InteractionContextLoader(dependencies, {
      remoteMemoryTimeoutMs: 50,
    });

    const loaded = await loader.load(input);

    expect(loaded.conversationHistory).toEqual(["local history"]);
    expect(loaded.memory.cachedOwnerProfile.items).toEqual([
      { text: "cached profile", trust: "untrusted_context" },
    ]);
    expect(loaded.memory.remote).toEqual({
      available: false,
      degradedReason: "failed",
      items: [],
      totalCharacters: 0,
      truncated: false,
    });
  });

  it("ends remote recall at its strict budget even when the provider ignores abort", async () => {
    vi.useFakeTimers();
    let recallSignal: AbortSignal | undefined;
    const dependencies = resolvedDependencies();
    dependencies.recallRemoteMemory = vi.fn((_request, signal) => {
      recallSignal = signal;
      return new Promise<never>(() => undefined);
    });
    const loader = new InteractionContextLoader(dependencies, {
      remoteMemoryTimeoutMs: 25,
    });

    const loaded = loader.load(input);
    await vi.advanceTimersByTimeAsync(24);
    expect(recallSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(loaded).resolves.toMatchObject({
      conversationHistory: ["local history"],
      memory: {
        cachedOwnerProfile: {
          items: [{ text: "cached profile", trust: "untrusted_context" }],
        },
        remote: {
          available: false,
          degradedReason: "timeout",
          items: [],
        },
      },
    });
    expect(recallSignal?.aborted).toBe(true);
  });

  it("fails open when remote memory fulfills with a malformed payload", async () => {
    const dependencies = resolvedDependencies();
    dependencies.recallRemoteMemory = vi.fn(async () => null as never);
    const loader = new InteractionContextLoader(dependencies, {
      remoteMemoryTimeoutMs: 50,
    });

    await expect(loader.load(input)).resolves.toMatchObject({
      conversationHistory: ["local history"],
      memory: {
        remote: {
          available: false,
          degradedReason: "failed",
          items: [],
        },
      },
    });
  });

  it("aborts hung recall through the constructor-owned lifecycle signal", async () => {
    const lifecycle = new AbortController();
    let recallSignal: AbortSignal | undefined;
    const dependencies = resolvedDependencies();
    dependencies.recallRemoteMemory = vi.fn((_request, signal) => {
      recallSignal = signal;
      return new Promise<never>(() => undefined);
    });
    const loader: InteractionContextLoaderPort = new InteractionContextLoader(
      dependencies,
      {
        remoteMemoryTimeoutMs: 1_000,
        signal: lifecycle.signal,
      },
    );

    const loaded = loader.load(input);
    lifecycle.abort();

    await expect(loaded).resolves.toMatchObject({
      conversationHistory: ["local history"],
      memory: {
        remote: {
          available: false,
          degradedReason: "aborted",
        },
      },
    });
    expect(recallSignal?.aborted).toBe(true);
  });

  it("bounds memory by item count, item length, and aggregate characters", () => {
    const bounded = boundUntrustedMemory(
      [
        { text: "123456789" },
        { text: 42 },
        { text: "abcdef" },
        { text: "must be dropped" },
      ],
      { maxItems: 2, maxItemCharacters: 6, maxTotalCharacters: 10 },
    );

    expect(bounded).toEqual({
      items: [
        { text: "12345…", trust: "untrusted_context" },
        { text: "abc…", trust: "untrusted_context" },
      ],
      totalCharacters: 10,
      truncated: true,
    });
  });
});

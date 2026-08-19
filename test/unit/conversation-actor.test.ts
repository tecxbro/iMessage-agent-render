import { describe, expect, it, vi } from "vitest";

import { ConversationActor } from "../../src/conversation/actor.js";
import type {
  ConversationRepositoryPort,
  ConversationSnapshot,
  InteractionContext,
  InteractionContextLoaderPort,
  InteractionDeliveryPort,
  InteractionPresencePort,
  InteractionRuntimeCompletion,
  InteractionRuntimePort,
  InteractionStartGatePort,
  InteractionTaskPort,
} from "../../src/conversation/contracts.js";
import { ConversationCoordinator } from "../../src/conversation/coordinator.js";
import { DecisionReconciler } from "../../src/conversation/decision-reconciler.js";
import { InteractionSemaphore } from "../../src/conversation/interaction-semaphore.js";
import type {
  ConversationCasFailure,
  ConversationStateRecord,
  InteractionAuthorizationReference,
  InteractionRunMutationResult,
  InteractionRunRecord,
  InteractionSteerMutationResult,
  InteractionSteerRecord,
} from "../../src/conversation/state.js";
import type { DataCipher } from "../../src/security/data-cipher.js";

const ids = {
  deployment: "31000000-0000-4000-8000-000000000001",
  owner: "31000000-0000-4000-8000-000000000002",
  identity: "31000000-0000-4000-8000-000000000003",
  space1: "31000000-0000-4000-8000-000000000004",
  space2: "31000000-0000-4000-8000-000000000005",
  run1: "31000000-0000-4000-8000-000000000006",
  steer1: "31000000-0000-4000-8000-000000000007",
  run2: "31000000-0000-4000-8000-000000000008",
  run3: "31000000-0000-4000-8000-000000000009",
  message1: "31000000-0000-4000-8000-000000000010",
  message2: "31000000-0000-4000-8000-000000000011",
  message3: "31000000-0000-4000-8000-000000000012",
  batch: "31000000-0000-4000-8000-000000000013",
} as const;

const clock = new Date("2026-08-18T21:00:00.000Z");
const runDefaults = {
  modelId: "gpt-5.6-luna",
  reasoningEffort: "high",
  promptVersion: "conversation-v1",
  promptSha256: "a".repeat(64),
} as const;

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(reason: unknown): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function sameRecord(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  return Object.entries(expected).every(([key, value]) =>
    Object.is(actual[key], value),
  );
}

function sameRun(
  actual: InteractionRunRecord,
  expected: Parameters<ConversationRepositoryPort["checkpointInteraction"]>[0]["expectedRun"],
): boolean {
  return (
    actual.id === expected.interactionRunId &&
    actual.generation === expected.generation &&
    actual.state === expected.state &&
    actual.threadId === expected.threadId &&
    actual.turnId === expected.turnId &&
    actual.acceptedThroughSequence === expected.acceptedThroughSequence
  );
}

class FakeConversationRepository implements ConversationRepositoryPort {
  public state: ConversationStateRecord;
  public activeRun: InteractionRunRecord | null = null;
  public readonly runs = new Map<string, InteractionRunRecord>();
  public readonly steers = new Map<string, InteractionSteerRecord>();
  public readonly messages = new Map<
    number,
    { messageId: string; text: string }
  >();
  public afterFinalizingCheckpoint: (() => void) | undefined;
  public beforeClaimPendingSteer: (() => void) | undefined;
  public loadCount = 0;

  public readonly initializeConversation = vi.fn(async () => ({
    state: clone(this.state),
    backfilledInputCount: 0,
  }));
  public readonly ingestInput = vi.fn(
    async (_input: Parameters<ConversationRepositoryPort["ingestInput"]>[0]) => {
      throw new Error("Tests ingest committed messages through addMessage().");
    },
  );
  public readonly loadConversation = vi.fn(
    async (): Promise<ConversationSnapshot> => {
      this.loadCount += 1;
      if (this.loadCount > 200) {
        throw new Error(
          `Conversation actor exceeded the bounded test reload count: ${JSON.stringify({ state: this.state, run: this.activeRun })}`,
        );
      }
      return {
        state: clone(this.state),
        activeRun: clone(this.activeRun),
      };
    },
  );
  public readonly loadInteractionRun = vi.fn(async (runId: string) =>
    clone(this.runs.get(runId) ?? null),
  );
  public readonly loadAuthorizationReference = vi.fn(
    async (runId: string): Promise<InteractionAuthorizationReference | null> =>
      this.runs.has(runId)
        ? {
            interactionRunId: runId,
            deploymentId: ids.deployment,
            ownerId: ids.owner,
            identityId: ids.identity,
            authorizationRevision: 1,
            createdAt: clock,
          }
        : null,
  );
  public readonly beginInteraction = vi.fn(
    async (
      input: Parameters<ConversationRepositoryPort["beginInteraction"]>[0],
    ): Promise<InteractionRunMutationResult> => {
      if (!sameRecord(this.state, input.expectedConversation)) {
        return this.preconditionFailure("conversation_precondition");
      }
      const generation = this.state.actorGeneration + 1;
      const run: InteractionRunRecord = {
        id: input.interactionRunId,
        spaceId: input.spaceId,
        generation,
        state: "starting",
        threadId: null,
        turnId: null,
        startedThroughSequence: this.state.latestInputSequence,
        acceptedThroughSequence: this.state.latestInputSequence,
        modelId: input.modelId,
        reasoningEffort: input.reasoningEffort,
        promptVersion: input.promptVersion,
        promptSha256: input.promptSha256,
        decisionMetadataJson: null,
        draftOutputCiphertext: null,
        terminalReason: null,
        lastObservedEventJson: null,
        startedAt: clock,
        completedAt: null,
        updatedAt: clock,
      };
      this.runs.set(run.id, run);
      this.activeRun = run;
      this.state = {
        ...this.state,
        actorGeneration: generation,
        activeInteractionRunId: run.id,
        state: "starting",
        acceptedThroughSequence: this.state.latestInputSequence,
        updatedAt: clock,
      };
      return { status: "applied", run: clone(run) };
    },
  );
  public readonly checkpointInteraction = vi.fn(
    async (
      input: Parameters<ConversationRepositoryPort["checkpointInteraction"]>[0],
    ): Promise<InteractionRunMutationResult> => {
      const run = this.runs.get(input.expectedRun.interactionRunId);
      if (!sameRecord(this.state, input.expectedConversation)) {
        return this.preconditionFailure("conversation_precondition");
      }
      if (run === undefined || !sameRun(run, input.expectedRun)) {
        return this.preconditionFailure("run_precondition");
      }
      const updated: InteractionRunRecord = {
        ...run,
        state: input.nextRunState,
        threadId: input.threadId === undefined ? run.threadId : input.threadId,
        turnId: input.turnId === undefined ? run.turnId : input.turnId,
        decisionMetadataJson:
          input.decisionMetadataJson === undefined
            ? run.decisionMetadataJson
            : input.decisionMetadataJson,
        draftOutputCiphertext:
          input.draftOutputCiphertext === undefined
            ? run.draftOutputCiphertext
            : input.draftOutputCiphertext,
        terminalReason:
          input.terminalReason === undefined
            ? run.terminalReason
            : input.terminalReason,
        lastObservedEventJson:
          input.lastObservedEventJson === undefined
            ? run.lastObservedEventJson
            : input.lastObservedEventJson,
        completedAt:
          input.completedAt === undefined ? run.completedAt : input.completedAt,
        acceptedThroughSequence:
          input.nextConversation.acceptedThroughSequence,
        updatedAt: clock,
      };
      this.runs.set(updated.id, updated);
      this.activeRun = input.nextConversation.activeInteractionRunId === null
        ? null
        : updated;
      this.state = {
        ...this.state,
        state: input.nextConversation.state,
        activeInteractionRunId: input.nextConversation.activeInteractionRunId,
        acceptedThroughSequence:
          input.nextConversation.acceptedThroughSequence,
        finalizedThroughSequence:
          input.nextConversation.finalizedThroughSequence,
        updatedAt: clock,
      };
      if (input.nextRunState === "finalizing") {
        this.afterFinalizingCheckpoint?.();
        this.afterFinalizingCheckpoint = undefined;
      }
      return { status: "applied", run: clone(updated) };
    },
  );
  public readonly recoverInteraction = vi.fn(
    async (
      input: Parameters<ConversationRepositoryPort["recoverInteraction"]>[0],
    ): Promise<InteractionRunMutationResult> => {
      const run = this.runs.get(input.expectedRun.interactionRunId);
      if (!sameRecord(this.state, input.expectedConversation)) {
        return this.preconditionFailure("conversation_precondition");
      }
      if (run === undefined || !sameRun(run, input.expectedRun)) {
        return this.preconditionFailure("run_precondition");
      }
      const recovered: InteractionRunRecord = {
        ...run,
        state: input.terminalState,
        terminalReason: input.terminalReason,
        completedAt: input.recoveredAt,
        updatedAt: input.recoveredAt,
      };
      this.runs.set(recovered.id, recovered);
      this.activeRun = null;
      this.state = {
        ...this.state,
        state: "recovering",
        activeInteractionRunId: null,
        updatedAt: input.recoveredAt,
      };
      return { status: "applied", run: clone(recovered) };
    },
  );
  public readonly createSteer = vi.fn(
    async (
      input: Parameters<ConversationRepositoryPort["createSteer"]>[0],
    ): Promise<InteractionSteerMutationResult> => {
      const run = this.runs.get(input.expectedRun.interactionRunId);
      if (!sameRecord(this.state, input.expectedConversation)) {
        return this.steerPreconditionFailure("conversation_precondition");
      }
      if (run === undefined || !sameRun(run, input.expectedRun)) {
        return this.steerPreconditionFailure("run_precondition");
      }
      const steer: InteractionSteerRecord = {
        id: input.id,
        interactionRunId: run.id,
        spaceId: input.spaceId,
        generation: run.generation,
        state: "pending",
        clientUserMessageId: input.clientUserMessageId,
        fromSequence: input.fromSequence,
        throughSequence: input.throughSequence,
        expectedTurnId: input.expectedTurnId,
        submissionGeneration: input.submissionGeneration,
        submittedAt: null,
        acceptedAt: null,
        updatedAt: clock,
      };
      this.steers.set(steer.id, steer);
      return { status: "applied", steer: clone(steer) };
    },
  );
  public readonly claimPendingSteer = vi.fn(
    async (
      input: Parameters<ConversationRepositoryPort["claimPendingSteer"]>[0],
    ) => {
      this.beforeClaimPendingSteer?.();
      this.beforeClaimPendingSteer = undefined;
      const run = this.runs.get(input.expectedRun.interactionRunId);
      if (!sameRecord(this.state, input.expectedConversation)) {
        return this.steerPreconditionFailure("conversation_precondition");
      }
      if (run === undefined || !sameRun(run, input.expectedRun)) {
        return this.steerPreconditionFailure("run_precondition");
      }
      const steer = [...this.steers.values()].find(
        (candidate) =>
          candidate.interactionRunId === run.id && candidate.state === "pending",
      );
      if (steer === undefined) {
        return { status: "none" as const };
      }
      const claimed: InteractionSteerRecord = {
        ...steer,
        state: "submitting",
        submittedAt: clock,
      };
      this.steers.set(claimed.id, claimed);
      return { status: "claimed" as const, steer: clone(claimed) };
    },
  );
  public readonly checkpointSteer = vi.fn(
    async (
      input: Parameters<ConversationRepositoryPort["checkpointSteer"]>[0],
    ): Promise<InteractionSteerMutationResult> => {
      const run = this.runs.get(input.expectedRun.interactionRunId);
      const steer = this.steers.get(input.expectedSteer.interactionSteerId);
      if (!sameRecord(this.state, input.expectedConversation)) {
        return this.steerPreconditionFailure("conversation_precondition");
      }
      if (run === undefined || !sameRun(run, input.expectedRun)) {
        return this.steerPreconditionFailure("run_precondition");
      }
      if (steer === undefined || !sameRecord(steer, {
        id: input.expectedSteer.interactionSteerId,
        state: input.expectedSteer.state,
        expectedTurnId: input.expectedSteer.expectedTurnId,
        submissionGeneration: input.expectedSteer.submissionGeneration,
      })) {
        return this.steerPreconditionFailure("steer_precondition");
      }
      const updated: InteractionSteerRecord = {
        ...steer,
        state: input.nextState,
        submittedAt:
          input.submittedAt === undefined ? steer.submittedAt : input.submittedAt,
        acceptedAt:
          input.acceptedAt === undefined ? steer.acceptedAt : input.acceptedAt,
        updatedAt: clock,
      };
      this.steers.set(updated.id, updated);
      return { status: "applied", steer: clone(updated) };
    },
  );

  public constructor(
    spaceId: string = ids.space1,
    initialMessages: readonly string[] = ["first"],
  ) {
    this.state = {
      spaceId,
      latestInputSequence: 0,
      acceptedThroughSequence: 0,
      finalizedThroughSequence: 0,
      actorGeneration: 0,
      activeInteractionRunId: null,
      state: "idle",
      updatedAt: clock,
    };
    for (const text of initialMessages) {
      this.addMessage(text);
    }
  }

  public addMessage(text: string): void {
    const sequence = this.state.latestInputSequence + 1;
    const messageIds = [ids.message1, ids.message2, ids.message3];
    const messageId = messageIds[sequence - 1] ?? ids.message3;
    this.messages.set(sequence, { messageId, text });
    this.state = {
      ...this.state,
      latestInputSequence: sequence,
      updatedAt: clock,
    };
  }

  public installActiveRun(run: InteractionRunRecord): void {
    this.runs.set(run.id, run);
    this.activeRun = run;
    this.state = {
      ...this.state,
      actorGeneration: run.generation,
      acceptedThroughSequence: run.acceptedThroughSequence,
      activeInteractionRunId: run.id,
      state: run.state === "starting" ? "starting" : "active",
    };
  }

  private preconditionFailure(
    reason: "conversation_precondition" | "run_precondition",
  ): InteractionRunMutationResult {
    return {
      status: "precondition_failed",
      spaceId: this.state.spaceId,
      actorGeneration: this.state.actorGeneration,
      reason,
    };
  }

  private steerPreconditionFailure(
    reason:
      | "conversation_precondition"
      | "run_precondition"
      | "steer_precondition",
  ): ConversationCasFailure {
    return {
      status: "precondition_failed",
      spaceId: this.state.spaceId,
      actorGeneration: this.state.actorGeneration,
      reason,
    };
  }
}

function runtimeCompletion(
  draftOutput: string | null = "answer",
  metadata: Readonly<Record<string, string | number>> = { mode: "direct" },
  suffix = "1",
): InteractionRuntimeCompletion {
  return {
    threadId: `thread-${suffix}`,
    turnId: `turn-${suffix}`,
    decisionMetadataJson: metadata,
    draftOutput,
    lastObservedEventJson: { type: "turn.completed" },
  };
}

function activeRun(
  repository: FakeConversationRepository,
): InteractionRunRecord {
  return {
    id: ids.run1,
    spaceId: repository.state.spaceId,
    generation: 1,
    state: "active",
    threadId: "thread-old",
    turnId: "turn-old",
    startedThroughSequence: 1,
    acceptedThroughSequence: 1,
    ...runDefaults,
    decisionMetadataJson: null,
    draftOutputCiphertext: null,
    terminalReason: null,
    lastObservedEventJson: null,
    startedAt: clock,
    completedAt: null,
    updatedAt: clock,
  };
}

function actorHarness(input: {
  repository?: FakeConversationRepository;
  semaphore?: InteractionSemaphore;
  runtime?: Partial<InteractionRuntimePort>;
  tasks?: InteractionTaskPort;
  contextLoader?: InteractionContextLoaderPort;
  ids?: readonly string[];
  completion?: InteractionRuntimeCompletion;
} = {}) {
  const repository = input.repository ?? new FakeConversationRepository();
  const completion = input.completion ?? runtimeCompletion();
  const runtime: InteractionRuntimePort = {
    start: vi.fn(async () => ({ threadId: "thread-1", turnId: "turn-1" })),
    resume: vi.fn(async () => ({ threadId: "thread-2", turnId: "turn-2" })),
    steer: vi.fn(async () => ({
      turnId: "turn-1",
      acceptedAt: clock,
      lastObservedEventJson: { type: "steer.accepted" },
    })),
    waitForCompletion: vi.fn(async () => completion),
    cancel: vi.fn(async () => undefined),
    ...input.runtime,
  };
  const startGate: InteractionStartGatePort = {
    authorize: vi.fn(async () => ({
      deploymentId: ids.deployment,
      ownerId: ids.owner,
      identityId: ids.identity,
      authorizationRevision: 1,
    })),
    revalidate: vi.fn(async () => true),
  };
  const presence: InteractionPresencePort = {
    start: vi.fn(async () => ({ stop: vi.fn(async () => undefined) })),
  };
  const contextLoader: InteractionContextLoaderPort =
    input.contextLoader ?? {
      load: vi.fn(async ({
        spaceId,
        interactionRunId,
        fromSequence,
        throughSequence,
      }): Promise<InteractionContext> => ({
        spaceId,
        interactionRunId,
        fromSequence,
        throughSequence,
        messages: [...repository.messages.entries()]
          .filter(([sequence]) =>
            sequence >= fromSequence && sequence <= throughSequence,
          )
          .map(([inputSequence, message]) => ({
            messageId: message.messageId,
            inputSequence,
            text: message.text,
          })),
        conversationHistory: [],
        taskResults: [],
      })),
    };
  const tasks: InteractionTaskPort = input.tasks ?? {
    dispatch: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => ({ pendingCount: 0, terminalResults: [] })),
  };
  const delivery: InteractionDeliveryPort = {
    prepare: vi.fn(async () => ({ outboundBatchId: ids.batch })),
  };
  const cipher: DataCipher = {
    encrypt: vi.fn((plaintext) => `cipher:${plaintext}`),
    decrypt: vi.fn((ciphertext) => ciphertext.replace(/^cipher:/u, "")),
  };
  const decisionReconciler = new DecisionReconciler({
    repository,
    tasks,
    delivery,
    cipher,
    now: () => clock,
  });
  const generatedIds = [...(input.ids ?? [ids.run1, ids.steer1, ids.run2])];
  const actor = new ConversationActor({
    spaceId: repository.state.spaceId,
    repository,
    runtime,
    startGate,
    presence,
    contextLoader,
    interactionSemaphore: input.semaphore ?? new InteractionSemaphore(1),
    decisionReconciler,
    runDefaults,
    createId: () => {
      const id = generatedIds.shift();
      if (id === undefined) {
        throw new Error("Test exhausted deterministic IDs.");
      }
      return id;
    },
    now: () => clock,
  });
  return {
    actor,
    repository,
    runtime,
    startGate,
    presence,
    contextLoader,
    tasks,
    delivery,
    cipher,
  };
}

describe("ConversationActor", () => {
  it("coalesces messages arriving during starting into one start and one contiguous steer", async () => {
    const startGate = deferred<{ threadId: string; turnId: string }>();
    const repository = new FakeConversationRepository();
    const fixture = actorHarness({
      repository,
      runtime: { start: vi.fn(async () => startGate.promise) },
    });

    const firstWake = fixture.actor.wake("inbound");
    await vi.waitFor(() => expect(fixture.runtime.start).toHaveBeenCalledOnce());
    repository.addMessage("second");
    repository.addMessage("third");
    const duplicateWakes = Array.from({ length: 10 }, async () =>
      fixture.actor.wake("inbound"),
    );
    startGate.resolve({ threadId: "thread-1", turnId: "turn-1" });

    await Promise.all([firstWake, ...duplicateWakes]);

    expect(repository.beginInteraction).toHaveBeenCalledOnce();
    expect(fixture.runtime.start).toHaveBeenCalledOnce();
    expect(repository.createSteer).toHaveBeenCalledOnce();
    expect(repository.createSteer).toHaveBeenCalledWith(
      expect.objectContaining({ fromSequence: 2, throughSequence: 3 }),
    );
    expect(fixture.runtime.steer).toHaveBeenCalledOnce();
    expect(fixture.runtime.steer).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({ inputSequence: 2, text: "second" }),
          expect.objectContaining({ inputSequence: 3, text: "third" }),
        ],
      }),
    );
    expect(repository.state.finalizedThroughSequence).toBe(3);
  });

  it("turns input committed during finalization into a draft-preserving continuation", async () => {
    const repository = new FakeConversationRepository();
    repository.afterFinalizingCheckpoint = () => repository.addMessage("late");
    const completions = [
      runtimeCompletion("original draft", { mode: "direct" }, "1"),
      runtimeCompletion("revised answer", { mode: "direct" }, "2"),
    ];
    const fixture = actorHarness({
      repository,
      ids: [ids.run1, ids.run2],
      runtime: {
        waitForCompletion: vi.fn(async () => {
          const next = completions.shift();
          if (next === undefined) {
            throw new Error("No completion available.");
          }
          return next;
        }),
      },
    });

    await fixture.actor.wake("inbound");

    expect(fixture.runtime.start).toHaveBeenCalledOnce();
    expect(fixture.runtime.resume).toHaveBeenCalledOnce();
    expect(fixture.runtime.resume).toHaveBeenCalledWith(
      expect.objectContaining({
        run: expect.objectContaining({
          generation: 2,
          draftOutputCiphertext: "cipher:original draft",
        }),
        context: expect.objectContaining({
          fromSequence: 2,
          throughSequence: 2,
          messages: [expect.objectContaining({ text: "late" })],
        }),
      }),
    );
    expect(fixture.delivery.prepare).toHaveBeenCalledOnce();
    expect(fixture.delivery.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ draftOutput: "revised answer", generation: 2 }),
    );
    expect(repository.state.finalizedThroughSequence).toBe(2);
    expect(repository.state.actorGeneration).toBe(2);
  });

  it("leaves every database cursor unchanged when the actor crashes before begin", async () => {
    const repository = new FakeConversationRepository();
    const initial = clone(repository.state);
    const semaphore = new InteractionSemaphore(1);
    const fixture = actorHarness({
      repository,
      semaphore,
      contextLoader: {
        load: vi.fn(async () => {
          throw new Error("context unavailable");
        }),
      },
    });

    await expect(fixture.actor.wake("inbound")).rejects.toThrow(
      "context unavailable",
    );

    expect(repository.state).toMatchObject({
      latestInputSequence: initial.latestInputSequence,
      acceptedThroughSequence: initial.acceptedThroughSequence,
      finalizedThroughSequence: initial.finalizedThroughSequence,
      actorGeneration: initial.actorGeneration,
    });
    expect(repository.beginInteraction).not.toHaveBeenCalled();
    expect(semaphore.activeCount).toBe(0);
    const lease = await vi.mocked(fixture.presence.start).mock.results[0]?.value;
    expect(lease?.stop).toHaveBeenCalledOnce();
  });

  it("revalidates authorization after waiting for interaction capacity", async () => {
    const semaphore = new InteractionSemaphore(1);
    const release = await semaphore.acquire();
    const fixture = actorHarness({ semaphore });

    const waking = fixture.actor.wake("inbound");
    await vi.waitFor(() =>
      expect(fixture.startGate.authorize).toHaveBeenCalledOnce(),
    );
    vi.mocked(fixture.startGate.authorize).mockResolvedValue(null);
    release();
    await waking;

    expect(fixture.startGate.authorize).toHaveBeenCalledTimes(2);
    expect(fixture.presence.start).not.toHaveBeenCalled();
    expect(fixture.repository.beginInteraction).not.toHaveBeenCalled();
    expect(fixture.runtime.start).not.toHaveBeenCalled();
  });

  it("revalidates recovery authorization after waiting for interaction capacity", async () => {
    const repository = new FakeConversationRepository();
    repository.installActiveRun(activeRun(repository));
    const semaphore = new InteractionSemaphore(1);
    const release = await semaphore.acquire();
    const fixture = actorHarness({ repository, semaphore });

    const waking = fixture.actor.wake("recovery");
    await vi.waitFor(() => {
      expect(fixture.startGate.revalidate).toHaveBeenCalledOnce();
      expect(semaphore.pendingCount).toBe(1);
    });
    vi.mocked(fixture.startGate.revalidate).mockResolvedValue(false);
    vi.mocked(fixture.startGate.authorize).mockResolvedValue(null);
    release();
    await waking;

    expect(fixture.startGate.revalidate).toHaveBeenCalledTimes(2);
    expect(fixture.runtime.resume).not.toHaveBeenCalled();
    expect(fixture.runtime.start).not.toHaveBeenCalled();
    expect(repository.recoverInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalReason: "authorization_revalidation_failed",
      }),
    );
  });

  it("steers committed input while reconciling an authoritative runtime session", async () => {
    const repository = new FakeConversationRepository();
    repository.installActiveRun(activeRun(repository));
    repository.addMessage("recovery correction");
    const fixture = actorHarness({
      repository,
      ids: [ids.steer1],
    });

    await fixture.actor.wake("recovery");

    expect(fixture.runtime.resume).toHaveBeenCalledOnce();
    expect(fixture.runtime.steer).toHaveBeenCalledOnce();
    expect(fixture.runtime.steer).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            inputSequence: 2,
            text: "recovery correction",
          }),
        ],
      }),
    );
    expect(repository.state.finalizedThroughSequence).toBe(2);
  });

  it("reloads a benign claim CAS miss without abandoning the active turn", async () => {
    const repository = new FakeConversationRepository();
    repository.beforeClaimPendingSteer = () => repository.addMessage("third");
    const fixture = actorHarness({
      repository,
      ids: [ids.run1, ids.steer1, ids.run2],
      runtime: {
        start: vi.fn(async () => {
          repository.addMessage("second");
          return { threadId: "thread-1", turnId: "turn-1" };
        }),
      },
    });

    await fixture.actor.wake("inbound");

    expect(fixture.runtime.start).toHaveBeenCalledOnce();
    expect(fixture.runtime.resume).not.toHaveBeenCalled();
    expect(fixture.runtime.steer).toHaveBeenCalledTimes(2);
    expect(repository.recoverInteraction).not.toHaveBeenCalled();
    expect(repository.state.finalizedThroughSequence).toBe(3);
  });

  it("terminalizes an uncertain steer and never submits it again", async () => {
    const repository = new FakeConversationRepository();
    let startCount = 0;
    const steerFailure = new Error("steer acknowledgement unknown");
    const fixture = actorHarness({
      repository,
      ids: [ids.run1, ids.steer1, ids.run2],
      runtime: {
        start: vi.fn(async () => {
          startCount += 1;
          if (startCount === 1) {
            repository.addMessage("uncertain correction");
          }
          return {
            threadId: `thread-${startCount}`,
            turnId: `turn-${startCount}`,
          };
        }),
        steer: vi.fn(async () => {
          throw steerFailure;
        }),
      },
    });

    await expect(fixture.actor.wake("inbound")).rejects.toBe(steerFailure);
    expect(fixture.runtime.steer).toHaveBeenCalledOnce();
    expect(repository.recoverInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalState: "interrupted",
        terminalReason: "uncertain_steer_submission",
      }),
    );
    expect(repository.state.finalizedThroughSequence).toBe(0);

    await fixture.actor.wake("recovery");

    expect(fixture.runtime.steer).toHaveBeenCalledOnce();
    expect(repository.state.actorGeneration).toBe(2);
    expect(repository.state.finalizedThroughSequence).toBe(2);
  });

  it("replaces an old starting run that has no runtime session", async () => {
    const repository = new FakeConversationRepository();
    repository.installActiveRun({
      ...activeRun(repository),
      state: "starting",
      threadId: null,
      turnId: null,
    });
    const fixture = actorHarness({
      repository,
      ids: [ids.run2],
    });

    await fixture.actor.wake("recovery");

    expect(repository.recoverInteraction).toHaveBeenCalledOnce();
    expect(repository.recoverInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ terminalState: "interrupted" }),
    );
    expect(fixture.runtime.start).toHaveBeenCalledOnce();
    expect(repository.state.actorGeneration).toBe(2);
    expect(repository.state.finalizedThroughSequence).toBe(1);
  });

  it("does not replace a resumable run after a transient runtime query failure", async () => {
    const repository = new FakeConversationRepository();
    repository.installActiveRun(activeRun(repository));
    const transient = new Error("runtime history temporarily unavailable");
    const fixture = actorHarness({
      repository,
      runtime: {
        resume: vi.fn(async () => {
          throw transient;
        }),
      },
    });

    await expect(fixture.actor.wake("recovery")).rejects.toBe(transient);

    expect(repository.recoverInteraction).not.toHaveBeenCalled();
    expect(fixture.runtime.start).not.toHaveBeenCalled();
    expect(repository.state).toMatchObject({
      actorGeneration: 1,
      state: "active",
      finalizedThroughSequence: 0,
    });
  });

  it("releases interaction capacity before delegated task dispatch settles", async () => {
    const semaphore = new InteractionSemaphore(1);
    const taskGate = deferred<void>();
    const firstTasks: InteractionTaskPort = {
      dispatch: vi.fn(async () => taskGate.promise),
      reconcile: vi.fn(async () => ({ pendingCount: 0, terminalResults: [] })),
    };
    const first = actorHarness({
      semaphore,
      tasks: firstTasks,
      completion: runtimeCompletion(null, { mode: "delegate", taskCount: 1 }),
    });
    const second = actorHarness({
      repository: new FakeConversationRepository(ids.space2),
      semaphore,
      ids: [ids.run3],
      completion: runtimeCompletion("second answer", { mode: "direct" }, "2"),
    });

    const firstWake = first.actor.wake("inbound");
    await vi.waitFor(() => expect(firstTasks.dispatch).toHaveBeenCalledOnce());
    expect(semaphore.activeCount).toBe(0);
    const secondWake = second.actor.wake("inbound");
    await vi.waitFor(() => expect(second.runtime.start).toHaveBeenCalledOnce());

    taskGate.resolve(undefined);
    await Promise.all([firstWake, secondWake]);
    expect(second.delivery.prepare).toHaveBeenCalledOnce();
  });

  it("forwards identifier-only wake hints through the coordinator", async () => {
    const wake = vi.fn(async () => undefined);
    const coordinator = new ConversationCoordinator({ wake });

    await coordinator.coordinate({ spaceId: ids.space1, reason: "late_input" });

    expect(wake).toHaveBeenCalledWith(ids.space1, "late_input");
  });
});

import { describe, expect, it, vi } from "vitest";

import type {
  ConversationSnapshot,
  ConversationRepositoryPort,
  InteractionDeliveryPort,
  InteractionTaskPort,
} from "../../src/conversation/contracts.js";
import {
  DecisionReconciler,
  conversationCasPrecondition,
  interactionRunCasPrecondition,
} from "../../src/conversation/decision-reconciler.js";
import { classifyInteractionRecovery } from "../../src/conversation/recovery-policy.js";
import type {
  ConversationStateRecord,
  InteractionRunMutationResult,
  InteractionRunRecord,
} from "../../src/conversation/state.js";
import type { DataCipher } from "../../src/security/data-cipher.js";

const ids = {
  space: "21000000-0000-4000-8000-000000000001",
  otherSpace: "21000000-0000-4000-8000-000000000002",
  run: "21000000-0000-4000-8000-000000000003",
  otherRun: "21000000-0000-4000-8000-000000000004",
  batch: "21000000-0000-4000-8000-000000000005",
} as const;

const now = new Date("2026-08-18T20:00:00.000Z");

function conversation(
  overrides: Partial<ConversationStateRecord> = {},
): ConversationStateRecord {
  return {
    spaceId: ids.space,
    latestInputSequence: 3,
    acceptedThroughSequence: 3,
    finalizedThroughSequence: 0,
    actorGeneration: 7,
    activeInteractionRunId: ids.run,
    state: "finalizing",
    updatedAt: new Date("2026-08-18T19:59:59.000Z"),
    ...overrides,
  };
}

function interactionRun(
  overrides: Partial<InteractionRunRecord> = {},
): InteractionRunRecord {
  return {
    id: ids.run,
    spaceId: ids.space,
    generation: 7,
    state: "finalizing",
    threadId: "thread-7",
    turnId: "turn-7",
    startedThroughSequence: 1,
    acceptedThroughSequence: 3,
    modelId: "gpt-5.6-luna",
    reasoningEffort: "high",
    promptVersion: "conversation-v1",
    promptSha256: "a".repeat(64),
    decisionMetadataJson: { mode: "direct" },
    draftOutputCiphertext: "cipher:completed draft",
    terminalReason: null,
    lastObservedEventJson: { type: "turn.completed" },
    startedAt: new Date("2026-08-18T19:59:00.000Z"),
    completedAt: null,
    updatedAt: new Date("2026-08-18T19:59:59.000Z"),
    ...overrides,
  };
}

function applied(run: InteractionRunRecord): InteractionRunMutationResult {
  return {
    status: "applied",
    run: {
      ...run,
      state: "completed",
      completedAt: now,
      updatedAt: now,
    },
  };
}

function fakeRepository(input: {
  snapshot: ConversationSnapshot | null;
  run: InteractionRunRecord | null;
  mutation?: InteractionRunMutationResult;
}) {
  const checkpointInteraction = vi.fn(async () =>
    input.mutation ?? applied(input.run ?? interactionRun()),
  );
  const repository = {
    initializeConversation: vi.fn(),
    ingestInput: vi.fn(),
    loadConversation: vi.fn(async () => input.snapshot),
    loadInteractionRun: vi.fn(async () => input.run),
    loadAuthorizationReference: vi.fn(),
    beginInteraction: vi.fn(),
    checkpointInteraction,
    recoverInteraction: vi.fn(),
    createSteer: vi.fn(),
    claimPendingSteer: vi.fn(),
    checkpointSteer: vi.fn(),
  } as unknown as ConversationRepositoryPort;
  return { repository, checkpointInteraction };
}

function dependencies(input: {
  snapshot?: ConversationSnapshot | null;
  run?: InteractionRunRecord | null;
  mutation?: InteractionRunMutationResult;
} = {}) {
  const run = input.run === undefined ? interactionRun() : input.run;
  const snapshot =
    input.snapshot === undefined
      ? { state: conversation(), activeRun: run }
      : input.snapshot;
  const fake = fakeRepository({
    snapshot,
    run,
    ...(input.mutation === undefined ? {} : { mutation: input.mutation }),
  });
  const tasks: InteractionTaskPort = {
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
  const reconciler = new DecisionReconciler({
    repository: fake.repository,
    tasks,
    delivery,
    cipher,
    now: () => now,
  });
  return { ...fake, tasks, delivery, cipher, reconciler };
}

const reconcileInput = {
  spaceId: ids.space,
  interactionRunId: ids.run,
  generation: 7,
} as const;

describe("DecisionReconciler", () => {
  it("materializes a direct draft only after the generation and run fence", async () => {
    const fixture = dependencies();

    expect(fixture.reconciler.encryptDraftOutput("completed draft")).toBe(
      "cipher:completed draft",
    );
    await expect(fixture.reconciler.reconcile(reconcileInput)).resolves.toEqual({
      status: "completed",
      effect: "delivery",
      outboundBatchId: ids.batch,
    });

    expect(fixture.delivery.prepare).toHaveBeenCalledWith({
      interactionRunId: ids.run,
      spaceId: ids.space,
      generation: 7,
      draftOutput: "completed draft",
    });
    expect(fixture.tasks.dispatch).not.toHaveBeenCalled();
    expect(fixture.checkpointInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: ids.space,
        expectedConversation: conversationCasPrecondition(conversation()),
        expectedRun: interactionRunCasPrecondition(interactionRun()),
        nextRunState: "completed",
        nextConversation: {
          state: "idle",
          activeInteractionRunId: null,
          acceptedThroughSequence: 3,
          finalizedThroughSequence: 3,
        },
        draftOutputCiphertext: "cipher:completed draft",
        terminalReason: null,
        completedAt: now,
      }),
    );
  });

  it("dispatches delegated work instead of preparing delivery", async () => {
    const run = interactionRun({
      decisionMetadataJson: { mode: "delegate", taskCount: 2 },
      draftOutputCiphertext: null,
    });
    const fixture = dependencies({
      run,
      snapshot: { state: conversation(), activeRun: run },
    });

    await expect(fixture.reconciler.reconcile(reconcileInput)).resolves.toEqual({
      status: "completed",
      effect: "tasks",
    });

    expect(fixture.tasks.dispatch).toHaveBeenCalledWith({
      interactionRunId: ids.run,
      generation: 7,
      decisionMetadataJson: { mode: "delegate", taskCount: 2 },
    });
    expect(fixture.delivery.prepare).not.toHaveBeenCalled();
  });

  it("does not dispatch delegated work again when tasks already exist", async () => {
    const run = interactionRun({
      decisionMetadataJson: { mode: "delegate", taskCount: 2 },
      draftOutputCiphertext: null,
    });
    const fixture = dependencies({
      run,
      snapshot: { state: conversation(), activeRun: run },
    });
    vi.mocked(fixture.tasks.reconcile).mockResolvedValue({
      pendingCount: 1,
      terminalResults: [],
    });

    await expect(fixture.reconciler.reconcile(reconcileInput)).resolves.toEqual({
      status: "completed",
      effect: "tasks",
    });

    expect(fixture.tasks.dispatch).not.toHaveBeenCalled();
    expect(fixture.delivery.prepare).not.toHaveBeenCalled();
  });

  it("rejects a stale generation before delivery or task side effects", async () => {
    const staleConversation = conversation({ actorGeneration: 8 });
    const fixture = dependencies({
      snapshot: {
        state: staleConversation,
        activeRun: interactionRun(),
      },
    });

    await expect(fixture.reconciler.reconcile(reconcileInput)).resolves.toEqual({
      status: "stale",
    });

    expect(fixture.delivery.prepare).not.toHaveBeenCalled();
    expect(fixture.tasks.dispatch).not.toHaveBeenCalled();
    expect(fixture.checkpointInteraction).not.toHaveBeenCalled();
  });

  it("rejects a stale active-run snapshot before delivery or task side effects", async () => {
    const fixture = dependencies({
      snapshot: {
        state: conversation(),
        activeRun: interactionRun({ id: ids.otherRun }),
      },
    });

    await expect(fixture.reconciler.reconcile(reconcileInput)).resolves.toEqual({
      status: "stale",
    });

    expect(fixture.delivery.prepare).not.toHaveBeenCalled();
    expect(fixture.tasks.dispatch).not.toHaveBeenCalled();
    expect(fixture.checkpointInteraction).not.toHaveBeenCalled();
  });

  it("completes the old run into recovering and returns an encrypted late-input continuation", async () => {
    const state = conversation({ latestInputSequence: 5 });
    const run = interactionRun();
    const fixture = dependencies({
      snapshot: { state, activeRun: run },
      run,
    });

    await expect(fixture.reconciler.reconcile(reconcileInput)).resolves.toEqual({
      status: "continuation",
      draftOutputCiphertext: "cipher:completed draft",
      fromSequence: 4,
    });

    expect(fixture.delivery.prepare).not.toHaveBeenCalled();
    expect(fixture.tasks.dispatch).not.toHaveBeenCalled();
    expect(fixture.checkpointInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedConversation: conversationCasPrecondition(state),
        expectedRun: interactionRunCasPrecondition(run),
        nextRunState: "completed",
        nextConversation: {
          state: "recovering",
          activeInteractionRunId: null,
          acceptedThroughSequence: 3,
          finalizedThroughSequence: 0,
        },
        draftOutputCiphertext: "cipher:completed draft",
        terminalReason: null,
        completedAt: now,
      }),
    );
    expect(fixture.repository.recoverInteraction).not.toHaveBeenCalled();
  });

  it("continues late delegated input with an encrypted empty draft", async () => {
    const state = conversation({ latestInputSequence: 4 });
    const run = interactionRun({
      decisionMetadataJson: { mode: "delegate" },
      draftOutputCiphertext: null,
    });
    const fixture = dependencies({
      snapshot: { state, activeRun: run },
      run,
    });

    await expect(fixture.reconciler.reconcile(reconcileInput)).resolves.toEqual({
      status: "continuation",
      draftOutputCiphertext: "cipher:",
      fromSequence: 4,
    });

    expect(fixture.cipher.encrypt).toHaveBeenCalledWith("");
    expect(fixture.delivery.prepare).not.toHaveBeenCalled();
    expect(fixture.tasks.dispatch).not.toHaveBeenCalled();
  });

  it("reloads authoritative state after a late-input CAS mismatch", async () => {
    const state = conversation({ latestInputSequence: 4 });
    const run = interactionRun();
    const fixture = dependencies({
      snapshot: { state, activeRun: run },
      run,
      mutation: {
        status: "precondition_failed",
        spaceId: ids.space,
        actorGeneration: 7,
        reason: "conversation_precondition",
      },
    });

    await expect(fixture.reconciler.reconcile(reconcileInput)).resolves.toEqual({
      status: "stale",
    });

    expect(fixture.repository.loadConversation).toHaveBeenCalledTimes(2);
    expect(fixture.repository.loadInteractionRun).toHaveBeenCalledTimes(2);
    expect(fixture.delivery.prepare).not.toHaveBeenCalled();
    expect(fixture.tasks.dispatch).not.toHaveBeenCalled();
  });
});

describe("classifyInteractionRecovery", () => {
  it("resumes an authoritative nonterminal run only with a runtime session", () => {
    expect(
      classifyInteractionRecovery({
        conversation: conversation({ state: "active" }),
        run: interactionRun({ state: "active" }),
        sessionAvailable: true,
      }),
    ).toEqual({
      action: "resume",
      reason: "authoritative_session_available",
    });
  });

  it("interrupts an authoritative run whose runtime session is unavailable", () => {
    expect(
      classifyInteractionRecovery({
        conversation: conversation({ state: "active" }),
        run: interactionRun({ state: "active" }),
        sessionAvailable: false,
      }),
    ).toEqual({
      action: "terminalize",
      terminalState: "interrupted",
      terminalReason: "authoritative_runtime_session_unavailable",
      startReplacement: true,
    });
  });

  it("orphans a mismatched nonterminal run regardless of local session availability", () => {
    expect(
      classifyInteractionRecovery({
        conversation: conversation({ activeInteractionRunId: ids.otherRun }),
        run: interactionRun(),
        sessionAvailable: true,
      }),
    ).toEqual({
      action: "terminalize",
      terminalState: "orphaned",
      terminalReason: "authoritative_run_mismatch",
      startReplacement: false,
    });
  });

  it("ignores already terminal history", () => {
    expect(
      classifyInteractionRecovery({
        conversation: null,
        run: interactionRun({
          state: "completed",
          completedAt: now,
          draftOutputCiphertext: null,
        }),
        sessionAvailable: false,
      }),
    ).toEqual({ action: "none", reason: "terminal" });
  });
});

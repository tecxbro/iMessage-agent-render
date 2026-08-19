import { resolve } from "node:path";

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  ConversationCasPrecondition,
  ConversationStateRecord,
  InteractionRunCasPrecondition,
  InteractionRunRecord,
} from "../../src/conversation/state.js";
import { createDatabaseClient, type DatabaseClient } from "../../src/db/client.js";
import { runDatabaseMigrations } from "../../src/db/migrate.js";
import { PostgresConversationRepository } from "../../src/db/repositories/conversation-recovery.js";
import {
  conversationStates,
  interactionAuthorizationReferences,
  interactionRuns,
  interactionSteers,
} from "../../src/db/schema-fragments/conversation-actors.js";
import {
  channelIdentities,
  deployments,
  owners,
  spaces,
} from "../../src/db/schema.js";

const databaseUrl = process.env["POSTGRES_PIPELINE_TEST_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const ids = {
  deployment: "31000000-0000-4000-8000-000000000001",
  owner: "31000000-0000-4000-8000-000000000002",
  identity: "31000000-0000-4000-8000-000000000003",
  space: "31000000-0000-4000-8000-000000000004",
  run1: "31000000-0000-4000-8000-000000000005",
  run2: "31000000-0000-4000-8000-000000000006",
  message1: "31000000-0000-4000-8000-000000000007",
  message2: "31000000-0000-4000-8000-000000000008",
  steer: "31000000-0000-4000-8000-000000000009",
  wrongRun: "31000000-0000-4000-8000-000000000010",
} as const;

function conversationExpected(
  state: ConversationStateRecord,
): ConversationCasPrecondition {
  return {
    actorGeneration: state.actorGeneration,
    state: state.state,
    activeInteractionRunId: state.activeInteractionRunId,
    latestInputSequence: state.latestInputSequence,
    acceptedThroughSequence: state.acceptedThroughSequence,
    finalizedThroughSequence: state.finalizedThroughSequence,
  };
}

function runExpected(run: InteractionRunRecord): InteractionRunCasPrecondition {
  if (
    run.state !== "starting" &&
    run.state !== "active" &&
    run.state !== "finalizing"
  ) {
    throw new Error("Test fixture requires a nonterminal interaction run.");
  }
  return {
    interactionRunId: run.id,
    generation: run.generation,
    state: run.state,
    threadId: run.threadId,
    turnId: run.turnId,
    acceptedThroughSequence: run.acceptedThroughSequence,
  };
}

async function seed(client: DatabaseClient): Promise<void> {
  await client.database.insert(deployments).values({
    id: ids.deployment,
    name: "interaction-runs",
    defaultModelProfile: "main",
  });
  await client.database.insert(owners).values({
    id: ids.owner,
    deploymentId: ids.deployment,
    timezone: "UTC",
  });
  await client.database.insert(channelIdentities).values({
    id: ids.identity,
    deploymentId: ids.deployment,
    ownerId: ids.owner,
    normalizedHandleCiphertext: "cipher:owner",
    handleFingerprint: "interaction-owner",
    role: "owner",
    verifiedAt: new Date("2026-08-18T12:00:00Z"),
  });
  await client.database.insert(spaces).values({
    id: ids.space,
    deploymentId: ids.deployment,
    externalSpaceGuid: "interaction-space",
    type: "dm",
    lastMessageAt: new Date("2026-08-18T12:00:00Z"),
  });
}

describeDatabase("interaction run compare-and-set repository", () => {
  let client: DatabaseClient;
  let repository: PostgresConversationRepository;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      return;
    }
    client = createDatabaseClient({ connectionString: databaseUrl });
    await runDatabaseMigrations(client, resolve("src/db/migrations"));
    repository = new PostgresConversationRepository(client.database);
  });

  beforeEach(async () => {
    await client.pool.query("truncate table deployments restart identity cascade");
    await seed(client);
    await repository.ingestInput({
      messageId: ids.message1,
      spaceId: ids.space,
      externalMessageId: "interaction-message-1",
      senderIdentityId: ids.identity,
      contentCiphertext: "cipher:message-1",
      contentHash: "hash:message-1",
      receivedAt: new Date("2026-08-18T12:00:01Z"),
      retentionExpiresAt: new Date("2026-09-18T12:00:01Z"),
    });
  });

  afterAll(async () => {
    await client?.close();
  });

  function startingInput(interactionRunId: string) {
    return {
      interactionRunId,
      spaceId: ids.space,
      expectedConversation: {
        actorGeneration: 0,
        state: "idle" as const,
        activeInteractionRunId: null,
        latestInputSequence: 1,
        acceptedThroughSequence: 0,
        finalizedThroughSequence: 0,
      },
      modelId: "gpt-5.6-luna",
      reasoningEffort: "high",
      promptVersion: "conversation-v1",
      promptSha256: "a".repeat(64),
      authorization: {
        deploymentId: ids.deployment,
        ownerId: ids.owner,
        identityId: ids.identity,
        authorizationRevision: 1,
      },
    };
  }

  async function loadActive(): Promise<{
    state: ConversationStateRecord;
    run: InteractionRunRecord;
  }> {
    const snapshot = await repository.loadActorSnapshot(ids.space);
    if (snapshot?.activeRun === null || snapshot === null) {
      throw new Error("Expected an active run fixture.");
    }
    return { state: snapshot.state, run: snapshot.activeRun };
  }

  it("allows exactly one concurrent starting run per space", async () => {
    const results = await Promise.all([
      repository.createStartingRun(startingInput(ids.run1)),
      repository.createStartingRun(startingInput(ids.run2)),
    ]);
    expect(results.filter((result) => result.status === "applied")).toHaveLength(1);
    expect(results.find((result) => result.status !== "applied")).toEqual({
      status: "stale_generation",
      spaceId: ids.space,
      expectedActorGeneration: 0,
      actualActorGeneration: 1,
    });

    const activeRows = await client.database
      .select({ id: interactionRuns.id })
      .from(interactionRuns)
      .where(
        inArray(interactionRuns.state, ["starting", "active", "finalizing"]),
      );
    expect(activeRows).toHaveLength(1);
    const pointers = await client.database.select().from(conversationStates);
    expect(pointers).toHaveLength(1);
    expect(pointers[0]?.activeInteractionRunId).toBe(activeRows[0]?.id);
    const authorizationRows = await client.database
      .select()
      .from(interactionAuthorizationReferences);
    expect(authorizationRows).toHaveLength(1);
  });

  it("persists the full run, steer, decision, draft, and finalization lifecycle", async () => {
    expect((await repository.createStartingRun(startingInput(ids.run1))).status).toBe(
      "applied",
    );
    let active = await loadActive();
    const markedActive = await repository.markRunActive({
      spaceId: ids.space,
      expectedConversation: conversationExpected(active.state),
      expectedRun: runExpected(active.run),
    });
    expect(markedActive.status).toBe("applied");

    active = await loadActive();
    const identity = await repository.recordTurnIdentity({
      spaceId: ids.space,
      expectedConversation: conversationExpected(active.state),
      expectedRun: runExpected(active.run),
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(identity).toMatchObject({
      status: "applied",
      run: { threadId: "thread-1", turnId: "turn-1" },
    });

    await repository.ingestInput({
      messageId: ids.message2,
      spaceId: ids.space,
      externalMessageId: "interaction-message-2",
      senderIdentityId: ids.identity,
      contentCiphertext: "cipher:message-2",
      contentHash: "hash:message-2",
      receivedAt: new Date("2026-08-18T12:00:02Z"),
      retentionExpiresAt: new Date("2026-09-18T12:00:02Z"),
    });
    active = await loadActive();
    expect(active.state).toMatchObject({
      latestInputSequence: 2,
      acceptedThroughSequence: 1,
    });
    const createdSteer = await repository.createSteer({
      id: ids.steer,
      spaceId: ids.space,
      expectedConversation: conversationExpected(active.state),
      expectedRun: runExpected(active.run),
      clientUserMessageId: ids.message2,
      fromSequence: 2,
      throughSequence: 2,
      expectedTurnId: "turn-1",
      submissionGeneration: 1,
    });
    expect(createdSteer).toMatchObject({ status: "applied", steer: { state: "pending" } });

    const pending =
      createdSteer.status === "applied" ? createdSteer.steer : undefined;
    expect(pending).toBeDefined();
    const submitting = await repository.beginSteerSubmission({
      spaceId: ids.space,
      expectedConversation: conversationExpected(active.state),
      expectedRun: runExpected(active.run),
      expectedSteer: {
        interactionSteerId: ids.steer,
        state: "pending",
        expectedTurnId: "turn-1",
        submissionGeneration: 1,
      },
      submittedAt: new Date("2026-08-18T12:00:03Z"),
    });
    expect(submitting).toMatchObject({
      status: "applied",
      steer: { state: "submitting" },
    });

    const accepted = await repository.markSteerAccepted({
      spaceId: ids.space,
      expectedConversation: {
        ...conversationExpected(active.state),
        actorGeneration: 0,
      },
      expectedRun: runExpected(active.run),
      expectedSteer: {
        interactionSteerId: ids.steer,
        state: "submitting",
        expectedTurnId: "turn-1",
        submissionGeneration: 1,
      },
      acceptedAt: new Date("2026-08-18T12:00:04Z"),
    });
    expect(accepted).toEqual({
      status: "stale_generation",
      spaceId: ids.space,
      expectedActorGeneration: 0,
      actualActorGeneration: 1,
    });
    const [stillSubmitting] = await client.database
      .select()
      .from(interactionSteers)
      .where(eq(interactionSteers.id, ids.steer));
    expect(stillSubmitting).toMatchObject({ state: "submitting", acceptedAt: null });

    const acceptedAfterReload = await repository.markSteerAccepted({
      spaceId: ids.space,
      expectedConversation: conversationExpected(active.state),
      expectedRun: runExpected(active.run),
      expectedSteer: {
        interactionSteerId: ids.steer,
        state: "submitting",
        expectedTurnId: "turn-1",
        submissionGeneration: 1,
      },
      acceptedAt: new Date("2026-08-18T12:00:04Z"),
    });
    expect(acceptedAfterReload).toMatchObject({
      status: "applied",
      steer: { state: "accepted" },
    });
    active = await loadActive();
    const reversedAcceptedSteer = await repository.beginSteerSubmission({
      spaceId: ids.space,
      expectedConversation: conversationExpected(active.state),
      expectedRun: runExpected(active.run),
      expectedSteer: {
        interactionSteerId: ids.steer,
        state: "accepted",
        expectedTurnId: "turn-1",
        submissionGeneration: 1,
      },
      submittedAt: new Date("2026-08-18T12:00:04Z"),
    });
    expect(reversedAcceptedSteer).toMatchObject({
      status: "precondition_failed",
      reason: "steer_precondition",
    });

    expect(active.state.acceptedThroughSequence).toBe(2);
    expect(active.run.acceptedThroughSequence).toBe(2);
    const decision = await repository.storeTerminalDecision({
      spaceId: ids.space,
      expectedConversation: conversationExpected(active.state),
      expectedRun: runExpected(active.run),
      decisionMetadataJson: { route: "direct" },
      lastObservedEventJson: { type: "turn.completed" },
    });
    expect(decision).toMatchObject({
      status: "applied",
      run: { state: "finalizing", decisionMetadataJson: { route: "direct" } },
    });

    active = await loadActive();
    const draft = await repository.storeUndeliveredDraft({
      spaceId: ids.space,
      expectedConversation: conversationExpected(active.state),
      expectedRun: runExpected(active.run),
      draftOutputCiphertext: "cipher:terminal-answer",
    });
    expect(draft).toMatchObject({
      status: "applied",
      run: { draftOutputCiphertext: "cipher:terminal-answer" },
    });

    active = await loadActive();
    const staleFinalization = await repository.finalizeRun({
      spaceId: ids.space,
      expectedConversation: {
        ...conversationExpected(active.state),
        actorGeneration: 0,
      },
      expectedRun: runExpected(active.run),
      completedAt: new Date("2026-08-18T12:00:05Z"),
    });
    expect(staleFinalization).toEqual({
      status: "stale_generation",
      spaceId: ids.space,
      expectedActorGeneration: 0,
      actualActorGeneration: 1,
    });
    expect((await loadActive()).run).toMatchObject({
      state: "finalizing",
      completedAt: null,
      draftOutputCiphertext: "cipher:terminal-answer",
    });

    active = await loadActive();
    const finalized = await repository.finalizeRun({
      spaceId: ids.space,
      expectedConversation: conversationExpected(active.state),
      expectedRun: runExpected(active.run),
      completedAt: new Date("2026-08-18T12:00:06Z"),
    });
    expect(finalized).toMatchObject({ status: "applied", run: { state: "completed" } });
    const finalSnapshot = await repository.loadActorSnapshot(ids.space);
    expect(finalSnapshot).toMatchObject({
      state: {
        state: "idle",
        activeInteractionRunId: null,
        latestInputSequence: 2,
        acceptedThroughSequence: 2,
        finalizedThroughSequence: 2,
      },
      activeRun: null,
    });
  });

  it("returns typed precondition failures without mutating same-generation state", async () => {
    await repository.createStartingRun(startingInput(ids.run1));
    const active = await loadActive();
    for (const invalidTransition of [
      repository.storeTerminalDecision({
        spaceId: ids.space,
        expectedConversation: conversationExpected(active.state),
        expectedRun: runExpected(active.run),
        decisionMetadataJson: { route: "invalid-early" },
        lastObservedEventJson: null,
      }),
      repository.storeUndeliveredDraft({
        spaceId: ids.space,
        expectedConversation: conversationExpected(active.state),
        expectedRun: runExpected(active.run),
        draftOutputCiphertext: "cipher:invalid-early",
      }),
      repository.finalizeRun({
        spaceId: ids.space,
        expectedConversation: conversationExpected(active.state),
        expectedRun: runExpected(active.run),
        completedAt: new Date("2026-08-18T12:00:30Z"),
      }),
    ]) {
      await expect(invalidTransition).resolves.toMatchObject({
        status: "precondition_failed",
        reason: "run_precondition",
      });
    }
    const wrongPointer = await repository.markRunActive({
      spaceId: ids.space,
      expectedConversation: {
        ...conversationExpected(active.state),
        activeInteractionRunId: ids.wrongRun,
      },
      expectedRun: runExpected(active.run),
    });
    expect(wrongPointer).toEqual({
      status: "precondition_failed",
      spaceId: ids.space,
      actorGeneration: 1,
      reason: "conversation_precondition",
    });
    expect((await loadActive()).run.state).toBe("starting");

    await repository.markRunActive({
      spaceId: ids.space,
      expectedConversation: conversationExpected(active.state),
      expectedRun: runExpected(active.run),
    });
    const nowActive = await loadActive();
    const wrongRunState = await repository.recordTurnIdentity({
      spaceId: ids.space,
      expectedConversation: conversationExpected(nowActive.state),
      expectedRun: { ...runExpected(nowActive.run), state: "starting" },
      threadId: "late-thread",
      turnId: "late-turn",
    });
    expect(wrongRunState).toEqual({
      status: "precondition_failed",
      spaceId: ids.space,
      actorGeneration: 1,
      reason: "run_precondition",
    });
    expect((await loadActive()).run).toMatchObject({ threadId: null, turnId: null });
  });

  it("marks authoritative runs interrupted and invalidated runs orphaned", async () => {
    await repository.createStartingRun(startingInput(ids.run1));
    let active = await loadActive();
    const staleInterrupted = await repository.markRunInterrupted({
      spaceId: ids.space,
      expectedConversation: {
        ...conversationExpected(active.state),
        actorGeneration: 0,
      },
      expectedRun: runExpected(active.run),
      terminalReason: "coordinator_shutdown",
      recoveredAt: new Date("2026-08-18T12:01:00Z"),
    });
    expect(staleInterrupted).toEqual({
      status: "stale_generation",
      spaceId: ids.space,
      expectedActorGeneration: 0,
      actualActorGeneration: 1,
    });
    const interrupted = await repository.markRunInterrupted({
      spaceId: ids.space,
      expectedConversation: conversationExpected(active.state),
      expectedRun: runExpected(active.run),
      terminalReason: "coordinator_shutdown",
      recoveredAt: new Date("2026-08-18T12:01:00Z"),
    });
    expect(interrupted).toMatchObject({
      status: "applied",
      run: { state: "interrupted", terminalReason: "coordinator_shutdown" },
    });
    expect(await repository.loadActorSnapshot(ids.space)).toMatchObject({
      state: { state: "recovering", activeInteractionRunId: null },
      activeRun: null,
    });

    await client.pool.query("truncate table deployments restart identity cascade");
    await seed(client);
    await repository.ingestInput({
      messageId: ids.message1,
      spaceId: ids.space,
      externalMessageId: "orphan-message",
      senderIdentityId: ids.identity,
      contentCiphertext: "cipher:orphan",
      contentHash: "hash:orphan",
      receivedAt: new Date("2026-08-18T12:02:00Z"),
      retentionExpiresAt: new Date("2026-09-18T12:02:00Z"),
    });
    await repository.createStartingRun(startingInput(ids.run1));
    active = await loadActive();
    const incremented = await repository.incrementActorGeneration({
      spaceId: ids.space,
      expectedConversation: conversationExpected(active.state),
      nextState: "recovering",
      nextActiveInteractionRunId: null,
    });
    expect(incremented).toMatchObject({
      status: "applied",
      state: { actorGeneration: 2, state: "recovering", activeInteractionRunId: null },
    });
    const orphanConversation =
      incremented.status === "applied" ? incremented.state : undefined;
    expect(orphanConversation).toBeDefined();
    const staleIncrement = await repository.incrementActorGeneration({
      spaceId: ids.space,
      expectedConversation: conversationExpected(active.state),
      nextState: "recovering",
      nextActiveInteractionRunId: null,
    });
    expect(staleIncrement).toEqual({
      status: "stale_generation",
      spaceId: ids.space,
      expectedActorGeneration: 1,
      actualActorGeneration: 2,
    });
    const invalidatedCallback = await repository.markRunActive({
      spaceId: ids.space,
      expectedConversation: conversationExpected(orphanConversation!),
      expectedRun: runExpected(active.run),
    });
    expect(invalidatedCallback).toMatchObject({
      status: "precondition_failed",
      reason: "run_precondition",
    });
    const staleOrphan = await repository.markRunOrphaned({
      spaceId: ids.space,
      expectedConversation: conversationExpected(active.state),
      expectedRun: runExpected(active.run),
      terminalReason: "generation_invalidated",
      recoveredAt: new Date("2026-08-18T12:02:01Z"),
    });
    expect(staleOrphan).toEqual({
      status: "stale_generation",
      spaceId: ids.space,
      expectedActorGeneration: 1,
      actualActorGeneration: 2,
    });
    const orphaned = await repository.markRunOrphaned({
      spaceId: ids.space,
      expectedConversation: conversationExpected(orphanConversation!),
      expectedRun: runExpected(active.run),
      terminalReason: "generation_invalidated",
      recoveredAt: new Date("2026-08-18T12:02:01Z"),
    });
    expect(orphaned).toMatchObject({
      status: "applied",
      run: { state: "orphaned", terminalReason: "generation_invalidated" },
    });
    const [persistedOrphan] = await client.database
      .select()
      .from(interactionRuns)
      .where(eq(interactionRuns.id, ids.run1));
    expect(persistedOrphan).toMatchObject({ state: "orphaned" });
    expect(await client.database.select().from(interactionSteers)).toHaveLength(0);
  });
});

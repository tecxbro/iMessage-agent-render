import { resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseClient, type DatabaseClient } from "../../src/db/client.js";
import { runDatabaseMigrations } from "../../src/db/migrate.js";
import {
  ConversationRecoveryRepository,
  PostgresConversationRepository,
} from "../../src/db/repositories/conversation-recovery.js";
import {
  conversationStates,
  interactionRuns,
  interactionSteers,
} from "../../src/db/schema-fragments/conversation-actors.js";
import {
  channelIdentities,
  deployments,
  messages,
  owners,
  spaces,
} from "../../src/db/schema.js";

const databaseUrl = process.env["POSTGRES_PIPELINE_TEST_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const ids = {
  deployment: "41000000-0000-4000-8000-000000000001",
  owner: "41000000-0000-4000-8000-000000000002",
  identity: "41000000-0000-4000-8000-000000000003",
  spaceA: "41000000-0000-4000-8000-000000000004",
  spaceB: "41000000-0000-4000-8000-000000000005",
  runStarting: "41000000-0000-4000-8000-000000000006",
  runActive: "41000000-0000-4000-8000-000000000007",
  runFinalizing: "41000000-0000-4000-8000-000000000008",
  runCompleted: "41000000-0000-4000-8000-000000000009",
  runInterrupted: "41000000-0000-4000-8000-000000000010",
  runFailed: "41000000-0000-4000-8000-000000000021",
  runCanceled: "41000000-0000-4000-8000-000000000022",
  runOrphaned: "41000000-0000-4000-8000-000000000023",
  message1: "41000000-0000-4000-8000-000000000011",
  message2: "41000000-0000-4000-8000-000000000012",
  message3: "41000000-0000-4000-8000-000000000013",
  otherMessage: "41000000-0000-4000-8000-000000000014",
  outboundMessage: "41000000-0000-4000-8000-000000000015",
  steerPending: "41000000-0000-4000-8000-000000000016",
  steerSubmitting: "41000000-0000-4000-8000-000000000017",
  steerAccepted: "41000000-0000-4000-8000-000000000018",
  steerSuperseded: "41000000-0000-4000-8000-000000000019",
  steerFailed: "41000000-0000-4000-8000-000000000020",
} as const;

async function seedRecoveryState(client: DatabaseClient): Promise<void> {
  const baseTime = new Date("2026-08-18T13:00:00Z");
  await client.database.insert(deployments).values({
    id: ids.deployment,
    name: "interaction-recovery",
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
    handleFingerprint: "recovery-owner",
    role: "owner",
    verifiedAt: baseTime,
  });
  await client.database.insert(spaces).values([
    {
      id: ids.spaceA,
      deploymentId: ids.deployment,
      externalSpaceGuid: "recovery-space-a",
      type: "dm",
      lastMessageAt: baseTime,
    },
    {
      id: ids.spaceB,
      deploymentId: ids.deployment,
      externalSpaceGuid: "recovery-space-b",
      type: "dm",
      lastMessageAt: baseTime,
    },
  ]);
  await client.database.insert(messages).values([
    {
      id: ids.message1,
      spaceId: ids.spaceA,
      externalMessageId: "recovery-1",
      direction: "inbound",
      inputSequence: 1,
      senderIdentityId: ids.identity,
      contentCiphertext: "cipher:recovery-1",
      contentHash: "hash:recovery-1",
      receivedAt: new Date("2026-08-18T13:00:01Z"),
      retentionExpiresAt: new Date("2026-09-18T13:00:01Z"),
    },
    {
      id: ids.message2,
      spaceId: ids.spaceA,
      externalMessageId: "recovery-2",
      direction: "inbound",
      inputSequence: 2,
      senderIdentityId: ids.identity,
      contentCiphertext: "cipher:recovery-2",
      contentHash: "hash:recovery-2",
      receivedAt: new Date("2026-08-18T13:00:02Z"),
      retentionExpiresAt: new Date("2026-09-18T13:00:02Z"),
    },
    {
      id: ids.message3,
      spaceId: ids.spaceA,
      externalMessageId: "recovery-3",
      direction: "inbound",
      inputSequence: 3,
      senderIdentityId: ids.identity,
      contentCiphertext: "cipher:recovery-3",
      contentHash: "hash:recovery-3",
      receivedAt: new Date("2026-08-18T13:00:03Z"),
      retentionExpiresAt: new Date("2026-09-18T13:00:03Z"),
    },
    {
      id: ids.otherMessage,
      spaceId: ids.spaceB,
      externalMessageId: "other-space",
      direction: "inbound",
      inputSequence: 1,
      senderIdentityId: ids.identity,
      contentCiphertext: "cipher:other-space",
      contentHash: "hash:other-space",
      receivedAt: new Date("2026-08-18T13:00:04Z"),
      retentionExpiresAt: new Date("2026-09-18T13:00:04Z"),
    },
    {
      id: ids.outboundMessage,
      spaceId: ids.spaceA,
      externalMessageId: "outbound",
      direction: "outbound",
      inputSequence: 2,
      contentCiphertext: "cipher:outbound",
      contentHash: "hash:outbound",
      sentAt: new Date("2026-08-18T13:00:05Z"),
      retentionExpiresAt: new Date("2026-09-18T13:00:05Z"),
    },
  ]);

  const runBase = {
    spaceId: ids.spaceA,
    startedThroughSequence: 1,
    acceptedThroughSequence: 1,
    modelId: "gpt-5.6-luna",
    reasoningEffort: "high",
    promptVersion: "conversation-v1",
    promptSha256: "b".repeat(64),
  };
  await client.database.insert(interactionRuns).values([
    {
      ...runBase,
      id: ids.runStarting,
      generation: 1,
      state: "starting",
      updatedAt: new Date("2026-08-18T13:01:01Z"),
    },
    {
      ...runBase,
      id: ids.runActive,
      generation: 2,
      state: "active",
      threadId: "thread-recovery",
      turnId: "turn-recovery",
      updatedAt: new Date("2026-08-18T13:01:02Z"),
    },
    {
      ...runBase,
      id: ids.runFinalizing,
      generation: 3,
      state: "finalizing",
      acceptedThroughSequence: 3,
      threadId: "thread-current",
      turnId: "turn-current",
      updatedAt: new Date("2026-08-18T13:01:03Z"),
    },
    {
      ...runBase,
      id: ids.runCompleted,
      generation: 4,
      state: "completed",
      completedAt: new Date("2026-08-18T13:01:04Z"),
      updatedAt: new Date("2026-08-18T13:01:04Z"),
    },
    {
      ...runBase,
      id: ids.runInterrupted,
      generation: 5,
      state: "interrupted",
      terminalReason: "coordinator_shutdown",
      completedAt: new Date("2026-08-18T13:01:05Z"),
      updatedAt: new Date("2026-08-18T13:01:05Z"),
    },
    {
      ...runBase,
      id: ids.runFailed,
      generation: 6,
      state: "failed",
      terminalReason: "runtime_failed",
      completedAt: new Date("2026-08-18T13:01:06Z"),
      updatedAt: new Date("2026-08-18T13:01:06Z"),
    },
    {
      ...runBase,
      id: ids.runCanceled,
      generation: 7,
      state: "canceled",
      terminalReason: "owner_canceled",
      completedAt: new Date("2026-08-18T13:01:07Z"),
      updatedAt: new Date("2026-08-18T13:01:07Z"),
    },
    {
      ...runBase,
      id: ids.runOrphaned,
      generation: 8,
      state: "orphaned",
      terminalReason: "generation_invalidated",
      completedAt: new Date("2026-08-18T13:01:08Z"),
      updatedAt: new Date("2026-08-18T13:01:08Z"),
    },
  ]);
  await client.database.insert(conversationStates).values([
    {
      spaceId: ids.spaceA,
      latestInputSequence: 3,
      acceptedThroughSequence: 1,
      finalizedThroughSequence: 1,
      actorGeneration: 2,
      activeInteractionRunId: ids.runActive,
      state: "active",
    },
    {
      spaceId: ids.spaceB,
      latestInputSequence: 1,
      acceptedThroughSequence: 1,
      finalizedThroughSequence: 1,
      actorGeneration: 1,
      activeInteractionRunId: null,
      state: "idle",
    },
  ]);
  await client.database.insert(interactionSteers).values([
    {
      id: ids.steerPending,
      interactionRunId: ids.runActive,
      spaceId: ids.spaceA,
      generation: 2,
      state: "pending",
      clientUserMessageId: ids.message2,
      fromSequence: 2,
      throughSequence: 2,
      expectedTurnId: "turn-recovery",
      submissionGeneration: 1,
      updatedAt: new Date("2026-08-18T13:02:01Z"),
    },
    {
      id: ids.steerSubmitting,
      interactionRunId: ids.runActive,
      spaceId: ids.spaceA,
      generation: 2,
      state: "submitting",
      clientUserMessageId: ids.message3,
      fromSequence: 3,
      throughSequence: 3,
      expectedTurnId: "turn-recovery",
      submissionGeneration: 2,
      submittedAt: new Date("2026-08-18T13:02:02Z"),
      updatedAt: new Date("2026-08-18T13:02:02Z"),
    },
    {
      id: ids.steerAccepted,
      interactionRunId: ids.runActive,
      spaceId: ids.spaceA,
      generation: 2,
      state: "accepted",
      clientUserMessageId: ids.message1,
      fromSequence: 1,
      throughSequence: 1,
      expectedTurnId: "turn-recovery",
      submissionGeneration: 3,
      submittedAt: new Date("2026-08-18T13:02:03Z"),
      acceptedAt: new Date("2026-08-18T13:02:04Z"),
      updatedAt: new Date("2026-08-18T13:02:04Z"),
    },
    {
      id: ids.steerSuperseded,
      interactionRunId: ids.runStarting,
      spaceId: ids.spaceA,
      generation: 1,
      state: "superseded",
      clientUserMessageId: ids.message1,
      fromSequence: 1,
      throughSequence: 1,
      expectedTurnId: null,
      submissionGeneration: 1,
      updatedAt: new Date("2026-08-18T13:02:05Z"),
    },
    {
      id: ids.steerFailed,
      interactionRunId: ids.runFinalizing,
      spaceId: ids.spaceA,
      generation: 3,
      state: "failed",
      clientUserMessageId: ids.message1,
      fromSequence: 1,
      throughSequence: 1,
      expectedTurnId: "turn-current",
      submissionGeneration: 1,
      submittedAt: new Date("2026-08-18T13:02:05Z"),
      updatedAt: new Date("2026-08-18T13:02:06Z"),
    },
  ]);
}

describeDatabase("conversation recovery queries", () => {
  let client: DatabaseClient;
  let recovery: ConversationRecoveryRepository;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      return;
    }
    client = createDatabaseClient({ connectionString: databaseUrl });
    await runDatabaseMigrations(client, resolve("src/db/migrations"));
    recovery = new ConversationRecoveryRepository(client.database);
  });

  beforeEach(async () => {
    await client.pool.query("truncate table deployments restart identity cascade");
    await seedRecoveryState(client);
  });

  afterAll(async () => {
    await client?.close();
  });

  it("finds behind cursors, every nonterminal run, and only uncertain submitting steers", async () => {
    expect(await recovery.findSpacesWithUnfinalizedInput()).toEqual([
      ids.spaceA,
    ]);
    expect(
      await recovery.findSpacesWithUnfinalizedInput({
        limit: 1,
        afterSpaceId: ids.spaceA,
      }),
    ).toEqual([]);
    expect(await recovery.findSpacesBehindCursor()).toEqual([ids.spaceA]);
    expect((await recovery.findSpacesBehindCursor(1))).toEqual([ids.spaceA]);

    const active = await recovery.findActiveRuns();
    expect(active.map((run) => run.id)).toEqual([
      ids.runStarting,
      ids.runActive,
      ids.runFinalizing,
    ]);
    expect(active.every((run) => run.completedAt === null)).toBe(true);

    const uncertain = await recovery.findUncertainSteers();
    expect(uncertain).toEqual([
      expect.objectContaining({
        id: ids.steerSubmitting,
        state: "submitting",
        interactionRunId: ids.runActive,
        expectedTurnId: "turn-recovery",
        submissionGeneration: 2,
        fromSequence: 3,
        throughSequence: 3,
      }),
    ]);
  });

  it("loads an inclusive ordered inbound sequence range and the exact active pointer", async () => {
    const range = await recovery.loadMessagesBySequenceRange({
      spaceId: ids.spaceA,
      fromSequence: 2,
      throughSequence: 3,
    });
    expect(range.map((message) => message.messageId)).toEqual([
      ids.message2,
      ids.message3,
    ]);
    expect(range.map((message) => message.inputSequence)).toEqual([2, 3]);
    expect(range.every((message) => message.spaceId === ids.spaceA)).toBe(true);

    const activeSnapshot = await recovery.loadActorSnapshot(ids.spaceA);
    expect(activeSnapshot).toMatchObject({
      state: {
        actorGeneration: 2,
        activeInteractionRunId: ids.runActive,
        latestInputSequence: 3,
        finalizedThroughSequence: 1,
      },
      activeRun: {
        id: ids.runActive,
        generation: 2,
        state: "active",
      },
    });
    expect(await recovery.loadActorSnapshot(ids.spaceB)).toMatchObject({
      state: { state: "idle", activeInteractionRunId: null },
      activeRun: null,
    });
  });

  it("discovers an uncertain steer through a fresh database client after restart", async () => {
    const transitions = new PostgresConversationRepository(client.database);
    const submitted = await transitions.beginSteerSubmission({
      spaceId: ids.spaceA,
      expectedConversation: {
        actorGeneration: 2,
        state: "active",
        activeInteractionRunId: ids.runActive,
        latestInputSequence: 3,
        acceptedThroughSequence: 1,
        finalizedThroughSequence: 1,
      },
      expectedRun: {
        interactionRunId: ids.runActive,
        generation: 2,
        state: "active",
        threadId: "thread-recovery",
        turnId: "turn-recovery",
        acceptedThroughSequence: 1,
      },
      expectedSteer: {
        interactionSteerId: ids.steerPending,
        state: "pending",
        expectedTurnId: "turn-recovery",
        submissionGeneration: 1,
      },
      submittedAt: new Date("2026-08-18T13:03:00Z"),
    });
    expect(submitted).toMatchObject({
      status: "applied",
      steer: { id: ids.steerPending, state: "submitting" },
    });
    const restartedClient = createDatabaseClient({ connectionString: databaseUrl! });
    try {
      const restartedRecovery = new ConversationRecoveryRepository(
        restartedClient.database,
      );
      const uncertain = await restartedRecovery.findUncertainSteers();
      expect(uncertain).toHaveLength(2);
      expect(uncertain).toContainEqual(expect.objectContaining({
        id: ids.steerPending,
        interactionRunId: ids.runActive,
        spaceId: ids.spaceA,
        generation: 2,
        state: "submitting",
        clientUserMessageId: ids.message2,
        expectedTurnId: "turn-recovery",
        submissionGeneration: 1,
        submittedAt: new Date("2026-08-18T13:03:00Z"),
      }));
    } finally {
      await restartedClient.close();
    }
  });
});

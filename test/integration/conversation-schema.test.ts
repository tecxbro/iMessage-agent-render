import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { runDatabaseMigrations } from "../../src/db/migrate.js";
import {
  conversationStates,
  interactionAuthorizationReferences,
  interactionRuns,
  interactionSteers,
} from "../../src/db/schema-fragments/conversation-actors.js";
import {
  chains,
  channelIdentities,
  deployments,
  messages,
  outboundBatches,
  owners,
  spaces,
} from "../../src/db/schema.js";

const databaseUrl = process.env["POSTGRES_PIPELINE_TEST_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const ids = {
  deployment: "11000000-0000-4000-8000-000000000001",
  owner: "11000000-0000-4000-8000-000000000002",
  identity: "11000000-0000-4000-8000-000000000003",
  space: "11000000-0000-4000-8000-000000000004",
  run: "11000000-0000-4000-8000-000000000005",
  chain: "11000000-0000-4000-8000-000000000006",
  batch: "11000000-0000-4000-8000-000000000007",
  claim: "11000000-0000-4000-8000-000000000008",
  message1: "11000000-0000-4000-8000-000000000009",
  message2: "11000000-0000-4000-8000-000000000010",
  message3: "11000000-0000-4000-8000-000000000011",
  message4: "11000000-0000-4000-8000-000000000012",
  message5: "11000000-0000-4000-8000-000000000013",
  steer1: "11000000-0000-4000-8000-000000000014",
  steer2: "11000000-0000-4000-8000-000000000015",
  steer3: "11000000-0000-4000-8000-000000000016",
} as const;

function inboundMessage(
  id: string,
  externalMessageId: string,
  inputSequence: number | null,
) {
  return {
    id,
    spaceId: ids.space,
    externalMessageId,
    direction: "inbound" as const,
    inputSequence,
    senderIdentityId: ids.identity,
    contentCiphertext: `cipher:${externalMessageId}`,
    contentHash: `hash:${externalMessageId}`,
    receivedAt: new Date("2026-08-18T00:00:01Z"),
    retentionExpiresAt: new Date("2026-09-18T00:00:01Z"),
  };
}

describeDatabase("conversation actor schema migration", () => {
  let client: DatabaseClient;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      return;
    }
    client = createDatabaseClient({ connectionString: databaseUrl });
    await runDatabaseMigrations(client, resolve("src/db/migrations"));
  });

  beforeEach(async () => {
    await client.pool.query(
      "truncate table deployments restart identity cascade",
    );
    await client.database.insert(deployments).values({
      id: ids.deployment,
      name: "conversation-schema-integration",
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
      handleFingerprint: "fingerprint-owner",
      role: "owner",
      verifiedAt: new Date("2026-08-18T00:00:00Z"),
    });
    await client.database.insert(spaces).values({
      id: ids.space,
      deploymentId: ids.deployment,
      externalSpaceGuid: "conversation-schema-space",
      type: "dm",
      lastMessageAt: new Date("2026-08-18T00:00:00Z"),
    });
  });

  afterAll(async () => {
    await client?.close();
  });

  it("keeps legacy message sequences nullable and enforces inbound uniqueness", async () => {
    await client.database.insert(messages).values([
      inboundMessage(ids.message1, "legacy-1", null),
      inboundMessage(ids.message2, "legacy-2", null),
      inboundMessage(ids.message3, "sequenced-1", 1),
    ]);

    await expect(
      client.database
        .insert(messages)
        .values(inboundMessage(ids.message4, "sequenced-duplicate", 1)),
    ).rejects.toThrow();

    await expect(
      client.database.insert(messages).values({
        id: ids.message5,
        spaceId: ids.space,
        externalMessageId: "outbound-same-sequence",
        direction: "outbound",
        inputSequence: 1,
        contentCiphertext: "cipher:outbound",
        contentHash: "hash:outbound",
        sentAt: new Date("2026-08-18T00:00:02Z"),
        retentionExpiresAt: new Date("2026-09-18T00:00:02Z"),
      }),
    ).resolves.toBeDefined();
  });

  it("enforces conversation sequence ordering and nonnegative generation", async () => {
    await client.database.insert(conversationStates).values({
      spaceId: ids.space,
      latestInputSequence: 3,
      acceptedThroughSequence: 2,
      finalizedThroughSequence: 1,
      actorGeneration: 1,
    });

    await expect(
      client.database
        .update(conversationStates)
        .set({ finalizedThroughSequence: 3 })
        .where(eq(conversationStates.spaceId, ids.space)),
    ).rejects.toThrow();
    await expect(
      client.database
        .update(conversationStates)
        .set({ acceptedThroughSequence: 4 })
        .where(eq(conversationStates.spaceId, ids.space)),
    ).rejects.toThrow();
    await expect(
      client.database
        .update(conversationStates)
        .set({ finalizedThroughSequence: -1 })
        .where(eq(conversationStates.spaceId, ids.space)),
    ).rejects.toThrow();
    await expect(
      client.database
        .update(conversationStates)
        .set({ actorGeneration: -1 })
        .where(eq(conversationStates.spaceId, ids.space)),
    ).rejects.toThrow();
  });

  it("persists run provenance, steering reconciliation, and unused leases", async () => {
    await client.database.insert(messages).values([
      inboundMessage(ids.message1, "input-1", 1),
      inboundMessage(ids.message2, "input-2", 2),
      inboundMessage(ids.message3, "input-3", 3),
    ]);
    await client.database.insert(interactionRuns).values({
      id: ids.run,
      spaceId: ids.space,
      generation: 1,
      state: "active",
      threadId: "thread-1",
      turnId: "turn-1",
      startedThroughSequence: 1,
      acceptedThroughSequence: 3,
      modelId: "gpt-5.6-luna",
      reasoningEffort: "high",
      promptVersion: "conversation-v1",
      promptSha256: "a".repeat(64),
      decisionMetadataJson: { route: "direct" },
      draftOutputCiphertext: "cipher:user-visible-draft",
    });
    await expect(
      client.database.insert(interactionRuns).values({
        id: "11000000-0000-4000-8000-000000000020",
        spaceId: ids.space,
        generation: 2,
        state: "interrupted",
        startedThroughSequence: 1,
        acceptedThroughSequence: 3,
        modelId: "gpt-5.6-luna",
        reasoningEffort: "high",
        promptVersion: "conversation-v1",
        promptSha256: "b".repeat(64),
        terminalReason: "coordinator_shutdown",
      }),
    ).rejects.toThrow();
    await expect(
      client.database.insert(interactionRuns).values({
        id: "11000000-0000-4000-8000-000000000020",
        spaceId: ids.space,
        generation: 2,
        state: "interrupted",
        startedThroughSequence: 1,
        acceptedThroughSequence: 3,
        modelId: "gpt-5.6-luna",
        reasoningEffort: "high",
        promptVersion: "conversation-v1",
        promptSha256: "b".repeat(64),
        terminalReason: "coordinator_shutdown",
        completedAt: new Date("2026-08-18T00:00:03Z"),
      }),
    ).resolves.toBeDefined();
    await expect(
      client.database.insert(interactionRuns).values({
        id: "11000000-0000-4000-8000-000000000021",
        spaceId: ids.space,
        generation: 3,
        state: "orphaned",
        startedThroughSequence: 1,
        acceptedThroughSequence: 3,
        modelId: "gpt-5.6-luna",
        reasoningEffort: "high",
        promptVersion: "conversation-v1",
        promptSha256: "c".repeat(64),
        completedAt: new Date("2026-08-18T00:00:04Z"),
      }),
    ).rejects.toThrow();
    await client.database.insert(interactionAuthorizationReferences).values({
      interactionRunId: ids.run,
      deploymentId: ids.deployment,
      ownerId: ids.owner,
      identityId: ids.identity,
      authorizationRevision: 7,
    });
    await client.database.insert(conversationStates).values({
      spaceId: ids.space,
      latestInputSequence: 3,
      acceptedThroughSequence: 3,
      finalizedThroughSequence: 0,
      actorGeneration: 1,
      activeInteractionRunId: ids.run,
      state: "active",
    });
    await client.database.insert(chains).values({
      id: ids.chain,
      spaceId: ids.space,
      version: 1,
      chainStartedAt: new Date("2026-08-18T00:00:02Z"),
      sourceInteractionRunId: ids.run,
    });
    await expect(
      client.database.insert(chains).values({
        id: "11000000-0000-4000-8000-000000000018",
        spaceId: ids.space,
        version: 2,
        chainStartedAt: new Date("2026-08-18T00:00:03Z"),
        sourceInteractionRunId: "11000000-0000-4000-8000-000000000019",
      }),
    ).rejects.toThrow();
    await client.database.insert(outboundBatches).values({
      id: ids.batch,
      chainId: ids.chain,
      spaceId: ids.space,
      partCount: 0,
      claimOwner: "delivery-worker-1",
      claimToken: ids.claim,
      claimExpiresAt: new Date("2026-08-18T00:01:00Z"),
    });
    await client.database.insert(interactionSteers).values({
      id: ids.steer1,
      interactionRunId: ids.run,
      spaceId: ids.space,
      generation: 1,
      clientUserMessageId: ids.message1,
      fromSequence: 1,
      throughSequence: 2,
      expectedTurnId: "turn-1",
      submissionGeneration: 1,
    });

    await expect(
      client.database.insert(interactionSteers).values({
        id: ids.steer2,
        interactionRunId: ids.run,
        spaceId: ids.space,
        generation: 1,
        clientUserMessageId: ids.message1,
        fromSequence: 2,
        throughSequence: 3,
        expectedTurnId: "turn-1",
        submissionGeneration: 2,
      }),
    ).rejects.toThrow();
    await expect(
      client.database.insert(interactionSteers).values({
        id: ids.steer2,
        interactionRunId: ids.run,
        spaceId: ids.space,
        generation: 1,
        clientUserMessageId: ids.message2,
        fromSequence: 1,
        throughSequence: 2,
        expectedTurnId: "turn-1",
        submissionGeneration: 2,
      }),
    ).rejects.toThrow();
    await expect(
      client.database.insert(interactionSteers).values({
        id: ids.steer3,
        interactionRunId: ids.run,
        spaceId: ids.space,
        generation: 1,
        clientUserMessageId: ids.message3,
        fromSequence: 3,
        throughSequence: 2,
        expectedTurnId: "turn-1",
        submissionGeneration: 3,
      }),
    ).rejects.toThrow();

    await expect(
      client.database.insert(interactionRuns).values({
        id: "11000000-0000-4000-8000-000000000017",
        spaceId: ids.space,
        generation: 1,
        startedThroughSequence: 1,
        acceptedThroughSequence: 1,
        modelId: "gpt-5.6-luna",
        reasoningEffort: "high",
        promptVersion: "conversation-v1",
        promptSha256: "b".repeat(64),
      }),
    ).rejects.toThrow();

    const [run] = await client.database
      .select()
      .from(interactionRuns)
      .where(eq(interactionRuns.id, ids.run));
    const [authorization] = await client.database
      .select()
      .from(interactionAuthorizationReferences)
      .where(eq(interactionAuthorizationReferences.interactionRunId, ids.run));
    const [batch] = await client.database
      .select()
      .from(outboundBatches)
      .where(eq(outboundBatches.id, ids.batch));

    expect(run).toMatchObject({
      decisionMetadataJson: { route: "direct" },
      draftOutputCiphertext: "cipher:user-visible-draft",
    });
    expect(authorization).toMatchObject({
      deploymentId: ids.deployment,
      ownerId: ids.owner,
      identityId: ids.identity,
      authorizationRevision: 7,
    });
    expect(batch).toMatchObject({
      claimOwner: "delivery-worker-1",
      claimToken: ids.claim,
      claimExpiresAt: new Date("2026-08-18T00:01:00Z"),
    });
  });
});

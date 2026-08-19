import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseClient, type DatabaseClient } from "../../src/db/client.js";
import { runDatabaseMigrations } from "../../src/db/migrate.js";
import { conversationStates } from "../../src/db/schema-fragments/conversation-actors.js";
import {
  chains,
  channelIdentities,
  deployments,
  messages,
  owners,
  spaces,
} from "../../src/db/schema.js";
import { PostgresConversationRepository } from "../../src/db/repositories/conversation-recovery.js";
import { SequencedInboundRepository } from "../../src/db/repositories/sequenced-inbound.js";

const databaseUrl = process.env["POSTGRES_PIPELINE_TEST_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const ids = {
  deployment: "21000000-0000-4000-8000-000000000001",
  owner: "21000000-0000-4000-8000-000000000002",
  identity: "21000000-0000-4000-8000-000000000003",
  spaceA: "21000000-0000-4000-8000-000000000004",
  spaceB: "21000000-0000-4000-8000-000000000005",
  run: "21000000-0000-4000-8000-000000000006",
  chain1: "21000000-0000-4000-8000-000000000007",
  chain2: "21000000-0000-4000-8000-000000000008",
} as const;

function messageId(position: number): string {
  return `21000000-0000-4000-8000-${position.toString().padStart(12, "0")}`;
}

function inboundInput(input: {
  id: string;
  spaceId?: string;
  externalMessageId: string;
  receivedAt?: Date;
}) {
  return {
    messageId: input.id,
    spaceId: input.spaceId ?? ids.spaceA,
    externalMessageId: input.externalMessageId,
    senderIdentityId: ids.identity,
    contentCiphertext: `cipher:${input.externalMessageId}`,
    contentHash: `hash:${input.externalMessageId}`,
    receivedAt: input.receivedAt ?? new Date("2026-08-18T10:00:00Z"),
    retentionExpiresAt: new Date("2026-09-18T10:00:00Z"),
  };
}

async function seedIdentityAndSpaces(client: DatabaseClient): Promise<void> {
  await client.database.insert(deployments).values({
    id: ids.deployment,
    name: "conversation-ingestion",
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
    handleFingerprint: "ingestion-owner",
    role: "owner",
    verifiedAt: new Date("2026-08-18T09:00:00Z"),
  });
  await client.database.insert(spaces).values([
    {
      id: ids.spaceA,
      deploymentId: ids.deployment,
      externalSpaceGuid: "ingestion-space-a",
      type: "dm",
      interactionThreadId: "legacy-thread-canary",
      interactionSummary: "legacy-summary-canary",
      lastMessageAt: new Date("2026-08-18T09:00:00Z"),
    },
    {
      id: ids.spaceB,
      deploymentId: ids.deployment,
      externalSpaceGuid: "ingestion-space-b",
      type: "dm",
      lastMessageAt: new Date("2026-08-18T09:00:00Z"),
    },
  ]);
}

async function waitForApplicationLock(
  client: DatabaseClient,
  applicationName: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await client.pool.query<{ waiting: boolean }>(
      `select exists (
         select 1
         from pg_stat_activity
         where application_name = $1
           and wait_event_type = 'Lock'
       ) as waiting`,
      [applicationName],
    );
    if (result.rows[0]?.waiting === true) {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error("space A ingest did not reach the expected row-lock wait");
}

describe("sequenced inbound repository boundary", () => {
  it("has no queue publisher or actor wake dependency", async () => {
    const source = await readFile(
      resolve("src/db/repositories/sequenced-inbound.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/queue|publish|wakeActor|wake_actor/iu);
  });
});

describeDatabase("transactional conversation ingestion", () => {
  let client: DatabaseClient;
  let sequenced: SequencedInboundRepository;
  let repository: PostgresConversationRepository;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      return;
    }
    client = createDatabaseClient({ connectionString: databaseUrl });
    await runDatabaseMigrations(client, resolve("src/db/migrations"));
    sequenced = new SequencedInboundRepository(client.database);
    repository = new PostgresConversationRepository(client.database);
  });

  beforeEach(async () => {
    await client.pool.query("truncate table deployments restart identity cascade");
    await seedIdentityAndSpaces(client);
  });

  afterAll(async () => {
    await client?.close();
  });

  it("returns the original sequence for a duplicate without consuming a number", async () => {
    const first = await sequenced.ingestInput(
      inboundInput({
        id: messageId(101),
        externalMessageId: "provider-duplicate",
      }),
    );
    const duplicate = await sequenced.ingestInput(
      inboundInput({
        id: messageId(102),
        externalMessageId: "provider-duplicate",
      }),
    );
    const second = await sequenced.ingestInput(
      inboundInput({ id: messageId(103), externalMessageId: "provider-next" }),
    );

    expect(first).toEqual({
      messageId: messageId(101),
      spaceId: ids.spaceA,
      inputSequence: 1,
      inserted: true,
    });
    expect(duplicate).toEqual({ ...first, inserted: false });
    expect(second.inputSequence).toBe(2);

    const persisted = await client.database
      .select({ id: messages.id, sequence: messages.inputSequence })
      .from(messages)
      .where(eq(messages.spaceId, ids.spaceA))
      .orderBy(asc(messages.inputSequence));
    expect(persisted).toEqual([
      { id: messageId(101), sequence: 1 },
      { id: messageId(103), sequence: 2 },
    ]);
  });

  it("serializes concurrent inserts into one gap-free sequence per space", async () => {
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        sequenced.ingestInput(
          inboundInput({
            id: messageId(200 + index),
            externalMessageId: `concurrent-${index}`,
          }),
        ),
      ),
    );

    expect(results.map((result) => result.inputSequence).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );
    const [state] = await client.database
      .select()
      .from(conversationStates)
      .where(eq(conversationStates.spaceId, ids.spaceA));
    expect(state).toMatchObject({ latestInputSequence: 16 });
    const persisted = await client.database
      .select({
        externalMessageId: messages.externalMessageId,
        inputSequence: messages.inputSequence,
      })
      .from(messages)
      .where(eq(messages.spaceId, ids.spaceA))
      .orderBy(asc(messages.inputSequence));
    expect(persisted).toHaveLength(16);
    expect(persisted.map((row) => row.inputSequence)).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );
    expect(new Set(persisted.map((row) => row.externalMessageId)).size).toBe(16);
  });

  it("does not use a global lock across different spaces", async () => {
    await repository.initializeConversation({ spaceId: ids.spaceA });
    await repository.initializeConversation({ spaceId: ids.spaceB });
    const lockingClient = await client.pool.connect();
    const spaceAApplicationName = "conversation-ingestion-space-a-lock-test";
    const spaceAClient = createDatabaseClient({
      connectionString: databaseUrl!,
      applicationName: spaceAApplicationName,
    });
    const spaceARepository = new SequencedInboundRepository(
      spaceAClient.database,
    );
    let insertA: Promise<unknown> | undefined;
    try {
      await lockingClient.query("begin");
      await lockingClient.query(
        'select space_id from conversation_states where space_id = $1 for update',
        [ids.spaceA],
      );

      let spaceACompleted = false;
      insertA = spaceARepository
        .ingestInput(
          inboundInput({
            id: messageId(301),
            externalMessageId: "blocked-space-a",
          }),
        )
        .then((result) => {
          spaceACompleted = true;
          return result;
        });
      await waitForApplicationLock(client, spaceAApplicationName);
      const insertB = sequenced.ingestInput(
        inboundInput({
          id: messageId(302),
          spaceId: ids.spaceB,
          externalMessageId: "free-space-b",
        }),
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const completedB = await Promise.race([
        insertB,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("space B was blocked by space A")),
            5_000,
          );
        }),
      ]).finally(() => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
      });
      expect(completedB).toMatchObject({ spaceId: ids.spaceB, inputSequence: 1 });
      expect(spaceACompleted).toBe(false);
    } finally {
      await lockingClient.query("rollback");
      lockingClient.release();
      await insertA;
      await spaceAClient.close();
    }
  });

  it("advances latest for late input without changing the active accepted cursor", async () => {
    await repository.ingestInput(
      inboundInput({ id: messageId(401), externalMessageId: "run-input" }),
    );
    const initial = await repository.loadActorSnapshot(ids.spaceA);
    expect(initial).not.toBeNull();
    const started = await repository.createStartingRun({
      interactionRunId: ids.run,
      spaceId: ids.spaceA,
      expectedConversation: {
        actorGeneration: 0,
        state: "idle",
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
    });
    expect(started.status).toBe("applied");

    await repository.ingestInput(
      inboundInput({ id: messageId(402), externalMessageId: "late-input" }),
    );
    const after = await repository.loadActorSnapshot(ids.spaceA);
    expect(after?.state).toMatchObject({
      latestInputSequence: 2,
      acceptedThroughSequence: 1,
      finalizedThroughSequence: 0,
      actorGeneration: 1,
      activeInteractionRunId: ids.run,
      state: "starting",
    });
    expect(after?.activeRun).toMatchObject({ acceptedThroughSequence: 1 });
  });

  it("sequences observe-mode input without taking finalization ownership", async () => {
    await client.database.insert(chains).values({
      id: ids.chain1,
      spaceId: ids.spaceA,
      version: 1,
      state: "complete",
      chainStartedAt: new Date("2026-08-18T10:00:00Z"),
      completedAt: new Date("2026-08-18T10:01:00Z"),
    });
    await client.database.insert(messages).values({
      id: messageId(450),
      spaceId: ids.spaceA,
      externalMessageId: "legacy-complete-before-observe",
      direction: "inbound",
      inputSequence: null,
      senderIdentityId: ids.identity,
      contentCiphertext: "cipher:legacy-complete-before-observe",
      contentHash: "hash:legacy-complete-before-observe",
      receivedAt: new Date("2026-08-18T10:00:00Z"),
      retentionExpiresAt: new Date("2026-09-18T10:00:00Z"),
      drainedChainId: ids.chain1,
    });

    const ingested = await repository.ingestObservedInput(
      inboundInput({
        id: messageId(451),
        externalMessageId: "first-observed-input",
        receivedAt: new Date("2026-08-18T10:02:00Z"),
      }),
    );

    expect(ingested).toMatchObject({
      status: "inserted",
      input: { inputSequence: 2 },
    });
    const snapshot = await repository.loadActorSnapshot(ids.spaceA);
    expect(snapshot?.state).toMatchObject({
      latestInputSequence: 2,
      acceptedThroughSequence: 0,
      finalizedThroughSequence: 0,
    });
  });

  it("initializes legacy rows by received_at and id and leaves an incomplete suffix outstanding", async () => {
    const receivedAt = new Date("2026-08-18T11:00:00Z");
    const legacyIds = [messageId(501), messageId(502), messageId(503), messageId(504)];
    await client.database.insert(messages).values(
      legacyIds.map((id, index) => ({
        id,
        spaceId: ids.spaceA,
        externalMessageId: `legacy-${index}`,
        direction: "inbound" as const,
        inputSequence: null,
        senderIdentityId: ids.identity,
        contentCiphertext: `cipher:legacy-${index}`,
        contentHash: `hash:legacy-${index}`,
        receivedAt,
        retentionExpiresAt: new Date("2026-09-18T11:00:00Z"),
        createdAt: new Date(`2026-08-18T11:00:0${4 - index}Z`),
      })),
    );
    await client.database.insert(chains).values([
      {
        id: ids.chain1,
        spaceId: ids.spaceA,
        version: 1,
        state: "complete",
        chainStartedAt: receivedAt,
        completedAt: new Date("2026-08-18T11:01:00Z"),
      },
      {
        id: ids.chain2,
        spaceId: ids.spaceA,
        version: 2,
        state: "complete",
        chainStartedAt: receivedAt,
        completedAt: new Date("2026-08-18T11:02:00Z"),
      },
    ]);
    await client.database
      .update(messages)
      .set({ drainedChainId: ids.chain1 })
      .where(eq(messages.id, legacyIds[0]!));
    await client.database
      .update(messages)
      .set({ drainedChainId: ids.chain1 })
      .where(eq(messages.id, legacyIds[1]!));
    await client.database
      .update(messages)
      .set({ drainedChainId: ids.chain2 })
      .where(eq(messages.id, legacyIds[3]!));

    const initialized = await repository.initializeConversation({
      spaceId: ids.spaceA,
    });
    expect(initialized).toMatchObject({
      backfilledInputCount: 4,
      state: {
        latestInputSequence: 4,
        acceptedThroughSequence: 2,
        finalizedThroughSequence: 2,
      },
    });
    const rows = await client.database
      .select({
        id: messages.id,
        sequence: messages.inputSequence,
        drainedChainId: messages.drainedChainId,
      })
      .from(messages)
      .where(eq(messages.spaceId, ids.spaceA))
      .orderBy(asc(messages.inputSequence));
    expect(rows.map(({ id, sequence }) => ({ id, sequence }))).toEqual(
      legacyIds.map((id, index) => ({ id, sequence: index + 1 })),
    );
    expect(rows[2]).toMatchObject({ sequence: 3, drainedChainId: null });
    expect(rows[3]).toMatchObject({ sequence: 4, drainedChainId: ids.chain2 });

    const [space] = await client.database
      .select({
        threadId: spaces.interactionThreadId,
        summary: spaces.interactionSummary,
      })
      .from(spaces)
      .where(eq(spaces.id, ids.spaceA));
    expect(space).toEqual({
      threadId: "legacy-thread-canary",
      summary: "legacy-summary-canary",
    });
    expect(await repository.findSpacesBehindCursor()).toContain(ids.spaceA);
  });

  it("repairs the already-sequenced all-finalized state produced by migration 0011", async () => {
    const receivedAt = new Date("2026-08-18T11:30:00Z");
    const legacyIds = [messageId(601), messageId(602), messageId(603), messageId(604)];
    await client.database.insert(messages).values(
      legacyIds.map((id, index) => ({
        id,
        spaceId: ids.spaceA,
        externalMessageId: `migrated-legacy-${index}`,
        direction: "inbound" as const,
        inputSequence: 4 - index,
        senderIdentityId: ids.identity,
        contentCiphertext: `cipher:migrated-${index}`,
        contentHash: `hash:migrated-${index}`,
        receivedAt,
        retentionExpiresAt: new Date("2026-09-18T11:30:00Z"),
        createdAt: new Date(`2026-08-18T11:30:0${4 - index}Z`),
      })),
    );
    await client.database.insert(chains).values([
      {
        id: ids.chain1,
        spaceId: ids.spaceA,
        version: 1,
        state: "complete",
        chainStartedAt: receivedAt,
        completedAt: new Date("2026-08-18T11:31:00Z"),
      },
      {
        id: ids.chain2,
        spaceId: ids.spaceA,
        version: 2,
        state: "complete",
        chainStartedAt: receivedAt,
        completedAt: new Date("2026-08-18T11:32:00Z"),
      },
    ]);
    await client.database
      .update(messages)
      .set({ drainedChainId: ids.chain1 })
      .where(eq(messages.id, legacyIds[0]!));
    await client.database
      .update(messages)
      .set({ drainedChainId: ids.chain1 })
      .where(eq(messages.id, legacyIds[1]!));
    await client.database
      .update(messages)
      .set({ drainedChainId: ids.chain2 })
      .where(eq(messages.id, legacyIds[3]!));
    await client.database.insert(conversationStates).values({
      spaceId: ids.spaceA,
      latestInputSequence: 4,
      acceptedThroughSequence: 4,
      finalizedThroughSequence: 4,
      actorGeneration: 0,
      activeInteractionRunId: null,
      state: "idle",
    });

    expect(await repository.findSpacesBehindCursor()).toContain(ids.spaceA);
    const initialized = await repository.initializeConversation({
      spaceId: ids.spaceA,
    });
    expect(initialized).toMatchObject({
      backfilledInputCount: 0,
      state: {
        latestInputSequence: 4,
        acceptedThroughSequence: 2,
        finalizedThroughSequence: 2,
      },
    });
    const rows = await client.database
      .select({ id: messages.id, sequence: messages.inputSequence })
      .from(messages)
      .where(eq(messages.spaceId, ids.spaceA))
      .orderBy(asc(messages.inputSequence));
    expect(rows).toEqual(
      legacyIds.map((id, index) => ({ id, sequence: index + 1 })),
    );
  });
});

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { runDatabaseMigrations } from "../../src/db/migrate.js";
import { OutboundDeliveryRepository } from "../../src/db/repositories/outbound-delivery.js";
import {
  conversationStates,
  interactionRuns,
} from "../../src/db/schema-fragments/conversation-actors.js";
import {
  chains,
  deployments,
  outboundBatches,
  outboundParts,
  spaces,
} from "../../src/db/schema.js";

const databaseUrl = process.env["POSTGRES_PIPELINE_TEST_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const ids = {
  deployment: "12000000-0000-4000-8000-000000000001",
  space: "12000000-0000-4000-8000-000000000002",
  chain: "12000000-0000-4000-8000-000000000003",
  batch: "12000000-0000-4000-8000-000000000004",
  part0: "12000000-0000-4000-8000-000000000005",
  part1: "12000000-0000-4000-8000-000000000006",
  chain2: "12000000-0000-4000-8000-000000000007",
  batch2: "12000000-0000-4000-8000-000000000008",
  part2: "12000000-0000-4000-8000-000000000009",
  wrongToken: "12000000-0000-4000-8000-000000000099",
  run: "12000000-0000-4000-8000-000000000010",
  interactionSpace: "12000000-0000-4000-8000-000000000011",
  interactionChain: "12000000-0000-4000-8000-000000000014",
} as const;

let t0 = new Date();

describeDatabase("outbound delivery claims", () => {
  let client: DatabaseClient;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      return;
    }
    client = createDatabaseClient({ connectionString: databaseUrl });
    await runDatabaseMigrations(client, resolve("src/db/migrations"));
  });

  beforeEach(async () => {
    t0 = new Date();
    await client.pool.query(
      "truncate table deployments restart identity cascade",
    );
    await client.database.insert(deployments).values({
      id: ids.deployment,
      name: "outbound-delivery-integration",
      defaultModelProfile: "main",
    });
    await client.database.insert(spaces).values({
      id: ids.space,
      deploymentId: ids.deployment,
      externalSpaceGuid: "delivery-space-guid",
      type: "dm",
      lastMessageAt: t0,
    });
    await client.database.insert(chains).values({
      id: ids.chain,
      spaceId: ids.space,
      version: 1,
      state: "sending",
      chainStartedAt: t0,
    });
    await client.database.insert(outboundBatches).values({
      id: ids.batch,
      chainId: ids.chain,
      spaceId: ids.space,
      state: "sending",
      startIndex: 0,
      partCount: 2,
    });
    await client.database.insert(outboundParts).values([
      {
        id: ids.part0,
        batchId: ids.batch,
        position: 0,
        clientGuid: "a".repeat(64),
        contentCiphertext: "cipher:part-0",
      },
      {
        id: ids.part1,
        batchId: ids.batch,
        position: 1,
        clientGuid: "b".repeat(64),
        contentCiphertext: "cipher:part-1",
      },
    ]);
  });

  afterAll(async () => {
    await client?.close();
  });

  it("applies migration 0012 without rewriting an existing chain-origin batch", async () => {
    const claimExpiresAt = new Date(Date.now() + 60_000);
    await client.database
      .update(outboundBatches)
      .set({
        claimOwner: "legacy-worker",
        claimToken: ids.wrongToken,
        claimExpiresAt,
      })
      .where(eq(outboundBatches.id, ids.batch));
    await client.pool.query(`
      DROP INDEX outbound_batches_interaction_run_unique;
      ALTER TABLE outbound_batches
        DROP CONSTRAINT outbound_batches_interaction_run_id_interaction_runs_id_fk,
        DROP CONSTRAINT outbound_batches_origin_union,
        DROP COLUMN interaction_run_id,
        ALTER COLUMN chain_id SET NOT NULL;
    `);

    const migration = await readFile(
      resolve("src/db/migrations/0012_outbound_origin_union.sql"),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim().length > 0) {
        await client.pool.query(statement);
      }
    }

    const [preserved] = await client.database
      .select({
        chainId: outboundBatches.chainId,
        interactionRunId: outboundBatches.interactionRunId,
        startIndex: outboundBatches.startIndex,
        partCount: outboundBatches.partCount,
        claimOwner: outboundBatches.claimOwner,
        claimToken: outboundBatches.claimToken,
      })
      .from(outboundBatches)
      .where(eq(outboundBatches.id, ids.batch));
    expect(preserved).toEqual({
      chainId: ids.chain,
      interactionRunId: null,
      startIndex: 0,
      partCount: 2,
      claimOwner: "legacy-worker",
      claimToken: ids.wrongToken,
    });
    await expect(
      client.database
        .select({ id: outboundParts.id })
        .from(outboundParts)
        .where(eq(outboundParts.batchId, ids.batch)),
    ).resolves.toHaveLength(2);
  });

  it("requires exactly one outbound origin", async () => {
    await expect(
      client.database.insert(outboundBatches).values({
        id: "12000000-0000-4000-8000-000000000012",
        spaceId: ids.space,
        state: "queued",
        startIndex: 0,
        partCount: 1,
      }),
    ).rejects.toThrow();
    await expect(
      client.database.insert(outboundBatches).values({
        id: "12000000-0000-4000-8000-000000000013",
        chainId: ids.chain,
        interactionRunId: ids.run,
        spaceId: ids.space,
        state: "queued",
        startIndex: 0,
        partCount: 1,
      }),
    ).rejects.toThrow();
  });

  it("atomically finalizes the interaction with its batch and delivers after later input", async () => {
    await client.database.insert(spaces).values({
      id: ids.interactionSpace,
      deploymentId: ids.deployment,
      externalSpaceGuid: "interaction-delivery-space-guid",
      type: "dm",
      lastMessageAt: t0,
    });
    await client.database.insert(interactionRuns).values({
      id: ids.run,
      spaceId: ids.interactionSpace,
      generation: 7,
      state: "finalizing",
      threadId: "thread-7",
      turnId: "turn-7",
      startedThroughSequence: 2,
      acceptedThroughSequence: 4,
      modelId: "gpt-5.6-luna",
      reasoningEffort: "high",
      promptVersion: "conversation-v1",
      promptSha256: "d".repeat(64),
      draftOutputCiphertext: "cipher:interaction-draft",
    });
    await client.database.insert(conversationStates).values({
      spaceId: ids.interactionSpace,
      latestInputSequence: 4,
      acceptedThroughSequence: 4,
      finalizedThroughSequence: 1,
      actorGeneration: 7,
      activeInteractionRunId: ids.run,
      state: "finalizing",
    });
    await client.database.insert(chains).values({
      id: ids.interactionChain,
      spaceId: ids.interactionSpace,
      version: 1,
      state: "executing",
      sourceInteractionRunId: ids.run,
      chainStartedAt: t0,
    });
    const repository = new OutboundDeliveryRepository(client.database);

    await expect(
      repository.materializeInteractionBatch({
        interactionRunId: ids.run,
        spaceId: ids.interactionSpace,
        generation: 6,
        encryptedParts: ["cipher:one", "cipher:two"],
      }),
    ).rejects.toMatchObject({
      code: "DELIVERY_BATCH_INVALID",
      retryable: false,
    });
    await client.database
      .update(conversationStates)
      .set({ latestInputSequence: 5 })
      .where(eq(conversationStates.spaceId, ids.interactionSpace));
    await expect(
      repository.materializeInteractionBatch({
        interactionRunId: ids.run,
        spaceId: ids.interactionSpace,
        generation: 7,
        encryptedParts: ["cipher:stale"],
      }),
    ).rejects.toMatchObject({
      code: "DELIVERY_BATCH_INVALID",
      retryable: false,
    });
    await client.database
      .update(conversationStates)
      .set({ latestInputSequence: 4 })
      .where(eq(conversationStates.spaceId, ids.interactionSpace));
    const outboundBatchId = await repository.materializeInteractionBatch({
      interactionRunId: ids.run,
      spaceId: ids.interactionSpace,
      generation: 7,
      encryptedParts: ["cipher:one", "cipher:two"],
    });
    await expect(
      repository.materializeInteractionBatch({
        interactionRunId: ids.run,
        spaceId: ids.interactionSpace,
        generation: 7,
        encryptedParts: ["cipher:one", "cipher:two"],
      }),
    ).resolves.toBe(outboundBatchId);

    const [materializedRun] = await client.database
      .select({
        state: interactionRuns.state,
        completedAt: interactionRuns.completedAt,
      })
      .from(interactionRuns)
      .where(eq(interactionRuns.id, ids.run));
    const [materializedConversation] = await client.database
      .select({
        state: conversationStates.state,
        activeInteractionRunId: conversationStates.activeInteractionRunId,
        finalizedThroughSequence: conversationStates.finalizedThroughSequence,
      })
      .from(conversationStates)
      .where(eq(conversationStates.spaceId, ids.interactionSpace));
    expect(materializedRun).toEqual({
      state: "completed",
      completedAt: expect.any(Date),
    });
    expect(materializedConversation).toEqual({
      state: "idle",
      activeInteractionRunId: null,
      finalizedThroughSequence: 4,
    });
    const [materializedChain] = await client.database
      .select({ state: chains.state, completedAt: chains.completedAt })
      .from(chains)
      .where(eq(chains.id, ids.interactionChain));
    expect(materializedChain).toEqual({
      state: "complete",
      completedAt: materializedRun?.completedAt,
    });

    await client.database
      .update(conversationStates)
      .set({ actorGeneration: 8, latestInputSequence: 5 })
      .where(eq(conversationStates.spaceId, ids.interactionSpace));

    const first = await repository.claimNext({
      outboundBatchId,
      claimOwner: "interaction-delivery-a",
      leaseDurationMs: 60_000,
      now: t0,
    });
    await repository.checkpointSent({
      outboundBatchId,
      claimToken: first?.claimToken ?? ids.wrongToken,
      position: 0,
      externalMessageId: "provider-interaction-0",
      sentAt: new Date(),
    });
    const second = await repository.claimNext({
      outboundBatchId,
      claimOwner: "interaction-delivery-b",
      leaseDurationMs: 60_000,
      now: t0,
    });
    const completedAt = new Date();
    await expect(
      repository.checkpointSent({
        outboundBatchId,
        claimToken: second?.claimToken ?? ids.wrongToken,
        position: 1,
        externalMessageId: "provider-interaction-1",
        sentAt: completedAt,
      }),
    ).resolves.toEqual({ batchComplete: true, nextIndex: 2 });

    const [run] = await client.database
      .select({ state: interactionRuns.state, completedAt: interactionRuns.completedAt })
      .from(interactionRuns)
      .where(eq(interactionRuns.id, ids.run));
    const [conversation] = await client.database
      .select({
        state: conversationStates.state,
        activeInteractionRunId: conversationStates.activeInteractionRunId,
        finalizedThroughSequence: conversationStates.finalizedThroughSequence,
        acceptedThroughSequence: conversationStates.acceptedThroughSequence,
        latestInputSequence: conversationStates.latestInputSequence,
      })
      .from(conversationStates)
      .where(eq(conversationStates.spaceId, ids.interactionSpace));
    const [batch] = await client.database
      .select({
        chainId: outboundBatches.chainId,
        interactionRunId: outboundBatches.interactionRunId,
        state: outboundBatches.state,
        startIndex: outboundBatches.startIndex,
      })
      .from(outboundBatches)
      .where(eq(outboundBatches.id, outboundBatchId));
    expect(run).toEqual({
      state: "completed",
      completedAt: materializedRun?.completedAt,
    });
    expect(conversation).toEqual({
      state: "idle",
      activeInteractionRunId: null,
      finalizedThroughSequence: 4,
      acceptedThroughSequence: 4,
      latestInputSequence: 5,
    });
    expect(batch).toEqual({
      chainId: null,
      interactionRunId: ids.run,
      state: "sent",
      startIndex: 2,
    });
  });

  it("allows one concurrent claimant and prevents a live claim from being stolen", async () => {
    const repositoryA = new OutboundDeliveryRepository(client.database);
    const repositoryB = new OutboundDeliveryRepository(client.database);

    const results = await Promise.allSettled([
      repositoryA.claimNext({
        outboundBatchId: ids.batch,
        claimOwner: "delivery-process-a",
        leaseDurationMs: 60_000,
        now: t0,
      }),
      repositoryB.claimNext({
        outboundBatchId: ids.batch,
        claimOwner: "delivery-process-b",
        leaseDurationMs: 60_000,
        now: t0,
      }),
    ]);
    const claims = results.flatMap((result) =>
      result.status === "fulfilled" && result.value !== null
        ? [result.value]
        : [],
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      outboundBatchId: ids.batch,
      position: 0,
      clientGuid: "a".repeat(64),
      text: "cipher:part-0",
    });

    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        code: "DELIVERY_CLAIM_LOST",
        retryable: true,
      }),
    });
    const loser = claims[0]?.claimOwner === "delivery-process-a" ? repositoryB : repositoryA;
    await expect(
      loser.claimNext({
        outboundBatchId: ids.batch,
        claimOwner: "delivery-process-loser",
        leaseDurationMs: 60_000,
        now: new Date(t0.getTime() + 1),
      }),
    ).rejects.toMatchObject({
      code: "DELIVERY_CLAIM_LOST",
      retryable: true,
    });
  });

  it("permits only one live claim across batches in the same space", async () => {
    await client.database.insert(chains).values({
      id: ids.chain2,
      spaceId: ids.space,
      version: 2,
      state: "sending",
      chainStartedAt: new Date(t0.getTime() + 1),
    });
    await client.database.insert(outboundBatches).values({
      id: ids.batch2,
      chainId: ids.chain2,
      spaceId: ids.space,
      state: "sending",
      startIndex: 0,
      partCount: 1,
    });
    await client.database.insert(outboundParts).values({
      id: ids.part2,
      batchId: ids.batch2,
      position: 0,
      clientGuid: "c".repeat(64),
      contentCiphertext: "cipher:second-batch",
    });
    const repositoryA = new OutboundDeliveryRepository(client.database);
    const repositoryB = new OutboundDeliveryRepository(client.database);

    const results = await Promise.allSettled([
      repositoryA.claimNext({
        outboundBatchId: ids.batch,
        claimOwner: "delivery-process-a",
        leaseDurationMs: 60_000,
        now: t0,
      }),
      repositoryB.claimNext({
        outboundBatchId: ids.batch2,
        claimOwner: "delivery-process-b",
        leaseDurationMs: 60_000,
        now: t0,
      }),
    ]);

    expect(
      results.filter(
        (result) => result.status === "fulfilled" && result.value !== null,
      ),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });

  it("recovers an expired claim without allowing a stale release to clear it", async () => {
    const repositoryA = new OutboundDeliveryRepository(client.database);
    const repositoryB = new OutboundDeliveryRepository(client.database);
    const first = await repositoryA.claimNext({
      outboundBatchId: ids.batch,
      claimOwner: "delivery-process-a",
      leaseDurationMs: 1_000,
      now: t0,
    });
    expect(first).not.toBeNull();

    const expiredAt = new Date(Date.now() - 1_000);
    await client.database
      .update(outboundBatches)
      .set({ claimExpiresAt: expiredAt })
      .where(eq(outboundBatches.id, ids.batch));
    await expect(
      repositoryA.findRecoverableBatchIds({ now: expiredAt, limit: 10 }),
    ).resolves.toEqual([ids.batch]);
    const replacement = await repositoryB.claimNext({
      outboundBatchId: ids.batch,
      claimOwner: "delivery-process-b",
      leaseDurationMs: 60_000,
      now: expiredAt,
    });
    expect(replacement).toMatchObject({
      position: 0,
      clientGuid: first?.clientGuid,
    });
    expect(replacement?.claimToken).not.toBe(first?.claimToken);

    await repositoryA.release({
      outboundBatchId: ids.batch,
      claimToken: first?.claimToken ?? ids.wrongToken,
      now: new Date(expiredAt.getTime() + 1),
    });
    const [row] = await client.database
      .select({
        owner: outboundBatches.claimOwner,
        token: outboundBatches.claimToken,
      })
      .from(outboundBatches)
      .where(eq(outboundBatches.id, ids.batch));
    expect(row).toEqual({
      owner: "delivery-process-b",
      token: replacement?.claimToken,
    });
  });

  it("requires the current token and advances the cursor only forward", async () => {
    const repository = new OutboundDeliveryRepository(client.database);
    const claim = await repository.claimNext({
      outboundBatchId: ids.batch,
      claimOwner: "delivery-process-a",
      leaseDurationMs: 60_000,
      now: t0,
    });
    expect(claim).not.toBeNull();

    await expect(
      repository.checkpointSent({
        outboundBatchId: ids.batch,
        claimToken: ids.wrongToken,
        position: 0,
        externalMessageId: "provider-wrong",
        sentAt: new Date(t0.getTime() + 1),
      }),
    ).rejects.toMatchObject({ code: "DELIVERY_CLAIM_LOST" });

    await expect(
      repository.checkpointSent({
        outboundBatchId: ids.batch,
        claimToken: claim?.claimToken ?? ids.wrongToken,
        position: 0,
        externalMessageId: "provider-part-0",
        sentAt: new Date(t0.getTime() + 1),
      }),
    ).resolves.toEqual({ batchComplete: false, nextIndex: 1 });

    const [batch] = await client.database
      .select({
        startIndex: outboundBatches.startIndex,
        claimToken: outboundBatches.claimToken,
      })
      .from(outboundBatches)
      .where(eq(outboundBatches.id, ids.batch));
    const [part] = await client.database
      .select({ state: outboundParts.state })
      .from(outboundParts)
      .where(eq(outboundParts.id, ids.part0));
    expect(batch).toEqual({ startIndex: 1, claimToken: null });
    expect(part?.state).toBe("sent");

    const nextClaim = await repository.claimNext({
      outboundBatchId: ids.batch,
      claimOwner: "delivery-process-b",
      leaseDurationMs: 60_000,
      now: new Date(t0.getTime() + 2),
    });
    expect(nextClaim?.position).toBe(1);
    await expect(
      repository.checkpointSent({
        outboundBatchId: ids.batch,
        claimToken: nextClaim?.claimToken ?? ids.wrongToken,
        position: 0,
        externalMessageId: "provider-stale",
        sentAt: new Date(t0.getTime() + 2),
      }),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      repository.checkpointSent({
        outboundBatchId: ids.batch,
        claimToken: nextClaim?.claimToken ?? ids.wrongToken,
        position: 2,
        externalMessageId: "provider-skipped",
        sentAt: new Date(t0.getTime() + 2),
      }),
    ).rejects.toBeInstanceOf(Error);
    const [unchanged] = await client.database
      .select({ startIndex: outboundBatches.startIndex })
      .from(outboundBatches)
      .where(eq(outboundBatches.id, ids.batch));
    expect(unchanged?.startIndex).toBe(1);
  });

  it("rejects checkpointing after the lease has expired", async () => {
    const repository = new OutboundDeliveryRepository(client.database);
    const expiredStart = new Date();
    const claim = await repository.claimNext({
      outboundBatchId: ids.batch,
      claimOwner: "delivery-process-a",
      leaseDurationMs: 1_000,
      now: expiredStart,
    });
    expect(claim).not.toBeNull();
    await client.database
      .update(outboundBatches)
      .set({ claimExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(outboundBatches.id, ids.batch));

    await expect(
      repository.checkpointSent({
        outboundBatchId: ids.batch,
        claimToken: claim?.claimToken ?? ids.wrongToken,
        position: 0,
        externalMessageId: "provider-expired",
        sentAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: "DELIVERY_CLAIM_LOST" });
    const [batch] = await client.database
      .select({ startIndex: outboundBatches.startIndex })
      .from(outboundBatches)
      .where(eq(outboundBatches.id, ids.batch));
    expect(batch?.startIndex).toBe(0);
  });

  it("leaves a released provider failure at the same recoverable part", async () => {
    const repository = new OutboundDeliveryRepository(client.database);
    const first = await repository.claimNext({
      outboundBatchId: ids.batch,
      claimOwner: "delivery-process-a",
      leaseDurationMs: 60_000,
      now: t0,
    });
    expect(first).not.toBeNull();
    await repository.release({
      outboundBatchId: ids.batch,
      claimToken: first?.claimToken ?? ids.wrongToken,
      now: new Date(t0.getTime() + 1),
    });

    const retried = await repository.claimNext({
      outboundBatchId: ids.batch,
      claimOwner: "delivery-process-b",
      leaseDurationMs: 60_000,
      now: new Date(t0.getTime() + 2),
    });
    expect(retried).toMatchObject({
      position: 0,
      clientGuid: first?.clientGuid,
      text: "cipher:part-0",
    });
    const [batch] = await client.database
      .select({ startIndex: outboundBatches.startIndex })
      .from(outboundBatches)
      .where(eq(outboundBatches.id, ids.batch));
    const [part] = await client.database
      .select({ state: outboundParts.state })
      .from(outboundParts)
      .where(eq(outboundParts.id, ids.part0));
    expect(batch?.startIndex).toBe(0);
    expect(part?.state).toBe("pending");
  });

  it("continues after repository restart from the first unsent part", async () => {
    const beforeRestart = new OutboundDeliveryRepository(client.database);
    const first = await beforeRestart.claimNext({
      outboundBatchId: ids.batch,
      claimOwner: "delivery-before-restart",
      leaseDurationMs: 60_000,
      now: t0,
    });
    await beforeRestart.checkpointSent({
      outboundBatchId: ids.batch,
      claimToken: first?.claimToken ?? ids.wrongToken,
      position: 0,
      externalMessageId: "provider-part-0",
      sentAt: new Date(t0.getTime() + 1),
    });

    if (databaseUrl === undefined) {
      throw new Error("database URL disappeared during integration test");
    }
    const restartedClient = createDatabaseClient({ connectionString: databaseUrl });
    try {
      const afterRestart = new OutboundDeliveryRepository(
        restartedClient.database,
      );
      await expect(
        afterRestart.claimNext({
          outboundBatchId: ids.batch,
          claimOwner: "delivery-after-restart",
          leaseDurationMs: 60_000,
          now: new Date(t0.getTime() + 2),
        }),
      ).resolves.toMatchObject({
        position: 1,
        clientGuid: "b".repeat(64),
        text: "cipher:part-1",
      });
    } finally {
      await restartedClient.close();
    }
  });

  it("rejects a partially populated lease tuple", async () => {
    await client.database
      .update(outboundBatches)
      .set({ claimOwner: "orphaned-owner" })
      .where(eq(outboundBatches.id, ids.batch));
    const repository = new OutboundDeliveryRepository(client.database);

    await expect(
      repository.claimNext({
        outboundBatchId: ids.batch,
        claimOwner: "delivery-process-a",
        leaseDurationMs: 60_000,
        now: t0,
      }),
    ).rejects.toMatchObject({
      code: "DELIVERY_BATCH_INVALID",
      retryable: false,
    });
  });
});

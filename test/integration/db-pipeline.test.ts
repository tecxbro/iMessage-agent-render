import { resolve } from "node:path";

import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { runDatabaseMigrations } from "../../src/db/migrate.js";
import { ChainRepository } from "../../src/db/repositories/chains.js";
import { ApprovalRepository } from "../../src/db/repositories/approvals.js";
import { InboundRepository } from "../../src/db/repositories/inbound.js";
import { OutboundRepository } from "../../src/db/repositories/outbound.js";
import { RetentionRepository } from "../../src/db/repositories/retention.js";
import {
  chains,
  channelIdentities,
  deployments,
  executionTasks,
  messages,
  outboundBatches,
  outboundParts,
  owners,
  spaces,
} from "../../src/db/schema.js";

const databaseUrl = process.env["POSTGRES_PIPELINE_TEST_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const deploymentId = "10000000-0000-4000-8000-000000000001";
const ownerId = "10000000-0000-4000-8000-000000000002";
const identityId = "10000000-0000-4000-8000-000000000003";
const spaceId = "10000000-0000-4000-8000-000000000004";

describeDatabase("PostgreSQL durable pipeline", () => {
  let client: DatabaseClient;
  let inbound: InboundRepository;
  let chainRepository: ChainRepository;
  let approvalRepository: ApprovalRepository;
  let outbound: OutboundRepository;
  let retention: RetentionRepository;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      return;
    }
    client = createDatabaseClient({ connectionString: databaseUrl });
    await runDatabaseMigrations(client, resolve("src/db/migrations"));
    inbound = new InboundRepository(client.database);
    chainRepository = new ChainRepository(client.database);
    approvalRepository = new ApprovalRepository(client.database);
    outbound = new OutboundRepository(client.database);
    retention = new RetentionRepository(client.database);
  });

  beforeEach(async () => {
    await client.pool.query(`
      truncate table
        approvals,
        memory_sync_events,
        usage_events,
        failure_events,
        outbound_parts,
        outbound_batches,
        execution_tasks,
        agent_threads,
        carried_messages,
        messages,
        chains,
        space_members,
        spaces,
        channel_identities,
        owners,
        deployments
      restart identity cascade
    `);
    await client.database.insert(deployments).values({
      id: deploymentId,
      name: "integration",
      defaultModelProfile: "main",
    });
    await client.database.insert(owners).values({
      id: ownerId,
      deploymentId,
      timezone: "UTC",
    });
    await client.database.insert(channelIdentities).values({
      id: identityId,
      deploymentId,
      ownerId,
      normalizedHandleCiphertext: "cipher:owner",
      handleFingerprint: "fingerprint-owner",
      role: "owner",
      verifiedAt: new Date("2026-08-14T00:00:00Z"),
    });
    await client.database.insert(spaces).values({
      id: spaceId,
      deploymentId,
      externalSpaceGuid: "space-guid",
      type: "dm",
      lastMessageAt: new Date("2026-08-14T00:00:00Z"),
    });
  });

  afterAll(async () => {
    await client?.close();
  });

  async function ingest(externalMessageId: string, receivedAt: Date) {
    return inbound.ingestAcceptedMessage({
      spaceId,
      externalMessageId,
      senderIdentityId: identityId,
      contentCiphertext: `cipher:${externalMessageId}`,
      contentHash: `hash:${externalMessageId}`,
      receivedAt,
      retentionExpiresAt: new Date("2026-09-14T00:00:00Z"),
    });
  }

  it("deduplicates concurrent provider events and drains a burst once in order", async () => {
    const receivedAt = new Date("2026-08-14T00:00:01Z");
    const duplicateResults = await Promise.all([
      ingest("provider-1", receivedAt),
      ingest("provider-1", receivedAt),
    ]);
    await ingest("provider-2", new Date("2026-08-14T00:00:02Z"));
    await ingest("provider-3", new Date("2026-08-14T00:00:03Z"));
    await ingest("provider-4", new Date("2026-08-14T00:00:04Z"));

    expect(duplicateResults.filter((result) => result.inserted)).toHaveLength(1);
    const flushed = await chainRepository.flushInboundMessages(
      spaceId,
      new Date("2026-08-14T00:00:05Z"),
    );
    const secondFlush = await chainRepository.flushInboundMessages(
      spaceId,
      new Date("2026-08-14T00:00:06Z"),
    );

    expect(flushed?.messageIds).toHaveLength(4);
    expect(secondFlush).toBeNull();
    const rows = await client.database
      .select({ externalId: messages.externalMessageId })
      .from(messages)
      .orderBy(asc(messages.receivedAt));
    expect(rows.map((row) => row.externalId)).toEqual([
      "provider-1",
      "provider-2",
      "provider-3",
      "provider-4",
    ]);
  });

  it("supersedes planning, carries prior messages, and ignores stale cancellation", async () => {
    const first = await ingest(
      "original",
      new Date("2026-08-14T00:00:01Z"),
    );
    const oldChain = await chainRepository.flushInboundMessages(
      spaceId,
      new Date("2026-08-14T00:00:02Z"),
    );
    await client.database
      .update(chains)
      .set({ state: "planning" })
      .where(eq(chains.id, oldChain?.chainId ?? ""));
    const correction = await ingest(
      "correction",
      new Date("2026-08-14T00:00:03Z"),
    );

    const superseded = await chainRepository.supersedeActiveChain(
      spaceId,
      correction.messageId,
    );
    expect(superseded.canceledChainIds).toEqual([oldChain?.chainId]);

    const newChain = await chainRepository.flushInboundMessages(
      spaceId,
      new Date("2026-08-14T00:00:04Z"),
    );
    expect(newChain?.messageIds).toEqual([first.messageId, correction.messageId]);
    await client.database
      .update(chains)
      .set({ state: "planning" })
      .where(eq(chains.id, newChain?.chainId ?? ""));

    const stale = await chainRepository.supersedeActiveChain(
      spaceId,
      first.messageId,
    );
    expect(stale.canceledChainIds).toEqual([]);
    expect(await chainRepository.isCurrentChain(newChain?.chainId ?? "", 2)).toBe(
      true,
    );
  });

  it("recovers a crash between durable ingest and explicit supersession", async () => {
    const first = await ingest("crash-original", new Date("2026-08-14T00:00:01Z"));
    const oldChain = await chainRepository.flushInboundMessages(
      spaceId,
      new Date("2026-08-14T00:00:02Z"),
    );
    await client.database
      .update(chains)
      .set({ state: "planning" })
      .where(eq(chains.id, oldChain?.chainId ?? ""));
    const correction = await ingest(
      "crash-correction",
      new Date("2026-08-14T00:00:03Z"),
    );

    // Simulate restart reconciliation calling flush without the ingest service's
    // normal supersedeActiveChain call.
    const recovered = await chainRepository.flushInboundMessages(
      spaceId,
      new Date("2026-08-14T00:00:04Z"),
    );

    expect(recovered?.messageIds).toEqual([first.messageId, correction.messageId]);
    const [oldState] = await client.database
      .select({ state: chains.state })
      .from(chains)
      .where(eq(chains.id, oldChain?.chainId ?? ""));
    expect(oldState?.state).toBe("canceled");
  });

  it("moves the outbound cursor only after acknowledgement is checkpointed", async () => {
    await ingest("outbound-source", new Date("2026-08-14T00:00:01Z"));
    const chain = await chainRepository.flushInboundMessages(
      spaceId,
      new Date("2026-08-14T00:00:02Z"),
    );
    await client.database
      .update(chains)
      .set({ state: "synthesizing" })
      .where(eq(chains.id, chain?.chainId ?? ""));
    const batchId = await outbound.materializeBatch({
      deploymentId,
      chainId: chain?.chainId ?? "",
      spaceId,
      encryptedParts: ["cipher:one", "cipher:two", "cipher:three"],
    });

    const first = await outbound.claimNextPart(batchId);
    expect(first?.position).toBe(0);
    const retryBeforeCheckpoint = await outbound.claimNextPart(batchId);
    expect(retryBeforeCheckpoint?.clientGuid).toBe(first?.clientGuid);
    await outbound.checkpointSentPart(batchId, 0, "external-1");
    const second = await outbound.claimNextPart(batchId);
    await outbound.checkpointSentPart(batchId, 1, "external-2");
    const third = await outbound.claimNextPart(batchId);
    await outbound.checkpointSentPart(batchId, 2, "external-3");

    expect(second?.position).toBe(1);
    expect(third?.position).toBe(2);
    const [batch] = await client.database
      .select()
      .from(outboundBatches)
      .where(eq(outboundBatches.id, batchId));
    expect(batch).toMatchObject({ state: "sent", startIndex: 3, partCount: 3 });
    const partRows = await client.database
      .select({ state: outboundParts.state })
      .from(outboundParts)
      .where(eq(outboundParts.batchId, batchId));
    expect(partRows.every((part) => part.state === "sent")).toBe(true);
  });

  it("compare-and-sets approval responses and consumes an exact action once", async () => {
    await ingest("approval-source", new Date("2026-08-14T00:00:01Z"));
    const chain = await chainRepository.flushInboundMessages(
      spaceId,
      new Date("2026-08-14T00:00:02Z"),
    );
    const taskId = "10000000-0000-4000-8000-000000000099";
    await client.database
      .update(chains)
      .set({ state: "executing" })
      .where(eq(chains.id, chain?.chainId ?? ""));
    await client.database.insert(executionTasks).values({
      id: taskId,
      chainId: chain?.chainId ?? "",
      name: "approval task",
      purpose: "exercise exact action binding",
      instructionsCiphertext: "cipher:instructions",
      modelProfile: "main",
      permissionProfile: "approval-required",
      state: "needs_approval",
    });
    const approvalId = await approvalRepository.createPending({
      chainId: chain?.chainId ?? "",
      executionTaskId: taskId,
      ownerId,
      spaceId,
      actionType: "repository.write",
      normalizedPayloadCiphertext: "cipher:action",
      actionHash: "action-hash",
      humanSummary: "Apply the exact repository write",
      expiresAt: new Date("2026-08-14T00:10:00Z"),
    });

    const responses = await Promise.all([
      approvalRepository.compareAndSetResponse({
        approvalId,
        ownerId,
        spaceId,
        approvedByIdentityId: identityId,
        status: "approved",
        now: new Date("2026-08-14T00:03:00Z"),
      }),
      approvalRepository.compareAndSetResponse({
        approvalId,
        ownerId,
        spaceId,
        approvedByIdentityId: identityId,
        status: "approved",
        now: new Date("2026-08-14T00:03:00Z"),
      }),
    ]);
    expect(responses.filter(Boolean)).toHaveLength(1);
    expect(
      await approvalRepository.consumeApproved(
        approvalId,
        ownerId,
        spaceId,
        "mutated-hash",
        new Date("2026-08-14T00:04:00Z"),
      ),
    ).toBe(false);
    expect(
      await approvalRepository.consumeApproved(
        approvalId,
        ownerId,
        spaceId,
        "action-hash",
        new Date("2026-08-14T00:04:00Z"),
      ),
    ).toBe(true);
    expect(
      await approvalRepository.consumeApproved(
        approvalId,
        ownerId,
        spaceId,
        "action-hash",
        new Date("2026-08-14T00:04:01Z"),
      ),
    ).toBe(false);
  });

  it("does not shred retained content referenced by a nonterminal chain", async () => {
    const accepted = await inbound.ingestAcceptedMessage({
      spaceId,
      externalMessageId: "retained",
      senderIdentityId: identityId,
      contentCiphertext: "cipher:retained",
      contentHash: "hash:retained",
      receivedAt: new Date("2026-01-01T00:00:00Z"),
      retentionExpiresAt: new Date("2026-01-02T00:00:00Z"),
    });
    const chain = await chainRepository.flushInboundMessages(
      spaceId,
      new Date("2026-01-01T00:00:01Z"),
    );
    const cutoffs = {
      rawContentBefore: new Date("2026-08-14T00:00:00Z"),
      failuresBefore: new Date("2026-08-14T00:00:00Z"),
      usageBefore: new Date("2026-08-14T00:00:00Z"),
    };

    await retention.applyRetention(cutoffs);
    let [row] = await client.database
      .select({ content: messages.contentCiphertext })
      .from(messages)
      .where(eq(messages.id, accepted.messageId));
    expect(row?.content).toBe("cipher:retained");

    await client.database
      .update(chains)
      .set({ state: "complete", completedAt: new Date() })
      .where(eq(chains.id, chain?.chainId ?? ""));
    await retention.applyRetention(cutoffs);
    [row] = await client.database
      .select({ content: messages.contentCiphertext })
      .from(messages)
      .where(eq(messages.id, accepted.messageId));
    expect(row?.content).toBeNull();
  });
});

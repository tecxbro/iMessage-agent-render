import { resolve } from "node:path";

import { and, asc, eq, isNull } from "drizzle-orm";
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
import { OperationalRepository } from "../../src/db/repositories/operational.js";
import { RetentionRepository } from "../../src/db/repositories/retention.js";
import {
  approvals,
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
import {
  DatabaseAuthorizationDirectory,
  DeterministicSenderAuthorizer,
  fingerprintSenderHandle,
} from "../../src/security/authorize-sender.js";
import { createDataCipher } from "../../src/security/data-cipher.js";

const databaseUrl = process.env["POSTGRES_PIPELINE_TEST_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const deploymentId = "10000000-0000-4000-8000-000000000001";
const ownerId = "10000000-0000-4000-8000-000000000002";
const identityId = "10000000-0000-4000-8000-000000000003";
const spaceId = "10000000-0000-4000-8000-000000000004";
const collaboratorId = "10000000-0000-4000-8000-000000000005";

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
        pairing_attempts,
        pairing_challenges,
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

  it("persists one replaceable owner identity and fails closed on invariant violations", async () => {
    const identityDeploymentId = "20000000-0000-4000-8000-000000000001";
    const fingerprintKey =
      "integration-owner-fingerprint-key-material-32-bytes";
    const cipher = createDataCipher(Buffer.alloc(32, 7).toString("base64"));
    const operational = new OperationalRepository(client.database, {
      deploymentId: identityDeploymentId,
      fingerprintKey,
      encrypt: cipher.encrypt,
      decrypt: cipher.decrypt,
    });

    await operational.ensureDeployment();
    await operational.ensureDeployment();
    await expect(operational.readOwnerPhoneNumber()).resolves.toBeUndefined();

    const identityOwners = await client.database
      .select({ id: owners.id })
      .from(owners)
      .where(eq(owners.deploymentId, identityDeploymentId));
    expect(identityOwners).toHaveLength(1);
    const primaryOwnerId = identityOwners[0]!.id;

    const previousPhone = "+14155550123";
    const replacementPhone = "+14155550124";
    const collaboratorPhone = "+14155550125";
    await operational.replaceOwnerPhoneNumber(previousPhone);

    const restarted = new OperationalRepository(client.database, {
      deploymentId: identityDeploymentId,
      fingerprintKey,
      encrypt: cipher.encrypt,
      decrypt: cipher.decrypt,
    });
    await expect(restarted.readOwnerPhoneNumber()).resolves.toBe(previousPhone);

    const collaboratorFingerprint = fingerprintSenderHandle(
      identityDeploymentId,
      collaboratorPhone,
      fingerprintKey,
    );
    await client.database.insert(channelIdentities).values({
      id: "20000000-0000-4000-8000-000000000005",
      deploymentId: identityDeploymentId,
      ownerId: primaryOwnerId,
      normalizedHandleCiphertext: cipher.encrypt(collaboratorPhone),
      handleFingerprint: collaboratorFingerprint,
      role: "collaborator",
      verifiedAt: new Date(),
    });

    await restarted.replaceOwnerPhoneNumber(replacementPhone);
    await expect(restarted.readOwnerPhoneNumber()).resolves.toBe(
      replacementPhone,
    );

    const previousFingerprint = fingerprintSenderHandle(
      identityDeploymentId,
      previousPhone,
      fingerprintKey,
    );
    const replacementFingerprint = fingerprintSenderHandle(
      identityDeploymentId,
      replacementPhone,
      fingerprintKey,
    );
    const identityRows = await client.database
      .select({
        fingerprint: channelIdentities.handleFingerprint,
        role: channelIdentities.role,
        revokedAt: channelIdentities.revokedAt,
      })
      .from(channelIdentities)
      .where(eq(channelIdentities.deploymentId, identityDeploymentId));
    expect(identityRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fingerprint: previousFingerprint,
          role: "owner",
          revokedAt: expect.any(Date),
        }),
        {
          fingerprint: replacementFingerprint,
          role: "owner",
          revokedAt: null,
        },
        {
          fingerprint: collaboratorFingerprint,
          role: "collaborator",
          revokedAt: null,
        },
      ]),
    );

    const authorizer = new DeterministicSenderAuthorizer({
      deploymentId: identityDeploymentId,
      fingerprintKey,
      directory: new DatabaseAuthorizationDirectory(client.database),
      groupPolicy: { mode: "disabled", agentHandles: [] },
    });
    const authorizationInput = (phoneNumber: string) => ({
      externalMessageId: `message-${phoneNumber}`,
      receivedAt: new Date(),
      sender: {
        address: phoneNumber,
        kind: "phone" as const,
        service: "iMessage" as const,
      },
      space: {
        routePhone: "+14155559999",
        spaceGuid: "identity-space",
        spaceType: "dm" as const,
      },
      text: "hello",
      mentionedAddresses: [],
    });
    await expect(authorizer.authorize(authorizationInput(previousPhone))).resolves
      .toMatchObject({ authorized: false, reason: "identity-revoked" });
    await expect(
      authorizer.authorize(authorizationInput(replacementPhone)),
    ).resolves.toMatchObject({ authorized: true, context: { role: "owner" } });

    await client.database.insert(channelIdentities).values({
      id: "20000000-0000-4000-8000-000000000006",
      deploymentId: identityDeploymentId,
      ownerId: primaryOwnerId,
      normalizedHandleCiphertext: cipher.encrypt("+14155550126"),
      handleFingerprint: fingerprintSenderHandle(
        identityDeploymentId,
        "+14155550126",
        fingerprintKey,
      ),
      role: "owner",
      verifiedAt: new Date(),
    });
    await expect(restarted.readOwnerPhoneNumber()).rejects.toThrow(
      "Multiple active owner phone identities",
    );
    const activeOwners = await client.database
      .select({ id: channelIdentities.id })
      .from(channelIdentities)
      .where(
        and(
          eq(channelIdentities.deploymentId, identityDeploymentId),
          eq(channelIdentities.role, "owner"),
          isNull(channelIdentities.revokedAt),
        ),
      );
    expect(activeOwners).toHaveLength(2);
  });

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
    expect(recovered?.canceledChainIds).toEqual([oldChain?.chainId]);
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
    await expect(
      approvalRepository.createPending({
        chainId: chain?.chainId ?? "",
        executionTaskId: taskId,
        ownerId,
        spaceId,
        actionType: "repository.write",
        normalizedPayloadCiphertext: "cipher:invalid-action",
        actionHash: "a".repeat(64),
        humanSummary: "invalid action",
        expiresAt: new Date("2026-08-14T00:10:00Z"),
      }),
    ).rejects.toThrow();
    await expect(
      approvalRepository.createPending({
        chainId: chain?.chainId ?? "",
        executionTaskId: taskId,
        ownerId,
        spaceId,
        actionType: "filesystem.destructive",
        normalizedPayloadCiphertext: "cipher:invalid-hash",
        actionHash: "not-a-sha256-hash",
        humanSummary: "invalid hash",
        expiresAt: new Date("2026-08-14T00:10:00Z"),
      }),
    ).rejects.toThrow();
    const approvalId = await approvalRepository.createPending({
      chainId: chain?.chainId ?? "",
      executionTaskId: taskId,
      ownerId,
      spaceId,
      actionType: "filesystem.destructive",
      normalizedPayloadCiphertext: "cipher:action",
      actionHash: "a".repeat(64),
      humanSummary: "Apply the exact repository write",
      expiresAt: new Date("2026-08-14T00:10:00Z"),
    });
    await client.database.insert(channelIdentities).values({
      id: collaboratorId,
      deploymentId,
      ownerId,
      normalizedHandleCiphertext: "cipher:collaborator",
      handleFingerprint: "fingerprint-collaborator",
      role: "collaborator",
      verifiedAt: new Date("2026-08-14T00:00:00Z"),
    });
    expect(
      await approvalRepository.compareAndSetResponse({
        approvalId,
        ownerId,
        spaceId,
        approvedByIdentityId: collaboratorId,
        status: "approved",
        now: new Date("2026-08-14T00:02:30Z"),
      }),
    ).toBe(false);
    await client.database
      .update(channelIdentities)
      .set({ revokedAt: new Date("2026-08-14T00:02:40Z") })
      .where(eq(channelIdentities.id, identityId));
    expect(
      await approvalRepository.compareAndSetResponse({
        approvalId,
        ownerId,
        spaceId,
        approvedByIdentityId: identityId,
        status: "approved",
        now: new Date("2026-08-14T00:02:45Z"),
      }),
    ).toBe(false);
    await client.database
      .update(channelIdentities)
      .set({ revokedAt: null })
      .where(eq(channelIdentities.id, identityId));

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
    await expect(
      client.database
        .update(approvals)
        .set({ actionHash: "c".repeat(64) })
        .where(eq(approvals.id, approvalId)),
    ).rejects.toThrow();
    expect(
      await approvalRepository.consumeApprovedAction({
        approvalId,
        ownerId,
        spaceId,
        executionTaskId: taskId,
        expectedActionHash: "b".repeat(64),
        expectedPayloadCiphertext: "cipher:action",
        now: new Date("2026-08-14T00:04:00Z"),
      }),
    ).toBe(false);
    await client.database
      .update(channelIdentities)
      .set({ revokedAt: new Date("2026-08-14T00:03:30Z") })
      .where(eq(channelIdentities.id, identityId));
    expect(
      await approvalRepository.consumeApprovedAction({
        approvalId,
        ownerId,
        spaceId,
        executionTaskId: taskId,
        expectedActionHash: "a".repeat(64),
        expectedPayloadCiphertext: "cipher:action",
        now: new Date("2026-08-14T00:04:00Z"),
      }),
    ).toBe(false);
    await client.database
      .update(channelIdentities)
      .set({ revokedAt: null })
      .where(eq(channelIdentities.id, identityId));
    expect(
      await approvalRepository.consumeApprovedAction({
        approvalId,
        ownerId,
        spaceId,
        executionTaskId: taskId,
        expectedActionHash: "a".repeat(64),
        expectedPayloadCiphertext: "cipher:action",
        now: new Date("2026-08-14T00:04:00Z"),
      }),
    ).toBe(true);
    expect(
      await approvalRepository.consumeApprovedAction({
        approvalId,
        ownerId,
        spaceId,
        executionTaskId: taskId,
        expectedActionHash: "a".repeat(64),
        expectedPayloadCiphertext: "cipher:action",
        now: new Date("2026-08-14T00:04:01Z"),
      }),
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

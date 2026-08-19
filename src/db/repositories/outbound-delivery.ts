import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";

import { DeliveryError } from "../../conversation/errors.js";
import type {
  DeliveryCheckpoint,
  DeliveryClaim,
  DeliveryRepositoryPort,
} from "../../delivery/contracts.js";
import type { Database, DatabaseTransaction } from "../client.js";
import {
  conversationStates,
  interactionRuns,
} from "../schema-fragments/conversation-actors.js";
import {
  chains,
  outboundBatches,
  outboundParts,
  spaces,
} from "../schema.js";
import { stableClientGuid } from "./outbound.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_LEASE_DURATION_MS = 24 * 60 * 60 * 1_000;

export interface OutboundDeliveryRepositoryOptions {
  createClaimToken?: () => string;
}

export interface MaterializeInteractionOutboundInput {
  interactionRunId: string;
  spaceId: string;
  generation: number;
  encryptedParts: readonly string[];
}

type LeaseTuple = {
  claimOwner: string | null;
  claimToken: string | null;
  claimExpiresAt: Date | null;
};

type SendableOrigin =
  | { kind: "chain"; chainId: string }
  | {
      kind: "interaction";
      interactionRunId: string;
      generation: number;
      acceptedThroughSequence: number;
      spaceId: string;
    };

function completeLease(lease: LeaseTuple): lease is {
  claimOwner: string;
  claimToken: string;
  claimExpiresAt: Date;
} {
  return (
    lease.claimOwner !== null &&
    lease.claimToken !== null &&
    lease.claimExpiresAt !== null
  );
}

function emptyLease(lease: LeaseTuple): boolean {
  return (
    lease.claimOwner === null &&
    lease.claimToken === null &&
    lease.claimExpiresAt === null
  );
}

function assertDate(value: Date): void {
  if (!Number.isFinite(value.getTime())) {
    throw new DeliveryError("DELIVERY_BATCH_INVALID", false);
  }
}

function assertUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new DeliveryError("DELIVERY_BATCH_INVALID", false);
  }
}

function assertPosition(position: number): void {
  if (!Number.isInteger(position) || position < 0) {
    throw new DeliveryError("DELIVERY_BATCH_INVALID", false);
  }
}

export class OutboundDeliveryRepository implements DeliveryRepositoryPort {
  readonly #createClaimToken: () => string;

  public constructor(
    private readonly database: Database,
    options: OutboundDeliveryRepositoryOptions = {},
  ) {
    this.#createClaimToken = options.createClaimToken ?? randomUUID;
  }

  public async findChainIdForBatch(
    outboundBatchId: string,
  ): Promise<string | undefined> {
    assertUuid(outboundBatchId);
    const [batch] = await this.database
      .select({ chainId: outboundBatches.chainId })
      .from(outboundBatches)
      .where(eq(outboundBatches.id, outboundBatchId))
      .limit(1);
    return batch?.chainId ?? undefined;
  }

  public async materializeInteractionBatch(
    input: MaterializeInteractionOutboundInput,
  ): Promise<string> {
    assertUuid(input.interactionRunId);
    assertUuid(input.spaceId);
    if (
      !Number.isInteger(input.generation) ||
      input.generation < 0 ||
      input.encryptedParts.length === 0 ||
      input.encryptedParts.some((part) => part.length === 0)
    ) {
      throw new DeliveryError("DELIVERY_BATCH_INVALID", false);
    }

    return await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.spaceId}, 0))`,
      );
      await transaction.execute(sql`
        select space_id
        from ${conversationStates}
        where ${conversationStates.spaceId} = ${input.spaceId}
        for update
      `);
      await transaction.execute(sql`
        select id
        from ${interactionRuns}
        where ${interactionRuns.id} = ${input.interactionRunId}
        for update
      `);
      const [current] = await transaction
        .select({
          runId: interactionRuns.id,
          runSpaceId: interactionRuns.spaceId,
          runGeneration: interactionRuns.generation,
          runState: interactionRuns.state,
          runAcceptedThroughSequence: interactionRuns.acceptedThroughSequence,
          conversationState: conversationStates.state,
          actorGeneration: conversationStates.actorGeneration,
          activeInteractionRunId: conversationStates.activeInteractionRunId,
          conversationAcceptedThroughSequence:
            conversationStates.acceptedThroughSequence,
          conversationLatestInputSequence:
            conversationStates.latestInputSequence,
          deploymentId: spaces.deploymentId,
        })
        .from(interactionRuns)
        .innerJoin(
          conversationStates,
          eq(conversationStates.spaceId, interactionRuns.spaceId),
        )
        .innerJoin(spaces, eq(spaces.id, interactionRuns.spaceId))
        .where(eq(interactionRuns.id, input.interactionRunId))
        .limit(1);
      const [existing] = await transaction
        .select({ id: outboundBatches.id, spaceId: outboundBatches.spaceId })
        .from(outboundBatches)
        .where(
          eq(outboundBatches.interactionRunId, input.interactionRunId),
        )
        .limit(1);
      if (
        existing !== undefined &&
        existing.spaceId === input.spaceId &&
        current !== undefined &&
        current.runSpaceId === input.spaceId &&
        current.runGeneration === input.generation &&
        current.runState === "completed"
      ) {
        return existing.id;
      }
      if (
        current === undefined ||
        current.runSpaceId !== input.spaceId ||
        current.runGeneration !== input.generation ||
        current.runState !== "finalizing" ||
        current.conversationState !== "finalizing" ||
        current.actorGeneration !== input.generation ||
        current.activeInteractionRunId !== input.interactionRunId ||
        current.conversationAcceptedThroughSequence !==
          current.runAcceptedThroughSequence ||
        current.conversationLatestInputSequence !==
          current.runAcceptedThroughSequence
      ) {
        throw new DeliveryError("DELIVERY_BATCH_INVALID", false);
      }

      const outboundBatchId = randomUUID();
      await transaction.insert(outboundBatches).values({
        id: outboundBatchId,
        interactionRunId: input.interactionRunId,
        spaceId: input.spaceId,
        state: "queued",
        startIndex: 0,
        partCount: input.encryptedParts.length,
      });
      await transaction.insert(outboundParts).values(
        input.encryptedParts.map((contentCiphertext, position) => ({
          id: randomUUID(),
          batchId: outboundBatchId,
          position,
          clientGuid: stableClientGuid(
            current.deploymentId,
            outboundBatchId,
            position,
          ),
          contentCiphertext,
          state: "pending" as const,
        })),
      );

      const completedAt = await this.#databaseNow(transaction);
      const updatedRuns = await transaction
        .update(interactionRuns)
        .set({ state: "completed", completedAt, updatedAt: completedAt })
        .where(
          and(
            eq(interactionRuns.id, input.interactionRunId),
            eq(interactionRuns.spaceId, input.spaceId),
            eq(interactionRuns.generation, input.generation),
            eq(interactionRuns.state, "finalizing"),
            eq(
              interactionRuns.acceptedThroughSequence,
              current.runAcceptedThroughSequence,
            ),
          ),
        )
        .returning({ id: interactionRuns.id });
      if (updatedRuns.length !== 1) {
        throw new DeliveryError("DELIVERY_BATCH_INVALID", false);
      }

      const updatedConversations = await transaction
        .update(conversationStates)
        .set({
          state: "idle",
          activeInteractionRunId: null,
          finalizedThroughSequence: current.runAcceptedThroughSequence,
          updatedAt: completedAt,
        })
        .where(
          and(
            eq(conversationStates.spaceId, input.spaceId),
            eq(conversationStates.state, "finalizing"),
            eq(
              conversationStates.activeInteractionRunId,
              input.interactionRunId,
            ),
            eq(conversationStates.actorGeneration, input.generation),
            eq(
              conversationStates.acceptedThroughSequence,
              current.runAcceptedThroughSequence,
            ),
            eq(
              conversationStates.latestInputSequence,
              current.runAcceptedThroughSequence,
            ),
          ),
        )
        .returning({ spaceId: conversationStates.spaceId });
      if (updatedConversations.length !== 1) {
        throw new DeliveryError("DELIVERY_BATCH_INVALID", false);
      }
      await transaction
        .update(chains)
        .set({ state: "complete", completedAt, updatedAt: completedAt })
        .where(
          and(
            eq(chains.sourceInteractionRunId, input.interactionRunId),
            inArray(chains.state, ["executing", "awaiting_approval"]),
          ),
        );
      return outboundBatchId;
    });
  }

  public async claimNext(input: {
    outboundBatchId: string;
    claimOwner: string;
    leaseDurationMs: number;
    now: Date;
  }): Promise<DeliveryClaim | null> {
    assertUuid(input.outboundBatchId);
    assertDate(input.now);
    if (
      input.claimOwner.trim().length === 0 ||
      input.claimOwner.length > 128 ||
      !Number.isInteger(input.leaseDurationMs) ||
      input.leaseDurationMs < 1 ||
      input.leaseDurationMs > MAX_LEASE_DURATION_MS
    ) {
      throw new DeliveryError("DELIVERY_BATCH_INVALID", false);
    }

    const claimToken = this.#createClaimToken();
    assertUuid(claimToken);

    return await this.database.transaction(async (transaction) => {
      await this.#lockBatch(transaction, input.outboundBatchId);
      const databaseNow = await this.#databaseNow(transaction);
      const claimExpiresAt = new Date(
        databaseNow.getTime() + input.leaseDurationMs,
      );
      assertDate(claimExpiresAt);
      const [batch] = await transaction
        .select({
          id: outboundBatches.id,
          chainId: outboundBatches.chainId,
          interactionRunId: outboundBatches.interactionRunId,
          spaceId: outboundBatches.spaceId,
          state: outboundBatches.state,
          startIndex: outboundBatches.startIndex,
          partCount: outboundBatches.partCount,
          claimOwner: outboundBatches.claimOwner,
          claimToken: outboundBatches.claimToken,
          claimExpiresAt: outboundBatches.claimExpiresAt,
          chainState: chains.state,
          canceledAt: chains.canceledAt,
          runId: interactionRuns.id,
          runSpaceId: interactionRuns.spaceId,
          runGeneration: interactionRuns.generation,
          runState: interactionRuns.state,
          runAcceptedThroughSequence: interactionRuns.acceptedThroughSequence,
          conversationState: conversationStates.state,
          actorGeneration: conversationStates.actorGeneration,
          activeInteractionRunId: conversationStates.activeInteractionRunId,
          conversationAcceptedThroughSequence:
            conversationStates.acceptedThroughSequence,
        })
        .from(outboundBatches)
        .leftJoin(chains, eq(chains.id, outboundBatches.chainId))
        .leftJoin(
          interactionRuns,
          eq(interactionRuns.id, outboundBatches.interactionRunId),
        )
        .leftJoin(
          conversationStates,
          eq(conversationStates.spaceId, outboundBatches.spaceId),
        )
        .where(eq(outboundBatches.id, input.outboundBatchId))
        .limit(1);

      if (batch === undefined) {
        throw new DeliveryError("DELIVERY_BATCH_NOT_FOUND", false);
      }
      if (batch.state === "sent") {
        return null;
      }
      const origin = this.#assertBatchCanSend(batch);

      const lease: LeaseTuple = batch;
      if (!emptyLease(lease) && !completeLease(lease)) {
        throw new DeliveryError("DELIVERY_BATCH_INVALID", false);
      }
      if (
        completeLease(lease) &&
        lease.claimExpiresAt.getTime() > databaseNow.getTime()
      ) {
        throw new DeliveryError("DELIVERY_CLAIM_LOST", true);
      }
      if (
        await this.#spaceHasLiveClaim(
          transaction,
          batch.id,
          batch.spaceId,
          databaseNow,
        )
      ) {
        throw new DeliveryError("DELIVERY_CLAIM_LOST", true);
      }

      if (batch.startIndex === batch.partCount) {
        await this.#completeEmptyBatch(
          transaction,
          batch.id,
          origin,
          databaseNow,
        );
        return null;
      }

      const [part] = await transaction
        .select({
          position: outboundParts.position,
          clientGuid: outboundParts.clientGuid,
          contentCiphertext: outboundParts.contentCiphertext,
          state: outboundParts.state,
        })
        .from(outboundParts)
        .where(
          and(
            eq(outboundParts.batchId, batch.id),
            eq(outboundParts.position, batch.startIndex),
          ),
        )
        .limit(1);
      if (
        part === undefined ||
        (part.state !== "pending" && part.state !== "failed")
      ) {
        throw new DeliveryError("DELIVERY_BATCH_INVALID", false);
      }

      const claimed = await transaction
        .update(outboundBatches)
        .set({
          state: "sending",
          claimOwner: input.claimOwner,
          claimToken,
          claimExpiresAt,
          updatedAt: databaseNow,
        })
        .where(eq(outboundBatches.id, batch.id))
        .returning({ id: outboundBatches.id });
      if (claimed.length !== 1) {
        throw new DeliveryError("DELIVERY_CLAIM_LOST", true);
      }

      return {
        outboundBatchId: batch.id,
        spaceId: batch.spaceId,
        claimOwner: input.claimOwner,
        claimToken,
        claimExpiresAt,
        position: part.position,
        clientGuid: part.clientGuid,
        // The coordinator owns authenticated decryption immediately before
        // the provider call; PostgreSQL retains only this encrypted value.
        text: part.contentCiphertext,
      };
    });
  }

  public async checkpointSent(input: {
    outboundBatchId: string;
    claimToken: string;
    position: number;
    externalMessageId: string | null;
    sentAt: Date;
  }): Promise<DeliveryCheckpoint> {
    assertUuid(input.outboundBatchId);
    assertUuid(input.claimToken);
    assertPosition(input.position);
    assertDate(input.sentAt);

    return await this.database.transaction(async (transaction) => {
      await this.#lockBatch(transaction, input.outboundBatchId);
      const [batch] = await transaction
        .select({
          id: outboundBatches.id,
          chainId: outboundBatches.chainId,
          interactionRunId: outboundBatches.interactionRunId,
          spaceId: outboundBatches.spaceId,
          state: outboundBatches.state,
          startIndex: outboundBatches.startIndex,
          partCount: outboundBatches.partCount,
          claimOwner: outboundBatches.claimOwner,
          claimToken: outboundBatches.claimToken,
          claimExpiresAt: outboundBatches.claimExpiresAt,
          chainState: chains.state,
          canceledAt: chains.canceledAt,
          runId: interactionRuns.id,
          runSpaceId: interactionRuns.spaceId,
          runGeneration: interactionRuns.generation,
          runState: interactionRuns.state,
          runAcceptedThroughSequence: interactionRuns.acceptedThroughSequence,
          conversationState: conversationStates.state,
          actorGeneration: conversationStates.actorGeneration,
          activeInteractionRunId: conversationStates.activeInteractionRunId,
          conversationAcceptedThroughSequence:
            conversationStates.acceptedThroughSequence,
        })
        .from(outboundBatches)
        .leftJoin(chains, eq(chains.id, outboundBatches.chainId))
        .leftJoin(
          interactionRuns,
          eq(interactionRuns.id, outboundBatches.interactionRunId),
        )
        .leftJoin(
          conversationStates,
          eq(conversationStates.spaceId, outboundBatches.spaceId),
        )
        .where(eq(outboundBatches.id, input.outboundBatchId))
        .limit(1);
      if (batch === undefined) {
        throw new DeliveryError("DELIVERY_BATCH_NOT_FOUND", false);
      }
      const origin = this.#assertBatchCanSend(batch);

      const lease: LeaseTuple = batch;
      if (
        !completeLease(lease) ||
        lease.claimToken !== input.claimToken
      ) {
        throw new DeliveryError("DELIVERY_CLAIM_LOST", true);
      }
      if (batch.startIndex !== input.position) {
        throw new DeliveryError("DELIVERY_CLAIM_LOST", true);
      }

      const nextIndex = input.position + 1;
      if (nextIndex > batch.partCount) {
        throw new DeliveryError("DELIVERY_BATCH_INVALID", false);
      }
      const batchComplete = nextIndex === batch.partCount;

      const updatedParts = await transaction
        .update(outboundParts)
        .set({
          state: "sent",
          externalMessageId: input.externalMessageId,
          sentAt: input.sentAt,
          updatedAt: input.sentAt,
        })
        .where(
          and(
            eq(outboundParts.batchId, batch.id),
            eq(outboundParts.position, input.position),
            sql`${outboundParts.state} in ('pending', 'failed')`,
          ),
        )
        .returning({ id: outboundParts.id });
      if (updatedParts.length !== 1) {
        throw new DeliveryError("DELIVERY_BATCH_INVALID", false);
      }

      const updatedBatches = await transaction
        .update(outboundBatches)
        .set({
          startIndex: nextIndex,
          state: batchComplete ? "sent" : "sending",
          claimOwner: null,
          claimToken: null,
          claimExpiresAt: null,
          completedAt: batchComplete ? input.sentAt : null,
          updatedAt: input.sentAt,
        })
        .where(
          and(
            eq(outboundBatches.id, batch.id),
            eq(outboundBatches.state, "sending"),
            eq(outboundBatches.startIndex, input.position),
            eq(outboundBatches.claimToken, input.claimToken),
            sql`${outboundBatches.claimExpiresAt} > clock_timestamp()`,
          ),
        )
        .returning({ id: outboundBatches.id });
      if (updatedBatches.length !== 1) {
        throw new DeliveryError("DELIVERY_CLAIM_LOST", true);
      }

      if (batchComplete) {
        await this.#completeOrigin(transaction, origin, input.sentAt);
      }

      return { batchComplete, nextIndex };
    });
  }

  public async release(input: {
    outboundBatchId: string;
    claimToken: string;
    now: Date;
  }): Promise<void> {
    assertUuid(input.outboundBatchId);
    assertUuid(input.claimToken);
    assertDate(input.now);

    await this.database
      .update(outboundBatches)
      .set({
        claimOwner: null,
        claimToken: null,
        claimExpiresAt: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(outboundBatches.id, input.outboundBatchId),
          eq(outboundBatches.claimToken, input.claimToken),
        ),
      );
  }

  public async findRecoverableBatchIds(input: {
    now: Date;
    limit: number;
  }): Promise<string[]> {
    assertDate(input.now);
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new DeliveryError("DELIVERY_BATCH_INVALID", false);
    }

    const rows = await this.database
      .select({ id: outboundBatches.id })
      .from(outboundBatches)
      .leftJoin(chains, eq(chains.id, outboundBatches.chainId))
      .leftJoin(
        interactionRuns,
        eq(interactionRuns.id, outboundBatches.interactionRunId),
      )
      .leftJoin(
        conversationStates,
        eq(conversationStates.spaceId, outboundBatches.spaceId),
      )
      .where(
        and(
          sql`${outboundBatches.state} in ('queued', 'sending')`,
          or(
            and(
              isNotNull(outboundBatches.chainId),
              isNull(outboundBatches.interactionRunId),
              eq(chains.state, "sending"),
              isNull(chains.canceledAt),
            ),
            and(
              isNull(outboundBatches.chainId),
              isNotNull(outboundBatches.interactionRunId),
              eq(interactionRuns.spaceId, outboundBatches.spaceId),
              eq(interactionRuns.state, "completed"),
            ),
          ),
          or(
            and(
              isNull(outboundBatches.claimOwner),
              isNull(outboundBatches.claimToken),
              isNull(outboundBatches.claimExpiresAt),
            ),
            and(
              isNotNull(outboundBatches.claimOwner),
              isNotNull(outboundBatches.claimToken),
              isNotNull(outboundBatches.claimExpiresAt),
              lte(
                outboundBatches.claimExpiresAt,
                sql`clock_timestamp()`,
              ),
            ),
          ),
        ),
      )
      .orderBy(asc(outboundBatches.updatedAt), asc(outboundBatches.id))
      .limit(input.limit);
    return rows.map((row) => row.id);
  }

  async #lockBatch(
    transaction: DatabaseTransaction,
    outboundBatchId: string,
  ): Promise<void> {
    await transaction.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(locked_batch.space_id::text, 0))
      from ${outboundBatches} locked_batch
      where locked_batch.id = ${outboundBatchId}
    `);
    await transaction.execute(sql`
      select id
      from ${outboundBatches}
      where ${outboundBatches.id} = ${outboundBatchId}
      for update
    `);
  }

  async #databaseNow(transaction: DatabaseTransaction): Promise<Date> {
    const result = await transaction.execute<{
      currentTime: Date | string;
    }>(sql`
      select clock_timestamp() as "currentTime"
    `);
    const value = result.rows[0]?.currentTime;
    const currentTime = value instanceof Date ? value : new Date(value ?? "");
    if (!Number.isFinite(currentTime.getTime())) {
      throw new DeliveryError("DELIVERY_BATCH_INVALID", false);
    }
    return currentTime;
  }

  async #spaceHasLiveClaim(
    transaction: DatabaseTransaction,
    outboundBatchId: string,
    spaceId: string,
    now: Date,
  ): Promise<boolean> {
    const leases = await transaction
      .select({
        claimOwner: outboundBatches.claimOwner,
        claimToken: outboundBatches.claimToken,
        claimExpiresAt: outboundBatches.claimExpiresAt,
      })
      .from(outboundBatches)
      .where(
        and(
          eq(outboundBatches.spaceId, spaceId),
          ne(outboundBatches.id, outboundBatchId),
          sql`${outboundBatches.state} in ('queued', 'sending')`,
        ),
      );

    for (const lease of leases) {
      if (!emptyLease(lease) && !completeLease(lease)) {
        throw new DeliveryError("DELIVERY_BATCH_INVALID", false);
      }
      if (
        completeLease(lease) &&
        lease.claimExpiresAt.getTime() > now.getTime()
      ) {
        return true;
      }
    }
    return false;
  }

  #assertBatchCanSend(batch: {
    state: "queued" | "sending" | "sent" | "failed" | "canceled";
    chainId: string | null;
    interactionRunId: string | null;
    spaceId: string;
    chainState:
      | "queued"
      | "planning"
      | "executing"
      | "awaiting_approval"
      | "synthesizing"
      | "sending"
      | "complete"
      | "failed"
      | "canceled"
      | null;
    canceledAt: Date | null;
    runId: string | null;
    runSpaceId: string | null;
    runGeneration: number | null;
    runState:
      | "starting"
      | "active"
      | "finalizing"
      | "completed"
      | "failed"
      | "canceled"
      | "interrupted"
      | "orphaned"
      | null;
    runAcceptedThroughSequence: number | null;
    conversationState:
      | "idle"
      | "starting"
      | "active"
      | "finalizing"
      | "recovering"
      | null;
    actorGeneration: number | null;
    activeInteractionRunId: string | null;
    conversationAcceptedThroughSequence: number | null;
  }): SendableOrigin {
    if (batch.state !== "queued" && batch.state !== "sending") {
      throw new DeliveryError("DELIVERY_BATCH_INVALID", false);
    }

    if (batch.chainId !== null && batch.interactionRunId === null) {
      if (batch.chainState !== "sending" || batch.canceledAt !== null) {
        throw new DeliveryError("DELIVERY_BATCH_INVALID", false);
      }
      return { kind: "chain", chainId: batch.chainId };
    }

    if (
      batch.chainId === null &&
      batch.interactionRunId !== null &&
      batch.runId === batch.interactionRunId &&
      batch.runSpaceId === batch.spaceId &&
      batch.runState === "completed" &&
      batch.runGeneration !== null &&
      batch.runAcceptedThroughSequence !== null
    ) {
      return {
        kind: "interaction",
        interactionRunId: batch.interactionRunId,
        generation: batch.runGeneration,
        acceptedThroughSequence: batch.runAcceptedThroughSequence,
        spaceId: batch.spaceId,
      };
    }

    throw new DeliveryError("DELIVERY_BATCH_INVALID", false);
  }

  async #completeEmptyBatch(
    transaction: DatabaseTransaction,
    outboundBatchId: string,
    origin: SendableOrigin,
    completedAt: Date,
  ): Promise<void> {
    await transaction
      .update(outboundBatches)
      .set({
        state: "sent",
        claimOwner: null,
        claimToken: null,
        claimExpiresAt: null,
        completedAt,
        updatedAt: completedAt,
      })
      .where(eq(outboundBatches.id, outboundBatchId));
    await this.#completeOrigin(transaction, origin, completedAt);
  }

  async #completeOrigin(
    transaction: DatabaseTransaction,
    origin: SendableOrigin,
    completedAt: Date,
  ): Promise<void> {
    if (origin.kind === "chain") {
      const updatedChains = await transaction
        .update(chains)
        .set({ state: "complete", completedAt, updatedAt: completedAt })
        .where(
          and(
            eq(chains.id, origin.chainId),
            eq(chains.state, "sending"),
            isNull(chains.canceledAt),
          ),
        )
        .returning({ id: chains.id });
      if (updatedChains.length !== 1) {
        throw new DeliveryError("DELIVERY_CLAIM_LOST", true);
      }
      return;
    }
    // Interaction-origin runs and cursors complete atomically with batch
    // materialization. Provider checkpoints only advance the durable batch.
  }
}

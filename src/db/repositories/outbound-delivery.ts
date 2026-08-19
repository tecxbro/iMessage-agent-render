import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  eq,
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
  chains,
  outboundBatches,
  outboundParts,
} from "../schema.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_LEASE_DURATION_MS = 24 * 60 * 60 * 1_000;

export interface OutboundDeliveryRepositoryOptions {
  createClaimToken?: () => string;
}

type LeaseTuple = {
  claimOwner: string | null;
  claimToken: string | null;
  claimExpiresAt: Date | null;
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
          spaceId: outboundBatches.spaceId,
          state: outboundBatches.state,
          startIndex: outboundBatches.startIndex,
          partCount: outboundBatches.partCount,
          claimOwner: outboundBatches.claimOwner,
          claimToken: outboundBatches.claimToken,
          claimExpiresAt: outboundBatches.claimExpiresAt,
          chainState: chains.state,
          canceledAt: chains.canceledAt,
        })
        .from(outboundBatches)
        .innerJoin(chains, eq(chains.id, outboundBatches.chainId))
        .where(eq(outboundBatches.id, input.outboundBatchId))
        .limit(1);

      if (batch === undefined) {
        throw new DeliveryError("DELIVERY_BATCH_NOT_FOUND", false);
      }
      if (batch.state === "sent") {
        return null;
      }
      this.#assertBatchCanSend(batch);

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
          batch.chainId,
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
          state: outboundBatches.state,
          startIndex: outboundBatches.startIndex,
          partCount: outboundBatches.partCount,
          claimOwner: outboundBatches.claimOwner,
          claimToken: outboundBatches.claimToken,
          claimExpiresAt: outboundBatches.claimExpiresAt,
          chainState: chains.state,
          canceledAt: chains.canceledAt,
        })
        .from(outboundBatches)
        .innerJoin(chains, eq(chains.id, outboundBatches.chainId))
        .where(eq(outboundBatches.id, input.outboundBatchId))
        .limit(1);
      if (batch === undefined) {
        throw new DeliveryError("DELIVERY_BATCH_NOT_FOUND", false);
      }
      this.#assertBatchCanSend(batch);

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
        const updatedChains = await transaction
          .update(chains)
          .set({
            state: "complete",
            completedAt: input.sentAt,
            updatedAt: input.sentAt,
          })
          .where(
            and(
              eq(chains.id, batch.chainId),
              eq(chains.state, "sending"),
              isNull(chains.canceledAt),
            ),
          )
          .returning({ id: chains.id });
        if (updatedChains.length !== 1) {
          throw new DeliveryError("DELIVERY_CLAIM_LOST", true);
        }
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
      .innerJoin(chains, eq(chains.id, outboundBatches.chainId))
      .where(
        and(
          sql`${outboundBatches.state} in ('queued', 'sending')`,
          eq(chains.state, "sending"),
          isNull(chains.canceledAt),
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
    chainState:
      | "queued"
      | "planning"
      | "executing"
      | "awaiting_approval"
      | "synthesizing"
      | "sending"
      | "complete"
      | "failed"
      | "canceled";
    canceledAt: Date | null;
  }): void {
    if (
      (batch.state !== "queued" && batch.state !== "sending") ||
      batch.chainState !== "sending" ||
      batch.canceledAt !== null
    ) {
      throw new DeliveryError("DELIVERY_BATCH_INVALID", false);
    }
  }

  async #completeEmptyBatch(
    transaction: DatabaseTransaction,
    outboundBatchId: string,
    chainId: string,
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
    await transaction
      .update(chains)
      .set({ state: "complete", completedAt, updatedAt: completedAt })
      .where(
        and(
          eq(chains.id, chainId),
          eq(chains.state, "sending"),
          isNull(chains.canceledAt),
        ),
      );
  }
}

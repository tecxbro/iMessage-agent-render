import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";

import type { ApprovalPersistence, StoredApprovalRecord } from "../../security/approvals.js";
import type { Database } from "../client.js";
import {
  approvals,
  chains,
  channelIdentities,
  deployments,
  executionTasks,
  owners,
  spaces,
} from "../schema.js";

export interface CreateApprovalInput {
  id?: string;
  chainId: string;
  executionTaskId: string;
  ownerId: string;
  spaceId: string;
  actionType: string;
  normalizedPayloadCiphertext: string;
  actionHash: string;
  humanSummary: string;
  expiresAt: Date;
}

export interface ApprovalResponseInput {
  approvalId: string;
  ownerId: string;
  spaceId: string;
  approvedByIdentityId?: string;
  status: "approved" | "rejected";
  now?: Date;
}

export interface ConsumeApprovedActionInput {
  approvalId: string;
  ownerId: string;
  spaceId: string;
  executionTaskId: string;
  expectedActionHash: string;
  expectedPayloadCiphertext: string;
  now?: Date;
}

const approvalSelection = {
  id: approvals.id,
  chainId: approvals.chainId,
  executionTaskId: approvals.executionTaskId,
  ownerId: approvals.ownerId,
  spaceId: approvals.spaceId,
  actionType: approvals.actionType,
  normalizedPayloadCiphertext: approvals.normalizedPayloadCiphertext,
  actionHash: approvals.actionHash,
  humanSummary: approvals.humanSummary,
  status: approvals.status,
  expiresAt: approvals.expiresAt,
};

export class ApprovalRepository implements ApprovalPersistence {
  public constructor(private readonly database: Database) {}

  public async createPending(input: CreateApprovalInput): Promise<string> {
    const approvalId = input.id ?? randomUUID();
    await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.spaceId}, 0))`,
      );
      const [chain] = await transaction
        .select({ id: chains.id })
        .from(chains)
        .innerJoin(spaces, eq(chains.spaceId, spaces.id))
        .innerJoin(owners, eq(owners.deploymentId, spaces.deploymentId))
        .innerJoin(deployments, eq(deployments.id, spaces.deploymentId))
        .where(
          and(
            eq(chains.id, input.chainId),
            eq(chains.spaceId, input.spaceId),
            eq(owners.id, input.ownerId),
            eq(owners.status, "active"),
            eq(deployments.status, "active"),
            inArray(chains.state, ["executing", "awaiting_approval"]),
            isNull(chains.canceledAt),
            sql`${chains.version} = (select max(current_chain.version) from ${chains} current_chain where current_chain.space_id = ${chains.spaceId})`,
          ),
        )
        .for("update")
        .limit(1);
      if (chain === undefined) {
        throw new Error(
          "Approval creation rejected because its owner, deployment, or current chain is inactive. Reload authoritative state before retrying.",
        );
      }
      const [task] = await transaction
        .select({ id: executionTasks.id })
        .from(executionTasks)
        .where(
          and(
            eq(executionTasks.id, input.executionTaskId),
            eq(executionTasks.chainId, input.chainId),
            eq(executionTasks.state, "needs_approval"),
          ),
        )
        .for("update")
        .limit(1);
      if (task === undefined) {
        throw new Error(
          "Approval creation rejected because its execution task is not awaiting approval on the same chain.",
        );
      }

      await transaction.insert(approvals).values({
        id: approvalId,
        chainId: input.chainId,
        executionTaskId: input.executionTaskId,
        ownerId: input.ownerId,
        spaceId: input.spaceId,
        actionType: input.actionType,
        normalizedPayloadCiphertext: input.normalizedPayloadCiphertext,
        actionHash: input.actionHash,
        humanSummary: input.humanSummary,
        status: "pending",
        expiresAt: input.expiresAt,
      });
      const transitioned = await transaction
        .update(chains)
        .set({ state: "awaiting_approval", updatedAt: new Date() })
        .where(
          and(
            eq(chains.id, input.chainId),
            inArray(chains.state, ["executing", "awaiting_approval"]),
            isNull(chains.canceledAt),
          ),
        )
        .returning({ id: chains.id });
      if (transitioned.length !== 1) {
        throw new Error(
          "Approval creation lost a cancellation race. The transaction was rolled back without reviving the chain.",
        );
      }
    });
    return approvalId;
  }

  public async findBound(
    approvalId: string,
    ownerId: string,
    spaceId: string,
  ): Promise<StoredApprovalRecord | undefined> {
    const [row] = await this.database
      .select(approvalSelection)
      .from(approvals)
      .where(
        and(
          eq(approvals.id, approvalId),
          eq(approvals.ownerId, ownerId),
          eq(approvals.spaceId, spaceId),
        ),
      )
      .limit(1);
    return row;
  }

  public async listPending(
    ownerId: string,
    spaceId: string,
    now: Date,
  ): Promise<StoredApprovalRecord[]> {
    return this.database
      .select(approvalSelection)
      .from(approvals)
      .where(
        and(
          eq(approvals.ownerId, ownerId),
          eq(approvals.spaceId, spaceId),
          eq(approvals.status, "pending"),
          gt(approvals.expiresAt, now),
        ),
      )
      .orderBy(asc(approvals.createdAt), asc(approvals.id))
      .limit(20);
  }

  public async compareAndSetResponse(input: ApprovalResponseInput): Promise<boolean> {
    const now = input.now ?? new Date();
    if (input.approvedByIdentityId === undefined) {
      throw new Error(
        "Approval response requires the verified owner channel identity.",
      );
    }
    const approvedByIdentityId = input.approvedByIdentityId;
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.spaceId}, 0))`,
      );
      const [actor] = await transaction
        .select({ id: channelIdentities.id })
        .from(channelIdentities)
        .innerJoin(owners, eq(channelIdentities.ownerId, owners.id))
        .innerJoin(
          deployments,
          eq(channelIdentities.deploymentId, deployments.id),
        )
        .innerJoin(spaces, eq(spaces.deploymentId, deployments.id))
        .where(
          and(
            eq(channelIdentities.id, approvedByIdentityId),
            eq(channelIdentities.ownerId, input.ownerId),
            eq(channelIdentities.role, "owner"),
            isNull(channelIdentities.revokedAt),
            eq(owners.status, "active"),
            eq(deployments.status, "active"),
            eq(spaces.id, input.spaceId),
          ),
        )
        .limit(1);
      if (actor === undefined) {
        return false;
      }

      const rows = await transaction
        .update(approvals)
        .set({
          status: input.status,
          approvedByIdentityId:
            input.status === "approved" ? input.approvedByIdentityId : null,
          updatedAt: now,
        })
        .where(
          and(
            eq(approvals.id, input.approvalId),
            eq(approvals.ownerId, input.ownerId),
            eq(approvals.spaceId, input.spaceId),
            eq(approvals.status, "pending"),
            gt(approvals.expiresAt, now),
            sql`exists (
              select 1 from chains live_chain
              where live_chain.id = ${approvals.chainId}
                and live_chain.state = 'awaiting_approval'
                and live_chain.canceled_at is null
                and live_chain.version = (
                  select max(current_chain.version) from chains current_chain
                  where current_chain.space_id = live_chain.space_id
                )
            )`,
          ),
        )
        .returning({
          id: approvals.id,
          chainId: approvals.chainId,
          executionTaskId: approvals.executionTaskId,
        });
      const changed = rows[0];
      if (changed !== undefined && input.status === "rejected") {
        await transaction
          .update(executionTasks)
          .set({ state: "canceled", completedAt: now, updatedAt: now })
          .where(
            and(
              eq(executionTasks.id, changed.executionTaskId),
              eq(executionTasks.state, "needs_approval"),
            ),
          );
        await transaction
          .update(chains)
          .set({ state: "executing", updatedAt: now })
          .where(
            and(
              eq(chains.id, changed.chainId),
              eq(chains.state, "awaiting_approval"),
              isNull(chains.canceledAt),
            ),
          );
      }
      return changed !== undefined;
    });
  }

  public async consumeApprovedAction(
    input: ConsumeApprovedActionInput,
  ): Promise<boolean> {
    const now = input.now ?? new Date();
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.spaceId}, 0))`,
      );
      const [approval] = await transaction
        .select({
          id: approvals.id,
          chainId: approvals.chainId,
          approvedByIdentityId: approvals.approvedByIdentityId,
        })
        .from(approvals)
        .where(
          and(
            eq(approvals.id, input.approvalId),
            eq(approvals.ownerId, input.ownerId),
            eq(approvals.spaceId, input.spaceId),
            eq(approvals.executionTaskId, input.executionTaskId),
            eq(approvals.actionHash, input.expectedActionHash),
            eq(
              approvals.normalizedPayloadCiphertext,
              input.expectedPayloadCiphertext,
            ),
            eq(approvals.status, "approved"),
            gt(approvals.expiresAt, now),
            isNull(approvals.consumedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (approval?.approvedByIdentityId === null || approval === undefined) {
        return false;
      }

      const [live] = await transaction
        .select({ id: chains.id })
        .from(chains)
        .innerJoin(executionTasks, eq(executionTasks.chainId, chains.id))
        .innerJoin(
          channelIdentities,
          eq(channelIdentities.id, approval.approvedByIdentityId),
        )
        .innerJoin(owners, eq(owners.id, channelIdentities.ownerId))
        .innerJoin(deployments, eq(deployments.id, channelIdentities.deploymentId))
        .where(
          and(
            eq(chains.id, approval.chainId),
            eq(chains.spaceId, input.spaceId),
            eq(chains.state, "awaiting_approval"),
            isNull(chains.canceledAt),
            sql`${chains.version} = (select max(current_chain.version) from ${chains} current_chain where current_chain.space_id = ${chains.spaceId})`,
            eq(executionTasks.id, input.executionTaskId),
            eq(executionTasks.state, "needs_approval"),
            eq(channelIdentities.ownerId, input.ownerId),
            eq(channelIdentities.role, "owner"),
            isNull(channelIdentities.revokedAt),
            eq(owners.status, "active"),
            eq(deployments.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (live === undefined) {
        return false;
      }

      const consumed = await transaction
        .update(approvals)
        .set({ status: "consumed", consumedAt: now, updatedAt: now })
        .where(
          and(
            eq(approvals.id, input.approvalId),
            eq(approvals.status, "approved"),
            isNull(approvals.consumedAt),
          ),
        )
        .returning({ id: approvals.id });
      if (consumed.length !== 1) {
        return false;
      }
      await transaction
        .update(executionTasks)
        .set({ state: "running", startedAt: now, updatedAt: now })
        .where(
          and(
            eq(executionTasks.id, input.executionTaskId),
            eq(executionTasks.state, "needs_approval"),
          ),
        );
      await transaction
        .update(chains)
        .set({ state: "executing", updatedAt: now })
        .where(eq(chains.id, approval.chainId));
      return true;
    });
  }

  public async expireStale(
    ownerId: string,
    spaceId: string,
    now: Date,
  ): Promise<number> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${spaceId}, 0))`,
      );
      const rows = await transaction
        .update(approvals)
        .set({ status: "expired", updatedAt: now })
        .where(
          and(
            eq(approvals.ownerId, ownerId),
            eq(approvals.spaceId, spaceId),
            inArray(approvals.status, ["pending", "approved"]),
            lte(approvals.expiresAt, now),
            isNull(approvals.consumedAt),
          ),
        )
        .returning({
          id: approvals.id,
          chainId: approvals.chainId,
          executionTaskId: approvals.executionTaskId,
        });
      if (rows.length > 0) {
        await transaction
          .update(executionTasks)
          .set({ state: "canceled", completedAt: now, updatedAt: now })
          .where(
            and(
              inArray(
                executionTasks.id,
                rows.map((row) => row.executionTaskId),
              ),
              eq(executionTasks.state, "needs_approval"),
            ),
          );
        await transaction
          .update(chains)
          .set({ state: "executing", updatedAt: now })
          .where(
            and(
              inArray(
                chains.id,
                rows.map((row) => row.chainId),
              ),
              eq(chains.state, "awaiting_approval"),
              isNull(chains.canceledAt),
            ),
          );
      }
      return rows.length;
    });
  }
}

import { randomUUID } from "node:crypto";

import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import { approvals, chains, executionTasks } from "../schema.js";

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

export type ApprovalResponseStatus = "approved" | "rejected" | "expired";

export interface ApprovalResponseInput {
  approvalId: string;
  ownerId: string;
  spaceId: string;
  approvedByIdentityId?: string;
  status: ApprovalResponseStatus;
  now?: Date;
}

export class ApprovalRepository {
  public constructor(private readonly database: Database) {}

  public async createPending(input: CreateApprovalInput): Promise<string> {
    const approvalId = input.id ?? randomUUID();
    await this.database.transaction(async (transaction) => {
      const [chain] = await transaction
        .select({ id: chains.id })
        .from(chains)
        .where(
          and(
            eq(chains.id, input.chainId),
            eq(chains.spaceId, input.spaceId),
            inArray(chains.state, ["executing", "awaiting_approval"]),
            isNull(chains.canceledAt),
          ),
        )
        .limit(1);
      if (chain === undefined) {
        throw new Error(
          "Approval creation rejected because its chain is missing, canceled, or bound to another space. Reload authoritative state before retrying.",
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
        .limit(1);
      if (task === undefined) {
        throw new Error(
          "Approval creation rejected because its execution task is not bound to the same chain. Repair the task reference before retrying.",
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
      await transaction
        .update(chains)
        .set({ state: "awaiting_approval", updatedAt: new Date() })
        .where(eq(chains.id, input.chainId));
    });
    return approvalId;
  }

  public async compareAndSetResponse(input: ApprovalResponseInput): Promise<boolean> {
    const now = input.now ?? new Date();
    if (input.status === "approved" && input.approvedByIdentityId === undefined) {
      throw new Error(
        "Approval acceptance requires the verified channel identity that approved it.",
      );
    }
    const expiryCondition =
      input.status === "expired"
        ? lte(approvals.expiresAt, now)
        : gt(approvals.expiresAt, now);
    const rows = await this.database
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
          expiryCondition,
        ),
      )
      .returning({ id: approvals.id });

    return rows.length === 1;
  }

  public async consumeApproved(
    approvalId: string,
    ownerId: string,
    spaceId: string,
    expectedActionHash: string,
    now = new Date(),
  ): Promise<boolean> {
    const rows = await this.database
      .update(approvals)
      .set({ status: "consumed", consumedAt: now, updatedAt: now })
      .where(
        and(
          eq(approvals.id, approvalId),
          eq(approvals.ownerId, ownerId),
          eq(approvals.spaceId, spaceId),
          eq(approvals.actionHash, expectedActionHash),
          eq(approvals.status, "approved"),
          gt(approvals.expiresAt, now),
          isNull(approvals.consumedAt),
          sql`exists (
            select 1 from chains live_chain
            where live_chain.id = ${approvals.chainId}
              and live_chain.state = 'awaiting_approval'
              and live_chain.canceled_at is null
          )`,
        ),
      )
      .returning({ id: approvals.id });

    return rows.length === 1;
  }
}

import { sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  approvals,
  executionTasks,
  failureEvents,
  messages,
  usageEvents,
} from "../schema.js";

export interface RetentionCutoffs {
  rawContentBefore: Date;
  failuresBefore: Date;
  usageBefore: Date;
}

export interface RetentionResult {
  messageBodiesShredded: number;
  taskInstructionsShredded: number;
  approvalPayloadsShredded: number;
  failureEventsDeleted: number;
  usageEventsDeleted: number;
}

export class RetentionRepository {
  public constructor(private readonly database: Database) {}

  public async applyRetention(cutoffs: RetentionCutoffs): Promise<RetentionResult> {
    return this.database.transaction(async (transaction) => {
      const shreddedMessages = await transaction.execute(sql`
        update ${messages} retained_message
        set content_ciphertext = null, updated_at = now()
        where retained_message.content_ciphertext is not null
          and retained_message.retention_expires_at < ${cutoffs.rawContentBefore}
          and (
            retained_message.direction = 'outbound'
            or (
              retained_message.drained_chain_id is not null
              and not exists (
                select 1 from chains active_chain
                where active_chain.id = retained_message.drained_chain_id
                  and active_chain.state in ('queued', 'planning', 'executing', 'awaiting_approval', 'synthesizing', 'sending')
              )
              and not exists (
                select 1 from carried_messages carried
                left join chains consuming_chain on consuming_chain.id = carried.consumed_by_chain_id
                where carried.source_message_id = retained_message.id
                  and (
                    carried.consumed_by_chain_id is null
                    or consuming_chain.state in ('queued', 'planning', 'executing', 'awaiting_approval', 'synthesizing', 'sending')
                  )
              )
            )
          )
      `);
      const shreddedTasks = await transaction.execute(sql`
        update ${executionTasks} retained_task
        set instructions_ciphertext = null, result_json = null, updated_at = now()
        where retained_task.completed_at < ${cutoffs.rawContentBefore}
          and retained_task.state in ('succeeded', 'failed', 'canceled')
          and not exists (
            select 1 from chains active_chain
            where active_chain.id = retained_task.chain_id
              and active_chain.state in ('queued', 'planning', 'executing', 'awaiting_approval', 'synthesizing', 'sending')
          )
      `);
      const shreddedApprovals = await transaction.execute(sql`
        update ${approvals} retained_approval
        set normalized_payload_ciphertext = null, updated_at = now()
        where retained_approval.updated_at < ${cutoffs.rawContentBefore}
          and retained_approval.status in ('rejected', 'expired', 'consumed')
      `);
      const deletedFailures = await transaction
        .delete(failureEvents)
        .where(sql`${failureEvents.retentionExpiresAt} < ${cutoffs.failuresBefore}`)
        .returning({ id: failureEvents.id });
      const deletedUsage = await transaction
        .delete(usageEvents)
        .where(sql`${usageEvents.createdAt} < ${cutoffs.usageBefore}`)
        .returning({ id: usageEvents.id });

      return {
        messageBodiesShredded: shreddedMessages.rowCount ?? 0,
        taskInstructionsShredded: shreddedTasks.rowCount ?? 0,
        approvalPayloadsShredded: shreddedApprovals.rowCount ?? 0,
        failureEventsDeleted: deletedFailures.length,
        usageEventsDeleted: deletedUsage.length,
      };
    });
  }
}

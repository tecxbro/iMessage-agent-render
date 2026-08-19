import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { EncryptedConversationInput } from "../../conversation/contracts.js";
import {
  conversationInitializationResultSchema,
  type ConversationInitializationResult,
} from "../../conversation/state.js";
import type { Database, DatabaseTransaction } from "../client.js";
import { conversationStates } from "../schema-fragments/conversation-actors.js";
import { chains, messages } from "../schema.js";
import {
  conversationStateSelection,
  ensureAndLockConversationState,
} from "./conversation-state.js";

export interface SequencedInboundIngestResult {
  messageId: string;
  spaceId: string;
  inputSequence: number;
  inserted: boolean;
}

export interface SequencedInboundActorResult {
  result: SequencedInboundIngestResult;
  actorGeneration: number;
}

interface InitializedConversation {
  result: ConversationInitializationResult;
  actorGeneration: number;
}

function requiredSequence(value: number | null, label: string): number {
  if (value === null || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Conversation ${label} is invalid. Repair the sequenced inbound rows before starting the actor.`,
    );
  }
  return value;
}

async function initializeInTransaction(
  transaction: DatabaseTransaction,
  spaceId: string,
  cursorPolicy: "repair_completed_prefix" | "preserve_finalization",
): Promise<InitializedConversation> {
  const locked = await ensureAndLockConversationState(transaction, spaceId);
  const nullableRows = await transaction
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.spaceId, spaceId),
        eq(messages.direction, "inbound"),
        isNull(messages.inputSequence),
      ),
    );

  if (
    nullableRows.length > 0 &&
    (locked.actorGeneration !== 0 ||
      locked.state !== "idle" ||
      locked.activeInteractionRunId !== null)
  ) {
    throw new Error(
      "Unsequenced inbound data was found after conversation actor activation. Stop the actor and repair the affected space before retrying.",
    );
  }

  const mayRepairLegacyState =
    locked.actorGeneration === 0 &&
    locked.state === "idle" &&
    locked.activeInteractionRunId === null &&
    (cursorPolicy === "repair_completed_prefix" ||
      nullableRows.length > 0 ||
      (locked.acceptedThroughSequence === locked.latestInputSequence &&
        locked.finalizedThroughSequence === locked.latestInputSequence));

  if (!mayRepairLegacyState) {
    return {
      result: conversationInitializationResultSchema.parse({
        state: locked,
        backfilledInputCount: 0,
      }),
      actorGeneration: locked.actorGeneration,
    };
  }

  // Migration 0011 used a broader historical ordering and finalized every
  // row. Before generation 1, normalize the complete legacy set once under
  // the per-space lock so the runtime starts from received_at, id exactly.
  await transaction.execute(sql`
    with "temporary_order" as (
      select
        "id",
        row_number() over (order by "id") as "temporary_sequence"
      from "messages"
      where "space_id" = ${spaceId}
        and "direction" = 'inbound'
    )
    update "messages" as "message"
    set "input_sequence" = -"temporary_order"."temporary_sequence"
    from "temporary_order"
    where "message"."id" = "temporary_order"."id"
  `);
  await transaction.execute(sql`
    with "received_order" as (
      select
        "id",
        row_number() over (
          order by "received_at", "id"
        ) as "input_sequence"
      from "messages"
      where "space_id" = ${spaceId}
        and "direction" = 'inbound'
    )
    update "messages" as "message"
    set "input_sequence" = "received_order"."input_sequence"
    from "received_order"
    where "message"."id" = "received_order"."id"
  `);

  const sequencedRows = await transaction
    .select({
      inputSequence: messages.inputSequence,
      representedByCompletedWork: sql<boolean>`(
        coalesce(${chains.state} = 'complete', false)
        or exists (
          select 1
          from "carried_messages" as "carried"
          inner join "chains" as "consuming_chain"
            on "consuming_chain"."id" = "carried"."consumed_by_chain_id"
          where "carried"."source_message_id" = ${messages.id}
            and "consuming_chain"."state" = 'complete'
        )
      )`,
    })
    .from(messages)
    .leftJoin(chains, eq(chains.id, messages.drainedChainId))
    .where(
      and(
        eq(messages.spaceId, spaceId),
        eq(messages.direction, "inbound"),
      ),
    )
    .orderBy(asc(messages.inputSequence), asc(messages.id));

  let latestInputSequence = 0;
  let finalizedThroughSequence = 0;
  let prefixComplete = true;
  for (const [index, row] of sequencedRows.entries()) {
    const sequence = requiredSequence(row.inputSequence, "input sequence");
    const expectedSequence = index + 1;
    if (sequence !== expectedSequence) {
      throw new Error(
        "Conversation input sequencing is not contiguous. Repair the affected space before starting the actor.",
      );
    }
    latestInputSequence = sequence;
    if (prefixComplete && row.representedByCompletedWork) {
      finalizedThroughSequence = sequence;
    } else {
      prefixComplete = false;
    }
  }

  const [updated] = await transaction
    .update(conversationStates)
    .set({
      latestInputSequence,
      acceptedThroughSequence:
        cursorPolicy === "preserve_finalization"
          ? locked.acceptedThroughSequence
          : finalizedThroughSequence,
      finalizedThroughSequence:
        cursorPolicy === "preserve_finalization"
          ? locked.finalizedThroughSequence
          : finalizedThroughSequence,
      updatedAt: new Date(),
    })
    .where(eq(conversationStates.spaceId, spaceId))
    .returning(conversationStateSelection);
  if (updated === undefined) {
    throw new Error(
      "Conversation initialization lost its state row. Restore the space state before retrying.",
    );
  }

  return {
    result: conversationInitializationResultSchema.parse({
      state: updated,
      backfilledInputCount: nullableRows.length,
    }),
    actorGeneration: updated.actorGeneration,
  };
}

export class SequencedInboundRepository {
  public constructor(private readonly database: Database) {}

  public async initializeConversation(input: {
    spaceId: string;
  }): Promise<ConversationInitializationResult> {
    return this.database.transaction(async (transaction) =>
      (
        await initializeInTransaction(
          transaction,
          input.spaceId,
          "repair_completed_prefix",
        )
      ).result,
    );
  }

  /** The concrete leaf API preserves the flat result required by Worktree A. */
  public async ingestInput(
    input: EncryptedConversationInput,
  ): Promise<SequencedInboundIngestResult> {
    return (await this.ingestForActor(input)).result;
  }

  /** The frozen actor-port adapter also needs the generation observed in the transaction. */
  public async ingestForActor(
    input: EncryptedConversationInput,
  ): Promise<SequencedInboundActorResult> {
    return await this.#ingest(input, "repair_completed_prefix");
  }

  /**
   * Observe-mode ingestion sequences legacy rows and advances latest input,
   * but deliberately leaves accepted/finalized ownership with the legacy path.
   */
  public async ingestForObservation(
    input: EncryptedConversationInput,
  ): Promise<SequencedInboundActorResult> {
    return await this.#ingest(input, "preserve_finalization");
  }

  async #ingest(
    input: EncryptedConversationInput,
    cursorPolicy: "repair_completed_prefix" | "preserve_finalization",
  ): Promise<SequencedInboundActorResult> {
    return this.database.transaction(async (transaction) => {
      const initialized = await initializeInTransaction(
        transaction,
        input.spaceId,
        cursorPolicy,
      );
      const state = initialized.result.state;
      const [duplicate] = await transaction
        .select({
          id: messages.id,
          inputSequence: messages.inputSequence,
        })
        .from(messages)
        .where(
          and(
            eq(messages.spaceId, input.spaceId),
            eq(messages.externalMessageId, input.externalMessageId),
          ),
        )
        .limit(1);
      if (duplicate !== undefined) {
        return {
          result: {
            messageId: duplicate.id,
            spaceId: input.spaceId,
            inputSequence: requiredSequence(
              duplicate.inputSequence,
              "duplicate input sequence",
            ),
            inserted: false,
          },
          actorGeneration: state.actorGeneration,
        };
      }

      const inputSequence = state.latestInputSequence + 1;
      const [inserted] = await transaction
        .insert(messages)
        .values({
          id: input.messageId,
          spaceId: input.spaceId,
          externalMessageId: input.externalMessageId,
          direction: "inbound",
          inputSequence,
          senderIdentityId: input.senderIdentityId,
          contentType: "text",
          contentCiphertext: input.contentCiphertext,
          contentHash: input.contentHash,
          receivedAt: input.receivedAt,
          retentionExpiresAt: input.retentionExpiresAt,
        })
        .returning({ id: messages.id });
      if (inserted === undefined) {
        throw new Error(
          "Sequenced inbound insertion returned no row. Inspect database constraints before retrying ingestion.",
        );
      }

      const [advanced] = await transaction
        .update(conversationStates)
        .set({ latestInputSequence: inputSequence, updatedAt: new Date() })
        .where(
          and(
            eq(conversationStates.spaceId, input.spaceId),
            eq(
              conversationStates.latestInputSequence,
              state.latestInputSequence,
            ),
          ),
        )
        .returning({ actorGeneration: conversationStates.actorGeneration });
      if (advanced === undefined) {
        throw new Error(
          "Conversation sequence advancement lost its locked cursor. Retry only after inspecting the authoritative state.",
        );
      }

      return {
        result: {
          messageId: inserted.id,
          spaceId: input.spaceId,
          inputSequence,
          inserted: true,
        },
        actorGeneration: advanced.actorGeneration,
      };
    });
  }
}

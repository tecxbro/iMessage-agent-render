import { and, eq } from "drizzle-orm";

import {
  conversationCasPreconditionSchema,
  conversationStateRecordSchema,
  type ConversationActorState,
  type ConversationCasFailure,
  type ConversationCasFailureReason,
  type ConversationCasPrecondition,
  type ConversationStateRecord,
} from "../../conversation/state.js";
import type { Database, DatabaseTransaction } from "../client.js";
import { conversationStates } from "../schema-fragments/conversation-actors.js";
import { spaces } from "../schema.js";

export const conversationStateSelection = {
  spaceId: conversationStates.spaceId,
  latestInputSequence: conversationStates.latestInputSequence,
  acceptedThroughSequence: conversationStates.acceptedThroughSequence,
  finalizedThroughSequence: conversationStates.finalizedThroughSequence,
  actorGeneration: conversationStates.actorGeneration,
  activeInteractionRunId: conversationStates.activeInteractionRunId,
  state: conversationStates.state,
  updatedAt: conversationStates.updatedAt,
};

export type ConversationStateMutationResult =
  | { status: "applied"; state: ConversationStateRecord }
  | ConversationCasFailure;

export interface IncrementActorGenerationInput {
  spaceId: string;
  expectedConversation: ConversationCasPrecondition;
  nextState: ConversationActorState;
  /** Generation invalidation always clears the old authoritative pointer. */
  nextActiveInteractionRunId: null;
}

export function parseConversationState(
  row: typeof conversationStates.$inferSelect,
): ConversationStateRecord {
  return conversationStateRecordSchema.parse(row);
}

export function conversationMatches(
  actual: ConversationStateRecord,
  expected: ConversationCasPrecondition,
): boolean {
  return (
    actual.actorGeneration === expected.actorGeneration &&
    actual.state === expected.state &&
    actual.activeInteractionRunId === expected.activeInteractionRunId &&
    actual.latestInputSequence === expected.latestInputSequence &&
    actual.acceptedThroughSequence === expected.acceptedThroughSequence &&
    actual.finalizedThroughSequence === expected.finalizedThroughSequence
  );
}

export function classifyConversationMiss(
  actual: ConversationStateRecord,
  expected: ConversationCasPrecondition,
  reason: ConversationCasFailureReason = "conversation_precondition",
): ConversationCasFailure {
  if (actual.actorGeneration !== expected.actorGeneration) {
    return {
      status: "stale_generation",
      spaceId: actual.spaceId,
      expectedActorGeneration: expected.actorGeneration,
      actualActorGeneration: actual.actorGeneration,
    };
  }
  return {
    status: "precondition_failed",
    spaceId: actual.spaceId,
    actorGeneration: actual.actorGeneration,
    reason,
  };
}

export async function ensureAndLockConversationState(
  transaction: DatabaseTransaction,
  spaceId: string,
): Promise<ConversationStateRecord> {
  const [space] = await transaction
    .select({ id: spaces.id })
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .for("key share")
    .limit(1);
  if (space === undefined) {
    throw new Error(
      "Conversation state cannot be initialized because its space does not exist. Persist the authorized space before retrying ingestion.",
    );
  }

  await transaction
    .insert(conversationStates)
    .values({ spaceId })
    .onConflictDoNothing({ target: conversationStates.spaceId });

  return lockConversationState(transaction, spaceId);
}

export async function lockConversationState(
  transaction: DatabaseTransaction,
  spaceId: string,
): Promise<ConversationStateRecord> {
  const [row] = await transaction
    .select(conversationStateSelection)
    .from(conversationStates)
    .where(eq(conversationStates.spaceId, spaceId))
    .for("update")
    .limit(1);
  if (row === undefined) {
    throw new Error(
      "Conversation state is missing. Initialize the conversation before applying actor transitions.",
    );
  }
  return conversationStateRecordSchema.parse(row);
}

export async function loadConversationState(
  database: Database,
  spaceId: string,
): Promise<ConversationStateRecord | null> {
  const [row] = await database
    .select(conversationStateSelection)
    .from(conversationStates)
    .where(eq(conversationStates.spaceId, spaceId))
    .limit(1);
  return row === undefined ? null : conversationStateRecordSchema.parse(row);
}

export class ConversationStateRepository {
  public constructor(private readonly database: Database) {}

  public async load(
    spaceId: string,
  ): Promise<ConversationStateRecord | null> {
    return loadConversationState(this.database, spaceId);
  }

  public async incrementActorGeneration(
    input: IncrementActorGenerationInput,
  ): Promise<ConversationStateMutationResult> {
    if (input.nextActiveInteractionRunId !== null) {
      throw new Error(
        "Actor generation invalidation must clear the active interaction pointer before recovery.",
      );
    }
    const expected = conversationCasPreconditionSchema.parse(
      input.expectedConversation,
    );
    return this.database.transaction(async (transaction) => {
      const actual = await lockConversationState(transaction, input.spaceId);
      if (!conversationMatches(actual, expected)) {
        return classifyConversationMiss(actual, expected);
      }

      const [updated] = await transaction
        .update(conversationStates)
        .set({
          actorGeneration: actual.actorGeneration + 1,
          activeInteractionRunId: input.nextActiveInteractionRunId,
          state: input.nextState,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(conversationStates.spaceId, input.spaceId),
            eq(conversationStates.actorGeneration, expected.actorGeneration),
            eq(conversationStates.state, expected.state),
          ),
        )
        .returning(conversationStateSelection);
      if (updated === undefined) {
        const reloaded = await lockConversationState(transaction, input.spaceId);
        return classifyConversationMiss(reloaded, expected);
      }
      return {
        status: "applied",
        state: conversationStateRecordSchema.parse(updated),
      };
    });
  }
}

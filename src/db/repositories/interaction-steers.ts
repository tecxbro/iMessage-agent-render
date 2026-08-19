import { and, asc, eq, or } from "drizzle-orm";

import type {
  CreateInteractionSteerInput,
  InteractionSteerCheckpoint,
} from "../../conversation/contracts.js";
import {
  conversationCasPreconditionSchema,
  interactionRunCasPreconditionSchema,
  interactionRunRecordSchema,
  interactionSteerCasPreconditionSchema,
  interactionSteerClaimResultSchema,
  interactionSteerMutationResultSchema,
  interactionSteerRecordSchema,
  type InteractionRunCasPrecondition,
  type InteractionRunRecord,
  type InteractionSteerCasPrecondition,
  type InteractionSteerClaimResult,
  type InteractionSteerMutationResult,
  type InteractionSteerRecord,
} from "../../conversation/state.js";
import type { Database, DatabaseTransaction } from "../client.js";
import {
  conversationStates,
  interactionRuns,
  interactionSteers,
} from "../schema-fragments/conversation-actors.js";
import { messages } from "../schema.js";
import {
  classifyConversationMiss,
  conversationMatches,
  lockConversationState,
} from "./conversation-state.js";
import { interactionRunSelection } from "./interaction-runs.js";

export const interactionSteerSelection = {
  id: interactionSteers.id,
  interactionRunId: interactionSteers.interactionRunId,
  spaceId: interactionSteers.spaceId,
  generation: interactionSteers.generation,
  state: interactionSteers.state,
  clientUserMessageId: interactionSteers.clientUserMessageId,
  fromSequence: interactionSteers.fromSequence,
  throughSequence: interactionSteers.throughSequence,
  expectedTurnId: interactionSteers.expectedTurnId,
  submissionGeneration: interactionSteers.submissionGeneration,
  submittedAt: interactionSteers.submittedAt,
  acceptedAt: interactionSteers.acceptedAt,
  updatedAt: interactionSteers.updatedAt,
};

export interface BeginSteerSubmissionInput {
  spaceId: string;
  expectedConversation: CreateInteractionSteerInput["expectedConversation"];
  expectedRun: InteractionRunCasPrecondition;
  expectedSteer: InteractionSteerCasPrecondition;
  submittedAt: Date;
}

export interface MarkSteerAcceptedInput {
  spaceId: string;
  expectedConversation: CreateInteractionSteerInput["expectedConversation"];
  expectedRun: InteractionRunCasPrecondition;
  expectedSteer: InteractionSteerCasPrecondition;
  acceptedAt: Date;
}

function runMatches(
  actual: InteractionRunRecord,
  expected: InteractionRunCasPrecondition,
): boolean {
  return (
    actual.id === expected.interactionRunId &&
    actual.generation === expected.generation &&
    actual.state === expected.state &&
    actual.threadId === expected.threadId &&
    actual.turnId === expected.turnId &&
    actual.acceptedThroughSequence === expected.acceptedThroughSequence
  );
}

function steerMatches(
  actual: InteractionSteerRecord,
  expected: InteractionSteerCasPrecondition,
): boolean {
  return (
    actual.id === expected.interactionSteerId &&
    actual.state === expected.state &&
    actual.expectedTurnId === expected.expectedTurnId &&
    actual.submissionGeneration === expected.submissionGeneration
  );
}

function preconditionFailure(
  spaceId: string,
  actorGeneration: number,
  reason: "run_precondition" | "steer_precondition",
): InteractionSteerMutationResult {
  return {
    status: "precondition_failed",
    spaceId,
    actorGeneration,
    reason,
  };
}

async function lockRun(
  transaction: DatabaseTransaction,
  interactionRunId: string,
): Promise<InteractionRunRecord | null> {
  const [row] = await transaction
    .select(interactionRunSelection)
    .from(interactionRuns)
    .where(eq(interactionRuns.id, interactionRunId))
    .for("update")
    .limit(1);
  return row === undefined ? null : interactionRunRecordSchema.parse(row);
}

async function lockSteer(
  transaction: DatabaseTransaction,
  interactionSteerId: string,
): Promise<InteractionSteerRecord | null> {
  const [row] = await transaction
    .select(interactionSteerSelection)
    .from(interactionSteers)
    .where(eq(interactionSteers.id, interactionSteerId))
    .for("update")
    .limit(1);
  return row === undefined ? null : interactionSteerRecordSchema.parse(row);
}

export class InteractionSteerRepository {
  public constructor(private readonly database: Database) {}

  public async createSteer(
    input: CreateInteractionSteerInput,
  ): Promise<InteractionSteerMutationResult> {
    const expectedConversation = conversationCasPreconditionSchema.parse(
      input.expectedConversation,
    );
    const expectedRun = interactionRunCasPreconditionSchema.parse(
      input.expectedRun,
    );
    return this.database.transaction(async (transaction) => {
      const conversation = await lockConversationState(
        transaction,
        input.spaceId,
      );
      if (!conversationMatches(conversation, expectedConversation)) {
        return classifyConversationMiss(conversation, expectedConversation);
      }
      const run = await lockRun(transaction, expectedRun.interactionRunId);
      if (
        run === null ||
        run.spaceId !== input.spaceId ||
        !runMatches(run, expectedRun)
      ) {
        return preconditionFailure(
          input.spaceId,
          conversation.actorGeneration,
          "run_precondition",
        );
      }
      if (
        expectedConversation.activeInteractionRunId !== run.id ||
        expectedConversation.actorGeneration !== run.generation ||
        expectedConversation.acceptedThroughSequence !==
          run.acceptedThroughSequence ||
        input.fromSequence !== run.acceptedThroughSequence + 1 ||
        input.throughSequence > conversation.latestInputSequence
      ) {
        return preconditionFailure(
          input.spaceId,
          conversation.actorGeneration,
          "run_precondition",
        );
      }

      const [clientMessage] = await transaction
        .select({ inputSequence: messages.inputSequence })
        .from(messages)
        .where(
          and(
            eq(messages.id, input.clientUserMessageId),
            eq(messages.spaceId, input.spaceId),
            eq(messages.direction, "inbound"),
          ),
        )
        .limit(1);
      if (
        clientMessage?.inputSequence === null ||
        clientMessage?.inputSequence === undefined ||
        clientMessage.inputSequence < input.fromSequence ||
        clientMessage.inputSequence > input.throughSequence
      ) {
        return preconditionFailure(
          input.spaceId,
          conversation.actorGeneration,
          "steer_precondition",
        );
      }

      const [existing] = await transaction
        .select(interactionSteerSelection)
        .from(interactionSteers)
        .where(
          and(
            eq(interactionSteers.interactionRunId, run.id),
            or(
              eq(
                interactionSteers.clientUserMessageId,
                input.clientUserMessageId,
              ),
              and(
                eq(interactionSteers.fromSequence, input.fromSequence),
                eq(interactionSteers.throughSequence, input.throughSequence),
              ),
            ),
          ),
        )
        .for("update")
        .limit(1);
      if (existing !== undefined) {
        const parsed = interactionSteerRecordSchema.parse(existing);
        if (
          parsed.id === input.id &&
          parsed.clientUserMessageId === input.clientUserMessageId &&
          parsed.fromSequence === input.fromSequence &&
          parsed.throughSequence === input.throughSequence &&
          parsed.expectedTurnId === input.expectedTurnId &&
          parsed.submissionGeneration === input.submissionGeneration
        ) {
          return interactionSteerMutationResultSchema.parse({
            status: "applied",
            steer: parsed,
          });
        }
        return preconditionFailure(
          input.spaceId,
          conversation.actorGeneration,
          "steer_precondition",
        );
      }

      const [inserted] = await transaction
        .insert(interactionSteers)
        .values({
          id: input.id,
          interactionRunId: run.id,
          spaceId: input.spaceId,
          generation: run.generation,
          state: "pending",
          clientUserMessageId: input.clientUserMessageId,
          fromSequence: input.fromSequence,
          throughSequence: input.throughSequence,
          expectedTurnId: input.expectedTurnId,
          submissionGeneration: input.submissionGeneration,
        })
        .returning(interactionSteerSelection);
      if (inserted === undefined) {
        throw new Error(
          "Interaction steer insertion returned no row. Inspect steer identity and range constraints before retrying.",
        );
      }
      return interactionSteerMutationResultSchema.parse({
        status: "applied",
        steer: inserted,
      });
    });
  }

  public async claimPendingSteer(input: {
    spaceId: string;
    expectedConversation: CreateInteractionSteerInput["expectedConversation"];
    expectedRun: InteractionRunCasPrecondition;
  }): Promise<InteractionSteerClaimResult> {
    const expectedConversation = conversationCasPreconditionSchema.parse(
      input.expectedConversation,
    );
    const expectedRun = interactionRunCasPreconditionSchema.parse(
      input.expectedRun,
    );
    return this.database.transaction(async (transaction) => {
      const conversation = await lockConversationState(
        transaction,
        input.spaceId,
      );
      if (!conversationMatches(conversation, expectedConversation)) {
        return interactionSteerClaimResultSchema.parse(
          classifyConversationMiss(conversation, expectedConversation),
        );
      }
      const run = await lockRun(transaction, expectedRun.interactionRunId);
      if (
        run === null ||
        run.spaceId !== input.spaceId ||
        !runMatches(run, expectedRun) ||
        conversation.activeInteractionRunId !== run.id ||
        conversation.actorGeneration !== run.generation
      ) {
        return interactionSteerClaimResultSchema.parse(
          preconditionFailure(
            input.spaceId,
            conversation.actorGeneration,
            "run_precondition",
          ),
        );
      }

      const [pending] = await transaction
        .select(interactionSteerSelection)
        .from(interactionSteers)
        .where(
          and(
            eq(interactionSteers.spaceId, input.spaceId),
            eq(interactionSteers.interactionRunId, run.id),
            eq(interactionSteers.generation, run.generation),
            eq(interactionSteers.state, "pending"),
          ),
        )
        .orderBy(
          asc(interactionSteers.fromSequence),
          asc(interactionSteers.id),
        )
        .for("update")
        .limit(1);
      if (pending === undefined) {
        return { status: "none" };
      }

      const [updated] = await transaction
        .update(interactionSteers)
        .set({ state: "submitting", submittedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(interactionSteers.id, pending.id),
            eq(interactionSteers.state, "pending"),
          ),
        )
        .returning(interactionSteerSelection);
      if (updated === undefined) {
        throw new Error(
          "Pending steer claim lost its locked row. Reload uncertain steers before retrying.",
        );
      }
      return interactionSteerClaimResultSchema.parse({
        status: "claimed",
        steer: updated,
      });
    });
  }

  public async checkpointSteer(
    input: InteractionSteerCheckpoint,
  ): Promise<InteractionSteerMutationResult> {
    const expectedConversation = conversationCasPreconditionSchema.parse(
      input.expectedConversation,
    );
    const expectedRun = interactionRunCasPreconditionSchema.parse(
      input.expectedRun,
    );
    const expectedSteer = interactionSteerCasPreconditionSchema.parse(
      input.expectedSteer,
    );
    return this.database.transaction(async (transaction) => {
      const conversation = await lockConversationState(
        transaction,
        input.spaceId,
      );
      if (!conversationMatches(conversation, expectedConversation)) {
        return classifyConversationMiss(conversation, expectedConversation);
      }
      const run = await lockRun(transaction, expectedRun.interactionRunId);
      if (
        run === null ||
        run.spaceId !== input.spaceId ||
        !runMatches(run, expectedRun)
      ) {
        return preconditionFailure(
          input.spaceId,
          conversation.actorGeneration,
          "run_precondition",
        );
      }
      const steer = await lockSteer(
        transaction,
        expectedSteer.interactionSteerId,
      );
      if (
        steer === null ||
        steer.spaceId !== input.spaceId ||
        steer.interactionRunId !== run.id ||
        steer.generation !== run.generation ||
        !steerMatches(steer, expectedSteer)
      ) {
        return preconditionFailure(
          input.spaceId,
          conversation.actorGeneration,
          "steer_precondition",
        );
      }

      const transitionAllowed =
        (steer.state === "pending" &&
          (input.nextState === "submitting" ||
            input.nextState === "superseded" ||
            input.nextState === "failed")) ||
        (steer.state === "submitting" &&
          (input.nextState === "accepted" ||
            input.nextState === "superseded" ||
            input.nextState === "failed"));
      if (!transitionAllowed) {
        return preconditionFailure(
          input.spaceId,
          conversation.actorGeneration,
          "steer_precondition",
        );
      }
      if (
        (input.nextState === "submitting" || input.nextState === "accepted") &&
        (conversation.activeInteractionRunId !== run.id ||
          conversation.actorGeneration !== run.generation ||
          conversation.acceptedThroughSequence !==
            run.acceptedThroughSequence)
      ) {
        return preconditionFailure(
          input.spaceId,
          conversation.actorGeneration,
          "run_precondition",
        );
      }

      let acceptedThroughSequence = run.acceptedThroughSequence;
      if (input.nextState === "accepted") {
        if (
          steer.state !== "submitting" ||
          conversation.activeInteractionRunId !== run.id ||
          conversation.actorGeneration !== run.generation ||
          conversation.acceptedThroughSequence !== run.acceptedThroughSequence ||
          steer.fromSequence !== run.acceptedThroughSequence + 1 ||
          steer.throughSequence > conversation.latestInputSequence
        ) {
          return preconditionFailure(
            input.spaceId,
            conversation.actorGeneration,
            "steer_precondition",
          );
        }
        acceptedThroughSequence = steer.throughSequence;
      }

      const now = new Date();
      const candidate = interactionSteerRecordSchema.parse({
        ...steer,
        state: input.nextState,
        submittedAt:
          input.submittedAt === undefined
            ? steer.submittedAt
            : input.submittedAt,
        acceptedAt:
          input.acceptedAt === undefined ? steer.acceptedAt : input.acceptedAt,
        updatedAt: now,
      });
      if (
        ((candidate.state === "submitting" || candidate.state === "accepted") &&
          candidate.submittedAt === null) ||
        (candidate.state === "accepted" && candidate.acceptedAt === null)
      ) {
        return preconditionFailure(
          input.spaceId,
          conversation.actorGeneration,
          "steer_precondition",
        );
      }
      const [updatedSteer] = await transaction
        .update(interactionSteers)
        .set({
          state: candidate.state,
          submittedAt: candidate.submittedAt,
          acceptedAt: candidate.acceptedAt,
          updatedAt: now,
        })
        .where(eq(interactionSteers.id, steer.id))
        .returning(interactionSteerSelection);
      if (updatedSteer === undefined) {
        throw new Error(
          "Interaction steer checkpoint lost its locked row. Reload the actor snapshot before retrying.",
        );
      }

      if (acceptedThroughSequence !== run.acceptedThroughSequence) {
        await transaction
          .update(interactionRuns)
          .set({ acceptedThroughSequence, updatedAt: now })
          .where(eq(interactionRuns.id, run.id));
        await transaction
          .update(conversationStates)
          .set({ acceptedThroughSequence, updatedAt: now })
          .where(eq(conversationStates.spaceId, input.spaceId));
      }

      return interactionSteerMutationResultSchema.parse({
        status: "applied",
        steer: updatedSteer,
      });
    });
  }

  public async beginSteerSubmission(
    input: BeginSteerSubmissionInput,
  ): Promise<InteractionSteerMutationResult> {
    return this.checkpointSteer({
      spaceId: input.spaceId,
      expectedConversation: input.expectedConversation,
      expectedRun: input.expectedRun,
      expectedSteer: input.expectedSteer,
      nextState: "submitting",
      submittedAt: input.submittedAt,
    });
  }

  public async markSteerAccepted(
    input: MarkSteerAcceptedInput,
  ): Promise<InteractionSteerMutationResult> {
    return this.checkpointSteer({
      spaceId: input.spaceId,
      expectedConversation: input.expectedConversation,
      expectedRun: input.expectedRun,
      expectedSteer: input.expectedSteer,
      nextState: "accepted",
      acceptedAt: input.acceptedAt,
    });
  }
}

import { and, eq, inArray } from "drizzle-orm";

import type {
  BeginInteractionInput,
  InteractionRunCheckpoint,
  RecoverInteractionInput,
} from "../../conversation/contracts.js";
import {
  beginInteractionConversationPreconditionSchema,
  conversationCasPreconditionSchema,
  conversationStateRecordSchema,
  interactionRunCasPreconditionSchema,
  interactionRunMutationResultSchema,
  interactionRunRecordSchema,
  type ConversationActorState,
  type ConversationCasPrecondition,
  type InteractionRunCasPrecondition,
  type InteractionRunMutationResult,
  type InteractionRunNonterminalState,
  type InteractionRunRecord,
} from "../../conversation/state.js";
import type { JsonValue } from "../../security/action-schema.js";
import type { Database, DatabaseTransaction } from "../client.js";
import {
  conversationStates,
  interactionRuns,
} from "../schema-fragments/conversation-actors.js";
import {
  captureInteractionAuthorization,
} from "./interaction-authorization.js";
import {
  ConversationStateRepository,
  classifyConversationMiss,
  conversationMatches,
  conversationStateSelection,
  lockConversationState,
  type IncrementActorGenerationInput,
  type ConversationStateMutationResult,
} from "./conversation-state.js";

export const interactionRunSelection = {
  id: interactionRuns.id,
  spaceId: interactionRuns.spaceId,
  generation: interactionRuns.generation,
  state: interactionRuns.state,
  threadId: interactionRuns.threadId,
  turnId: interactionRuns.turnId,
  startedThroughSequence: interactionRuns.startedThroughSequence,
  acceptedThroughSequence: interactionRuns.acceptedThroughSequence,
  modelId: interactionRuns.modelId,
  reasoningEffort: interactionRuns.reasoningEffort,
  promptVersion: interactionRuns.promptVersion,
  promptSha256: interactionRuns.promptSha256,
  decisionMetadataJson: interactionRuns.decisionMetadataJson,
  draftOutputCiphertext: interactionRuns.draftOutputCiphertext,
  terminalReason: interactionRuns.terminalReason,
  lastObservedEventJson: interactionRuns.lastObservedEventJson,
  startedAt: interactionRuns.startedAt,
  completedAt: interactionRuns.completedAt,
  updatedAt: interactionRuns.updatedAt,
};

export interface RunTransitionInput {
  spaceId: string;
  expectedConversation: ConversationCasPrecondition;
  expectedRun: InteractionRunCasPrecondition;
}

export interface MarkRunActiveInput extends RunTransitionInput {
  threadId?: string;
  turnId?: string;
}

export interface RecordTurnIdentityInput extends RunTransitionInput {
  threadId: string;
  turnId: string;
}

export interface StoreTerminalDecisionInput extends RunTransitionInput {
  decisionMetadataJson: Readonly<Record<string, JsonValue>>;
  lastObservedEventJson: JsonValue | null;
}

export interface StoreUndeliveredDraftInput extends RunTransitionInput {
  draftOutputCiphertext: string;
}

export interface FinalizeRunInput extends RunTransitionInput {
  completedAt: Date;
}

function hasOwn<Key extends PropertyKey>(
  value: object,
  key: Key,
): value is Record<Key, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
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

async function lockInteractionRun(
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

function runPreconditionFailure(
  spaceId: string,
  actorGeneration: number,
): InteractionRunMutationResult {
  return {
    status: "precondition_failed",
    spaceId,
    actorGeneration,
    reason: "run_precondition",
  };
}

export class InteractionRunRepository {
  private readonly states: ConversationStateRepository;

  public constructor(private readonly database: Database) {
    this.states = new ConversationStateRepository(database);
  }

  public async loadInteractionRun(
    interactionRunId: string,
  ): Promise<InteractionRunRecord | null> {
    const [row] = await this.database
      .select(interactionRunSelection)
      .from(interactionRuns)
      .where(eq(interactionRuns.id, interactionRunId))
      .limit(1);
    return row === undefined ? null : interactionRunRecordSchema.parse(row);
  }

  public async createStartingRun(
    input: BeginInteractionInput,
  ): Promise<InteractionRunMutationResult> {
    const expected = beginInteractionConversationPreconditionSchema.parse(
      input.expectedConversation,
    );
    return this.database.transaction(async (transaction) => {
      const actual = await lockConversationState(transaction, input.spaceId);
      if (!conversationMatches(actual, expected)) {
        return classifyConversationMiss(actual, expected);
      }

      const [existingNonterminal] = await transaction
        .select({ id: interactionRuns.id })
        .from(interactionRuns)
        .where(
          and(
            eq(interactionRuns.spaceId, input.spaceId),
            inArray(interactionRuns.state, [
              "starting",
              "active",
              "finalizing",
            ]),
          ),
        )
        .for("update")
        .limit(1);
      if (existingNonterminal !== undefined) {
        return runPreconditionFailure(input.spaceId, actual.actorGeneration);
      }

      const now = new Date();
      const generation = actual.actorGeneration + 1;
      const [inserted] = await transaction
        .insert(interactionRuns)
        .values({
          id: input.interactionRunId,
          spaceId: input.spaceId,
          generation,
          state: "starting",
          startedThroughSequence: actual.latestInputSequence,
          acceptedThroughSequence: actual.latestInputSequence,
          modelId: input.modelId,
          reasoningEffort: input.reasoningEffort,
          promptVersion: input.promptVersion,
          promptSha256: input.promptSha256,
          startedAt: now,
          updatedAt: now,
        })
        .returning(interactionRunSelection);
      if (inserted === undefined) {
        throw new Error(
          "Starting interaction run insertion returned no row. Inspect run identity and generation constraints before retrying.",
        );
      }

      await captureInteractionAuthorization(transaction, {
        interactionRunId: input.interactionRunId,
        spaceId: input.spaceId,
        authorization: input.authorization,
      });

      const [advanced] = await transaction
        .update(conversationStates)
        .set({
          actorGeneration: generation,
          activeInteractionRunId: input.interactionRunId,
          state: "starting",
          acceptedThroughSequence: actual.latestInputSequence,
          updatedAt: now,
        })
        .where(
          and(
            eq(conversationStates.spaceId, input.spaceId),
            eq(conversationStates.actorGeneration, actual.actorGeneration),
            eq(conversationStates.state, actual.state),
          ),
        )
        .returning(conversationStateSelection);
      if (advanced === undefined) {
        throw new Error(
          "Starting interaction run lost its locked conversation state. The transaction was rolled back; reload before retrying.",
        );
      }

      conversationStateRecordSchema.parse(advanced);
      return interactionRunMutationResultSchema.parse({
        status: "applied",
        run: inserted,
      });
    });
  }

  public async beginInteraction(
    input: BeginInteractionInput,
  ): Promise<InteractionRunMutationResult> {
    return this.createStartingRun(input);
  }

  private async applyCheckpoint(
    input: InteractionRunCheckpoint,
    requiredState?: {
      runState: InteractionRunNonterminalState;
      conversationState: ConversationActorState;
    },
  ): Promise<InteractionRunMutationResult> {
    const expectedConversation = conversationCasPreconditionSchema.parse(
      input.expectedConversation,
    );
    const expectedRun = interactionRunCasPreconditionSchema.parse(
      input.expectedRun,
    );
    return this.database.transaction(async (transaction) => {
      const actualConversation = await lockConversationState(
        transaction,
        input.spaceId,
      );
      if (!conversationMatches(actualConversation, expectedConversation)) {
        return classifyConversationMiss(
          actualConversation,
          expectedConversation,
        );
      }

      const actualRun = await lockInteractionRun(
        transaction,
        expectedRun.interactionRunId,
      );
      if (
        actualRun === null ||
        actualRun.spaceId !== input.spaceId ||
        !runMatches(actualRun, expectedRun)
      ) {
        return runPreconditionFailure(
          input.spaceId,
          actualConversation.actorGeneration,
        );
      }
      if (
        actualConversation.activeInteractionRunId !== actualRun.id ||
        actualConversation.actorGeneration !== actualRun.generation
      ) {
        return runPreconditionFailure(
          input.spaceId,
          actualConversation.actorGeneration,
        );
      }
      if (
        requiredState !== undefined &&
        (actualRun.state !== requiredState.runState ||
          actualConversation.state !== requiredState.conversationState)
      ) {
        return runPreconditionFailure(
          input.spaceId,
          actualConversation.actorGeneration,
        );
      }

      const now = new Date();
      const candidateRun = interactionRunRecordSchema.parse({
        ...actualRun,
        state: input.nextRunState,
        threadId: hasOwn(input, "threadId") ? input.threadId : actualRun.threadId,
        turnId: hasOwn(input, "turnId") ? input.turnId : actualRun.turnId,
        decisionMetadataJson: hasOwn(input, "decisionMetadataJson")
          ? input.decisionMetadataJson
          : actualRun.decisionMetadataJson,
        draftOutputCiphertext: hasOwn(input, "draftOutputCiphertext")
          ? input.draftOutputCiphertext
          : actualRun.draftOutputCiphertext,
        terminalReason: hasOwn(input, "terminalReason")
          ? input.terminalReason
          : actualRun.terminalReason,
        lastObservedEventJson: hasOwn(input, "lastObservedEventJson")
          ? input.lastObservedEventJson
          : actualRun.lastObservedEventJson,
        completedAt: hasOwn(input, "completedAt")
          ? input.completedAt
          : actualRun.completedAt,
        updatedAt: now,
      });
      const candidateConversation = conversationStateRecordSchema.parse({
        ...actualConversation,
        state: input.nextConversation.state,
        activeInteractionRunId:
          input.nextConversation.activeInteractionRunId,
        acceptedThroughSequence:
          input.nextConversation.acceptedThroughSequence,
        finalizedThroughSequence:
          input.nextConversation.finalizedThroughSequence,
        updatedAt: now,
      });
      if (
        candidateConversation.acceptedThroughSequence <
          actualConversation.acceptedThroughSequence ||
        candidateConversation.finalizedThroughSequence <
          actualConversation.finalizedThroughSequence
      ) {
        return runPreconditionFailure(
          input.spaceId,
          actualConversation.actorGeneration,
        );
      }
      const transitionAllowed =
        (candidateRun.state === "active" &&
          (actualRun.state === "starting" ||
            actualRun.state === "active" ||
            actualRun.state === "finalizing")) ||
        (candidateRun.state === "finalizing" &&
          (actualRun.state === "active" || actualRun.state === "finalizing")) ||
        (candidateRun.state === "completed" &&
          actualRun.state === "finalizing") ||
        candidateRun.state === "failed" ||
        candidateRun.state === "canceled" ||
        candidateRun.state === "interrupted";
      if (!transitionAllowed) {
        return runPreconditionFailure(
          input.spaceId,
          actualConversation.actorGeneration,
        );
      }
      if (
        (candidateRun.state === "active" ||
          candidateRun.state === "finalizing") &&
        (candidateConversation.state !== candidateRun.state ||
          candidateConversation.activeInteractionRunId !== candidateRun.id ||
          candidateConversation.acceptedThroughSequence !==
            candidateRun.acceptedThroughSequence)
      ) {
        return runPreconditionFailure(
          input.spaceId,
          actualConversation.actorGeneration,
        );
      }
      if (
        candidateRun.state === "completed" &&
        (actualRun.state !== "finalizing" ||
          candidateConversation.state !== "idle" ||
          candidateConversation.activeInteractionRunId !== null ||
          candidateConversation.finalizedThroughSequence !==
            candidateRun.acceptedThroughSequence)
      ) {
        return runPreconditionFailure(
          input.spaceId,
          actualConversation.actorGeneration,
        );
      }
      if (
        candidateRun.state === "interrupted" &&
        (candidateConversation.state !== "recovering" ||
          candidateConversation.activeInteractionRunId !== null)
      ) {
        return runPreconditionFailure(
          input.spaceId,
          actualConversation.actorGeneration,
        );
      }

      const [updatedRun] = await transaction
        .update(interactionRuns)
        .set({
          state: candidateRun.state,
          threadId: candidateRun.threadId,
          turnId: candidateRun.turnId,
          acceptedThroughSequence: candidateRun.acceptedThroughSequence,
          decisionMetadataJson: candidateRun.decisionMetadataJson ?? {},
          draftOutputCiphertext: candidateRun.draftOutputCiphertext,
          terminalReason: candidateRun.terminalReason,
          lastObservedEventJson: candidateRun.lastObservedEventJson,
          completedAt: candidateRun.completedAt,
          updatedAt: now,
        })
        .where(eq(interactionRuns.id, actualRun.id))
        .returning(interactionRunSelection);
      if (updatedRun === undefined) {
        throw new Error(
          "Interaction run checkpoint lost its locked row. Reload the actor snapshot before retrying.",
        );
      }

      const [updatedConversation] = await transaction
        .update(conversationStates)
        .set({
          state: candidateConversation.state,
          activeInteractionRunId:
            candidateConversation.activeInteractionRunId,
          acceptedThroughSequence:
            candidateConversation.acceptedThroughSequence,
          finalizedThroughSequence:
            candidateConversation.finalizedThroughSequence,
          updatedAt: now,
        })
        .where(eq(conversationStates.spaceId, input.spaceId))
        .returning(conversationStateSelection);
      if (updatedConversation === undefined) {
        throw new Error(
          "Interaction checkpoint lost its locked conversation row. The transaction was rolled back.",
        );
      }
      conversationStateRecordSchema.parse(updatedConversation);
      return interactionRunMutationResultSchema.parse({
        status: "applied",
        run: updatedRun,
      });
    });
  }

  public async checkpointInteraction(
    input: InteractionRunCheckpoint,
  ): Promise<InteractionRunMutationResult> {
    return this.applyCheckpoint(input);
  }

  public async markRunActive(
    input: MarkRunActiveInput,
  ): Promise<InteractionRunMutationResult> {
    return this.applyCheckpoint({
      ...input,
      nextRunState: "active",
      nextConversation: {
        state: "active",
        activeInteractionRunId: input.expectedRun.interactionRunId,
        acceptedThroughSequence:
          input.expectedConversation.acceptedThroughSequence,
        finalizedThroughSequence:
          input.expectedConversation.finalizedThroughSequence,
      },
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    }, { runState: "starting", conversationState: "starting" });
  }

  public async recordTurnIdentity(
    input: RecordTurnIdentityInput,
  ): Promise<InteractionRunMutationResult> {
    return this.applyCheckpoint({
      ...input,
      nextRunState: input.expectedRun.state,
      nextConversation: {
        state: input.expectedConversation.state,
        activeInteractionRunId:
          input.expectedConversation.activeInteractionRunId,
        acceptedThroughSequence:
          input.expectedConversation.acceptedThroughSequence,
        finalizedThroughSequence:
          input.expectedConversation.finalizedThroughSequence,
      },
      threadId: input.threadId,
      turnId: input.turnId,
    }, { runState: "active", conversationState: "active" });
  }

  public async storeTerminalDecision(
    input: StoreTerminalDecisionInput,
  ): Promise<InteractionRunMutationResult> {
    return this.applyCheckpoint({
      ...input,
      nextRunState: "finalizing",
      nextConversation: {
        state: "finalizing",
        activeInteractionRunId: input.expectedRun.interactionRunId,
        acceptedThroughSequence:
          input.expectedConversation.acceptedThroughSequence,
        finalizedThroughSequence:
          input.expectedConversation.finalizedThroughSequence,
      },
      decisionMetadataJson: input.decisionMetadataJson,
      lastObservedEventJson: input.lastObservedEventJson,
    }, { runState: "active", conversationState: "active" });
  }

  public async storeUndeliveredDraft(
    input: StoreUndeliveredDraftInput,
  ): Promise<InteractionRunMutationResult> {
    return this.applyCheckpoint({
      ...input,
      nextRunState: input.expectedRun.state,
      nextConversation: {
        state: input.expectedConversation.state,
        activeInteractionRunId:
          input.expectedConversation.activeInteractionRunId,
        acceptedThroughSequence:
          input.expectedConversation.acceptedThroughSequence,
        finalizedThroughSequence:
          input.expectedConversation.finalizedThroughSequence,
      },
      draftOutputCiphertext: input.draftOutputCiphertext,
    }, { runState: "finalizing", conversationState: "finalizing" });
  }

  public async finalizeRun(
    input: FinalizeRunInput,
  ): Promise<InteractionRunMutationResult> {
    return this.applyCheckpoint({
      ...input,
      nextRunState: "completed",
      nextConversation: {
        state: "idle",
        activeInteractionRunId: null,
        acceptedThroughSequence: input.expectedRun.acceptedThroughSequence,
        finalizedThroughSequence: input.expectedRun.acceptedThroughSequence,
      },
      terminalReason: null,
      completedAt: input.completedAt,
    }, { runState: "finalizing", conversationState: "finalizing" });
  }

  public async markRunInterrupted(
    input: Omit<RecoverInteractionInput, "terminalState">,
  ): Promise<InteractionRunMutationResult> {
    return this.checkpointInteraction({
      spaceId: input.spaceId,
      expectedConversation: input.expectedConversation,
      expectedRun: input.expectedRun,
      nextRunState: "interrupted",
      nextConversation: {
        state: "recovering",
        activeInteractionRunId: null,
        acceptedThroughSequence:
          input.expectedConversation.acceptedThroughSequence,
        finalizedThroughSequence:
          input.expectedConversation.finalizedThroughSequence,
      },
      terminalReason: input.terminalReason,
      completedAt: input.recoveredAt,
    });
  }

  public async markRunOrphaned(
    input: Omit<RecoverInteractionInput, "terminalState">,
  ): Promise<InteractionRunMutationResult> {
    const expectedConversation = conversationCasPreconditionSchema.parse(
      input.expectedConversation,
    );
    const expectedRun = interactionRunCasPreconditionSchema.parse(
      input.expectedRun,
    );
    return this.database.transaction(async (transaction) => {
      const actualConversation = await lockConversationState(
        transaction,
        input.spaceId,
      );
      if (!conversationMatches(actualConversation, expectedConversation)) {
        return classifyConversationMiss(
          actualConversation,
          expectedConversation,
        );
      }
      const actualRun = await lockInteractionRun(
        transaction,
        expectedRun.interactionRunId,
      );
      if (
        actualRun === null ||
        actualRun.spaceId !== input.spaceId ||
        !runMatches(actualRun, expectedRun) ||
        (actualConversation.activeInteractionRunId === actualRun.id &&
          actualConversation.actorGeneration === actualRun.generation)
      ) {
        return runPreconditionFailure(
          input.spaceId,
          actualConversation.actorGeneration,
        );
      }
      const candidate = interactionRunRecordSchema.parse({
        ...actualRun,
        state: "orphaned",
        terminalReason: input.terminalReason,
        completedAt: input.recoveredAt,
        updatedAt: input.recoveredAt,
      });
      const clearsDanglingPointer =
        actualConversation.activeInteractionRunId === actualRun.id;
      const [updated] = await transaction
        .update(interactionRuns)
        .set({
          state: "orphaned",
          terminalReason: candidate.terminalReason,
          completedAt: candidate.completedAt,
          updatedAt: candidate.updatedAt,
        })
        .where(eq(interactionRuns.id, actualRun.id))
        .returning(interactionRunSelection);
      if (updated === undefined) {
        throw new Error(
          "Orphaned interaction recovery lost its locked run. Reload active runs before retrying.",
        );
      }
      if (clearsDanglingPointer) {
        const [recoveredConversation] = await transaction
          .update(conversationStates)
          .set({
            state: "recovering",
            activeInteractionRunId: null,
            updatedAt: input.recoveredAt,
          })
          .where(eq(conversationStates.spaceId, input.spaceId))
          .returning(conversationStateSelection);
        if (recoveredConversation === undefined) {
          throw new Error(
            "Orphan recovery lost the dangling conversation pointer. The transaction was rolled back.",
          );
        }
        conversationStateRecordSchema.parse(recoveredConversation);
      }
      return interactionRunMutationResultSchema.parse({
        status: "applied",
        run: updated,
      });
    });
  }

  public async recoverInteraction(
    input: RecoverInteractionInput,
  ): Promise<InteractionRunMutationResult> {
    const recoveryInput = {
      spaceId: input.spaceId,
      expectedConversation: input.expectedConversation,
      expectedRun: input.expectedRun,
      terminalReason: input.terminalReason,
      recoveredAt: input.recoveredAt,
    };
    return input.terminalState === "interrupted"
      ? this.markRunInterrupted(recoveryInput)
      : this.markRunOrphaned(recoveryInput);
  }

  public async incrementActorGeneration(
    input: IncrementActorGenerationInput,
  ): Promise<ConversationStateMutationResult> {
    return this.states.incrementActorGeneration(input);
  }
}

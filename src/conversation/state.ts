import { z } from "zod";

import { jsonValueSchema } from "../security/action-schema.js";

export const CONVERSATION_ACTOR_STATES = [
  "idle",
  "starting",
  "active",
  "finalizing",
  "recovering",
] as const;

export const BEGIN_INTERACTION_CONVERSATION_STATES = [
  "idle",
  "recovering",
] as const;

export const INTERACTION_RUN_STATES = [
  "starting",
  "active",
  "finalizing",
  "completed",
  "failed",
  "canceled",
  "interrupted",
  "orphaned",
] as const;

export const INTERACTION_RUN_NONTERMINAL_STATES = [
  "starting",
  "active",
  "finalizing",
] as const;

export const INTERACTION_RUN_TERMINAL_STATES = [
  "completed",
  "failed",
  "canceled",
  "interrupted",
  "orphaned",
] as const;

/**
 * `interrupted` means the active coordinator deliberately stopped or lost its
 * runtime before completion. `orphaned` means reconciliation found a
 * nonterminal run that is no longer the active run for its space/generation.
 * Both are terminal records and must never be resumed in place.
 */
export const INTERACTION_RUN_RECOVERY_STATES = [
  "interrupted",
  "orphaned",
] as const;

export const INTERACTION_STEER_STATES = [
  "pending",
  "submitting",
  "accepted",
  "superseded",
  "failed",
] as const;

export const conversationActorStateSchema = z.enum(
  CONVERSATION_ACTOR_STATES,
);
export const beginInteractionConversationStateSchema = z.enum(
  BEGIN_INTERACTION_CONVERSATION_STATES,
);
export const interactionRunStateSchema = z.enum(INTERACTION_RUN_STATES);
export const interactionRunNonterminalStateSchema = z.enum(
  INTERACTION_RUN_NONTERMINAL_STATES,
);
export const interactionRunTerminalStateSchema = z.enum(
  INTERACTION_RUN_TERMINAL_STATES,
);
export const interactionRunRecoveryStateSchema = z.enum(
  INTERACTION_RUN_RECOVERY_STATES,
);
export const interactionSteerStateSchema = z.enum(INTERACTION_STEER_STATES);

const identifierSchema = z.uuid();
const sequenceSchema = z.number().int().nonnegative();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const metadataSchema = z.record(z.string(), jsonValueSchema);
const USER_VISIBLE_OUTPUT_KEYS = new Set([
  "answer",
  "draft",
  "draftoutput",
  "outputtext",
  "response",
  "responsetext",
  "text",
  "uservisibleanswer",
  "uservisibleoutput",
]);
const exceptionalTerminalRunStates = new Set<InteractionRunState>([
  "failed",
  "canceled",
  "interrupted",
  "orphaned",
]);
const terminalRunStates = new Set<InteractionRunState>(
  INTERACTION_RUN_TERMINAL_STATES,
);

export const interactionDecisionMetadataSchema = metadataSchema.superRefine(
  (metadata, context) => {
    for (const key of Object.keys(metadata)) {
      const normalizedKey = key.replaceAll(/[_-]/gu, "").toLowerCase();
      if (USER_VISIBLE_OUTPUT_KEYS.has(normalizedKey)) {
        context.addIssue({
          code: "custom",
          path: [key],
          message:
            "user-visible output must be stored only as encrypted draft output",
        });
      }
    }
  },
);

export const conversationStateRecordSchema = z
  .object({
    spaceId: identifierSchema,
    latestInputSequence: sequenceSchema,
    acceptedThroughSequence: sequenceSchema,
    finalizedThroughSequence: sequenceSchema,
    actorGeneration: sequenceSchema,
    activeInteractionRunId: identifierSchema.nullable(),
    state: conversationActorStateSchema,
    updatedAt: z.date(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.finalizedThroughSequence > record.acceptedThroughSequence) {
      context.addIssue({
        code: "custom",
        path: ["finalizedThroughSequence"],
        message: "finalizedThroughSequence must not exceed acceptedThroughSequence",
      });
    }
    if (record.acceptedThroughSequence > record.latestInputSequence) {
      context.addIssue({
        code: "custom",
        path: ["acceptedThroughSequence"],
        message: "acceptedThroughSequence must not exceed latestInputSequence",
      });
    }
  });

export const interactionRunRecordSchema = z
  .object({
    id: identifierSchema,
    spaceId: identifierSchema,
    generation: sequenceSchema,
    state: interactionRunStateSchema,
    threadId: z.string().min(1).nullable(),
    turnId: z.string().min(1).nullable(),
    startedThroughSequence: sequenceSchema,
    acceptedThroughSequence: sequenceSchema,
    modelId: z.string().trim().min(1).max(128),
    reasoningEffort: z.string().trim().min(1).max(32),
    promptVersion: z.string().trim().min(1).max(128),
    promptSha256: sha256Schema,
    decisionMetadataJson: interactionDecisionMetadataSchema.nullable(),
    draftOutputCiphertext: z.string().min(1).nullable(),
    terminalReason: z.string().trim().min(1).max(128).nullable(),
    lastObservedEventJson: jsonValueSchema.nullable(),
    startedAt: z.date(),
    completedAt: z.date().nullable(),
    updatedAt: z.date(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.startedThroughSequence > record.acceptedThroughSequence) {
      context.addIssue({
        code: "custom",
        path: ["acceptedThroughSequence"],
        message: "acceptedThroughSequence must include startedThroughSequence",
      });
    }
    const terminal = terminalRunStates.has(record.state);
    if (terminal !== (record.completedAt !== null)) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: terminal
          ? "terminal interaction runs require completedAt"
          : "nonterminal interaction runs must not have completedAt",
      });
    }
    if (
      exceptionalTerminalRunStates.has(record.state) &&
      record.terminalReason === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["terminalReason"],
        message: `${record.state} interaction runs require a terminalReason`,
      });
    }
  });

export const interactionSteerRecordSchema = z
  .object({
    id: identifierSchema,
    interactionRunId: identifierSchema,
    spaceId: identifierSchema,
    generation: sequenceSchema,
    state: interactionSteerStateSchema,
    clientUserMessageId: identifierSchema,
    fromSequence: sequenceSchema,
    throughSequence: sequenceSchema,
    expectedTurnId: z.string().min(1).nullable(),
    submissionGeneration: sequenceSchema,
    submittedAt: z.date().nullable(),
    acceptedAt: z.date().nullable(),
    updatedAt: z.date(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.fromSequence > record.throughSequence) {
      context.addIssue({
        code: "custom",
        path: ["fromSequence"],
        message: "fromSequence must not exceed throughSequence",
      });
    }
  });

export const interactionAuthorizationReferenceSchema = z
  .object({
    interactionRunId: identifierSchema,
    deploymentId: identifierSchema,
    ownerId: identifierSchema,
    identityId: identifierSchema,
    authorizationRevision: sequenceSchema,
    createdAt: z.date(),
  })
  .strict();

export const conversationCasPreconditionSchema = z
  .object({
    actorGeneration: sequenceSchema,
    state: conversationActorStateSchema,
    activeInteractionRunId: identifierSchema.nullable(),
    latestInputSequence: sequenceSchema,
    acceptedThroughSequence: sequenceSchema,
    finalizedThroughSequence: sequenceSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.finalizedThroughSequence > record.acceptedThroughSequence) {
      context.addIssue({
        code: "custom",
        path: ["finalizedThroughSequence"],
        message: "finalizedThroughSequence must not exceed acceptedThroughSequence",
      });
    }
    if (record.acceptedThroughSequence > record.latestInputSequence) {
      context.addIssue({
        code: "custom",
        path: ["acceptedThroughSequence"],
        message: "acceptedThroughSequence must not exceed latestInputSequence",
      });
    }
  });

export const interactionRunCasPreconditionSchema = z
  .object({
    interactionRunId: identifierSchema,
    generation: sequenceSchema,
    state: interactionRunNonterminalStateSchema,
    threadId: z.string().min(1).nullable(),
    turnId: z.string().min(1).nullable(),
    acceptedThroughSequence: sequenceSchema,
  })
  .strict();

export const beginInteractionConversationPreconditionSchema = z
  .object({
    actorGeneration: sequenceSchema,
    state: beginInteractionConversationStateSchema,
    activeInteractionRunId: z.null(),
    latestInputSequence: sequenceSchema,
    acceptedThroughSequence: sequenceSchema,
    finalizedThroughSequence: sequenceSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.finalizedThroughSequence > record.acceptedThroughSequence) {
      context.addIssue({
        code: "custom",
        path: ["finalizedThroughSequence"],
        message: "finalizedThroughSequence must not exceed acceptedThroughSequence",
      });
    }
    if (record.acceptedThroughSequence > record.latestInputSequence) {
      context.addIssue({
        code: "custom",
        path: ["acceptedThroughSequence"],
        message: "acceptedThroughSequence must not exceed latestInputSequence",
      });
    }
    if (record.finalizedThroughSequence >= record.latestInputSequence) {
      context.addIssue({
        code: "custom",
        path: ["latestInputSequence"],
        message: "beginInteraction requires unfinalized input",
      });
    }
  });

export const interactionSteerCasPreconditionSchema = z
  .object({
    interactionSteerId: identifierSchema,
    state: interactionSteerStateSchema,
    expectedTurnId: z.string().min(1).nullable(),
    submissionGeneration: sequenceSchema,
  })
  .strict();

export const CONVERSATION_CAS_FAILURE_REASONS = [
  "conversation_precondition",
  "run_precondition",
  "steer_precondition",
] as const;

export const conversationCasFailureReasonSchema = z.enum(
  CONVERSATION_CAS_FAILURE_REASONS,
);

const staleActorGenerationResultSchema = z
  .object({
    status: z.literal("stale_generation"),
    spaceId: identifierSchema,
    expectedActorGeneration: sequenceSchema,
    actualActorGeneration: sequenceSchema,
  })
  .strict();

const conversationPreconditionFailedResultSchema = z
  .object({
    status: z.literal("precondition_failed"),
    spaceId: identifierSchema,
    actorGeneration: sequenceSchema,
    reason: conversationCasFailureReasonSchema,
  })
  .strict();

export const conversationCasFailureSchema = z.discriminatedUnion("status", [
  staleActorGenerationResultSchema,
  conversationPreconditionFailedResultSchema,
]);

export const conversationInputAssignmentSchema = z
  .object({
    messageId: identifierSchema,
    spaceId: identifierSchema,
    inputSequence: sequenceSchema,
    actorGeneration: sequenceSchema,
  })
  .strict();

export const conversationInputIngestResultSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("inserted"),
        input: conversationInputAssignmentSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("duplicate"),
        input: conversationInputAssignmentSchema,
      })
      .strict(),
  ],
);

export const conversationInitializationResultSchema = z
  .object({
    state: conversationStateRecordSchema,
    backfilledInputCount: sequenceSchema,
  })
  .strict();

export const interactionRunMutationResultSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("applied"),
        run: interactionRunRecordSchema,
      })
      .strict(),
    staleActorGenerationResultSchema,
    conversationPreconditionFailedResultSchema,
  ],
);

export const interactionSteerMutationResultSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("applied"),
        steer: interactionSteerRecordSchema,
      })
      .strict(),
    staleActorGenerationResultSchema,
    conversationPreconditionFailedResultSchema,
  ],
);

export const interactionSteerClaimResultSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("claimed"),
        steer: interactionSteerRecordSchema,
      })
      .strict(),
    z.object({ status: z.literal("none") }).strict(),
    staleActorGenerationResultSchema,
    conversationPreconditionFailedResultSchema,
  ],
);

export type ConversationActorState = z.infer<
  typeof conversationActorStateSchema
>;
export type BeginInteractionConversationState = z.infer<
  typeof beginInteractionConversationStateSchema
>;
export type InteractionRunState = z.infer<typeof interactionRunStateSchema>;
export type InteractionRunNonterminalState = z.infer<
  typeof interactionRunNonterminalStateSchema
>;
export type InteractionRunTerminalState = z.infer<
  typeof interactionRunTerminalStateSchema
>;
export type InteractionRunRecoveryState = z.infer<
  typeof interactionRunRecoveryStateSchema
>;
export type InteractionSteerState = z.infer<
  typeof interactionSteerStateSchema
>;
export type ConversationStateRecord = z.infer<
  typeof conversationStateRecordSchema
>;
export type InteractionRunRecord = z.infer<typeof interactionRunRecordSchema>;
export type InteractionSteerRecord = z.infer<
  typeof interactionSteerRecordSchema
>;
export type InteractionAuthorizationReference = z.infer<
  typeof interactionAuthorizationReferenceSchema
>;
export type ConversationCasPrecondition = z.infer<
  typeof conversationCasPreconditionSchema
>;
export type InteractionRunCasPrecondition = z.infer<
  typeof interactionRunCasPreconditionSchema
>;
export type BeginInteractionConversationPrecondition = z.infer<
  typeof beginInteractionConversationPreconditionSchema
>;
export type InteractionSteerCasPrecondition = z.infer<
  typeof interactionSteerCasPreconditionSchema
>;
export type ConversationCasFailureReason = z.infer<
  typeof conversationCasFailureReasonSchema
>;
export type ConversationCasFailure = z.infer<
  typeof conversationCasFailureSchema
>;
export type ConversationInputAssignment = z.infer<
  typeof conversationInputAssignmentSchema
>;
export type ConversationInputIngestResult = z.infer<
  typeof conversationInputIngestResultSchema
>;
export type ConversationInitializationResult = z.infer<
  typeof conversationInitializationResultSchema
>;
export type InteractionRunMutationResult = z.infer<
  typeof interactionRunMutationResultSchema
>;
export type InteractionSteerMutationResult = z.infer<
  typeof interactionSteerMutationResultSchema
>;
export type InteractionSteerClaimResult = z.infer<
  typeof interactionSteerClaimResultSchema
>;

import { z } from "zod";

import { jsonValueSchema } from "../security/action-schema.js";

export const CONVERSATION_ACTOR_STATES = [
  "idle",
  "starting",
  "active",
  "finalizing",
  "recovering",
] as const;

export const INTERACTION_RUN_STATES = [
  "starting",
  "active",
  "finalizing",
  "completed",
  "failed",
  "canceled",
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
export const interactionRunStateSchema = z.enum(INTERACTION_RUN_STATES);
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

export type ConversationActorState = z.infer<
  typeof conversationActorStateSchema
>;
export type InteractionRunState = z.infer<typeof interactionRunStateSchema>;
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

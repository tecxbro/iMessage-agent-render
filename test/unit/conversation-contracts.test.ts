import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  CONVERSATION_ERROR_CODES,
  DELIVERY_ERROR_CODES,
  conversationErrorCodeSchema,
  deliveryErrorCodeSchema,
} from "../../src/conversation/errors.js";
import {
  CONVERSATION_ACTOR_STATES,
  INTERACTION_RUN_STATES,
  INTERACTION_STEER_STATES,
  conversationStateRecordSchema,
  interactionAuthorizationReferenceSchema,
  interactionDecisionMetadataSchema,
  interactionRunRecordSchema,
  interactionSteerRecordSchema,
} from "../../src/conversation/state.js";
import {
  conversationStates,
  interactionAuthorizationReferences,
  interactionRuns,
  interactionSteers,
} from "../../src/db/schema-fragments/conversation-actors.js";
import {
  chains,
  messages,
  outboundBatches,
} from "../../src/db/schema.js";
import { QUEUE_POLICIES } from "../../src/queue/boss.js";
import {
  QUEUE_NAMES,
  QUEUE_NAME_VALUES,
} from "../../src/queue/names.js";
import {
  interactionCoordinatePayloadSchema,
  outboundCoordinatePayloadSchema,
  parseQueuePayload,
} from "../../src/queue/payloads.js";

const ids = {
  deployment: "00000000-0000-4000-8000-000000000001",
  owner: "00000000-0000-4000-8000-000000000002",
  identity: "00000000-0000-4000-8000-000000000003",
  space: "00000000-0000-4000-8000-000000000004",
  run: "00000000-0000-4000-8000-000000000005",
  steer: "00000000-0000-4000-8000-000000000006",
  message: "00000000-0000-4000-8000-000000000007",
} as const;

describe("conversation actor contracts", () => {
  it("runtime-validates every frozen actor, run, and steer state", () => {
    expect(CONVERSATION_ACTOR_STATES).toEqual([
      "idle",
      "starting",
      "active",
      "finalizing",
      "recovering",
    ]);
    expect(INTERACTION_RUN_STATES).toEqual([
      "starting",
      "active",
      "finalizing",
      "completed",
      "failed",
      "canceled",
    ]);
    expect(INTERACTION_STEER_STATES).toEqual([
      "pending",
      "submitting",
      "accepted",
      "superseded",
      "failed",
    ]);

    const now = new Date("2026-08-18T00:00:00Z");
    expect(
      conversationStateRecordSchema.safeParse({
        spaceId: ids.space,
        latestInputSequence: 4,
        acceptedThroughSequence: 3,
        finalizedThroughSequence: 2,
        actorGeneration: 1,
        activeInteractionRunId: ids.run,
        state: "active",
        updatedAt: now,
      }).success,
    ).toBe(true);
    expect(
      conversationStateRecordSchema.safeParse({
        spaceId: ids.space,
        latestInputSequence: 2,
        acceptedThroughSequence: 3,
        finalizedThroughSequence: 0,
        actorGeneration: 1,
        activeInteractionRunId: ids.run,
        state: "active",
        updatedAt: now,
      }).success,
    ).toBe(false);

    expect(
      interactionRunRecordSchema.safeParse({
        id: ids.run,
        spaceId: ids.space,
        generation: 1,
        state: "active",
        threadId: "thread-1",
        turnId: "turn-1",
        startedThroughSequence: 1,
        acceptedThroughSequence: 2,
        modelId: "gpt-5.6-luna",
        reasoningEffort: "high",
        promptVersion: "conversation-v1",
        promptSha256: "a".repeat(64),
        decisionMetadataJson: { route: "direct" },
        draftOutputCiphertext: "cipher:draft",
        terminalReason: null,
        lastObservedEventJson: { type: "turn_started" },
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      }).success,
    ).toBe(true);

    expect(
      interactionSteerRecordSchema.safeParse({
        id: ids.steer,
        interactionRunId: ids.run,
        spaceId: ids.space,
        generation: 1,
        state: "pending",
        clientUserMessageId: ids.message,
        fromSequence: 4,
        throughSequence: 3,
        expectedTurnId: "turn-1",
        submissionGeneration: 1,
        submittedAt: null,
        acceptedAt: null,
        updatedAt: now,
      }).success,
    ).toBe(false);

    expect(
      interactionAuthorizationReferenceSchema.safeParse({
        interactionRunId: ids.run,
        deploymentId: ids.deployment,
        ownerId: ids.owner,
        identityId: ids.identity,
        authorizationRevision: 3,
        createdAt: now,
      }).success,
    ).toBe(true);
    expect(
      interactionDecisionMetadataSchema.safeParse({
        route: "direct",
        answer: "plaintext user-visible output",
      }).success,
    ).toBe(false);
  });

  it("runtime-validates identifier-only coordinator payloads", () => {
    for (const reason of [
      "inbound",
      "task_results_ready",
      "recovery",
      "late_input",
    ] as const) {
      expect(
        parseQueuePayload(QUEUE_NAMES.interactionCoordinate, {
          spaceId: ids.space,
          reason,
        }),
      ).toEqual({ spaceId: ids.space, reason });
    }
    expect(
      interactionCoordinatePayloadSchema.safeParse({
        spaceId: ids.space,
        reason: "inbound",
        text: "must not enter a queue payload",
      }).success,
    ).toBe(false);
    expect(
      outboundCoordinatePayloadSchema.safeParse({
        outboundBatchId: ids.run,
      }).success,
    ).toBe(true);
    expect(Object.keys(QUEUE_POLICIES).sort()).toEqual(
      [...QUEUE_NAME_VALUES].sort(),
    );
    expect(QUEUE_POLICIES[QUEUE_NAMES.interactionCoordinate]).toBe("stately");
    expect(QUEUE_POLICIES[QUEUE_NAMES.outboundCoordinate]).toBe("exclusive");
  });

  it("runtime-validates bounded conversation and delivery error codes", () => {
    expect(CONVERSATION_ERROR_CODES.every((code) =>
      conversationErrorCodeSchema.safeParse(code).success,
    )).toBe(true);
    expect(DELIVERY_ERROR_CODES.every((code) =>
      deliveryErrorCodeSchema.safeParse(code).success,
    )).toBe(true);
    expect(conversationErrorCodeSchema.safeParse("RAW_PROVIDER_ERROR").success).toBe(
      false,
    );
  });

  it("declares the additive database columns, checks, and unique indexes", () => {
    const messageConfig = getTableConfig(messages);
    const chainConfig = getTableConfig(chains);
    const batchConfig = getTableConfig(outboundBatches);
    const stateConfig = getTableConfig(conversationStates);
    const runConfig = getTableConfig(interactionRuns);
    const steerConfig = getTableConfig(interactionSteers);
    const authorizationConfig = getTableConfig(
      interactionAuthorizationReferences,
    );

    expect(messageConfig.columns.map((column) => column.name)).toContain(
      "input_sequence",
    );
    expect(messageConfig.indexes.map((index) => index.config.name)).toContain(
      "messages_inbound_sequence_unique",
    );
    expect(chainConfig.columns.map((column) => column.name)).toContain(
      "source_interaction_run_id",
    );
    expect(batchConfig.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "claim_owner",
        "claim_token",
        "claim_expires_at",
      ]),
    );
    expect(stateConfig.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "conversation_states_finalized_nonnegative",
        "conversation_states_finalized_accepted_order",
        "conversation_states_accepted_latest_order",
        "conversation_states_actor_generation_nonnegative",
      ]),
    );
    expect(runConfig.indexes.map((index) => index.config.name)).toContain(
      "interaction_runs_space_generation_unique",
    );
    expect(steerConfig.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        "interaction_steers_run_message_unique",
        "interaction_steers_run_range_unique",
      ]),
    );
    expect(steerConfig.checks.map((constraint) => constraint.name)).toContain(
      "interaction_steers_sequence_order",
    );
    expect(authorizationConfig.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "interaction_run_id",
        "deployment_id",
        "owner_id",
        "identity_id",
        "authorization_revision",
      ]),
    );
  });
});

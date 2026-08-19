import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import {
  CONVERSATION_ACTOR_STATES,
  INTERACTION_RUN_STATES,
  INTERACTION_STEER_STATES,
} from "../../conversation/state.js";
import {
  channelIdentities,
  deployments,
  messages,
  owners,
  spaces,
} from "../schema.js";

export const conversationActorState = pgEnum(
  "conversation_actor_state",
  CONVERSATION_ACTOR_STATES,
);
export const interactionRunState = pgEnum(
  "interaction_run_state",
  INTERACTION_RUN_STATES,
);
export const interactionSteerState = pgEnum(
  "interaction_steer_state",
  INTERACTION_STEER_STATES,
);

export const interactionRuns = pgTable(
  "interaction_runs",
  {
    id: uuid("id").primaryKey(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    generation: bigint("generation", { mode: "number" }).notNull(),
    state: interactionRunState("state").default("starting").notNull(),
    threadId: text("thread_id"),
    turnId: text("turn_id"),
    startedThroughSequence: bigint("started_through_sequence", {
      mode: "number",
    }).notNull(),
    acceptedThroughSequence: bigint("accepted_through_sequence", {
      mode: "number",
    }).notNull(),
    modelId: varchar("model_id", { length: 128 }).notNull(),
    reasoningEffort: varchar("reasoning_effort", { length: 32 }).notNull(),
    promptVersion: varchar("prompt_version", { length: 128 }).notNull(),
    promptSha256: varchar("prompt_sha256", { length: 64 }).notNull(),
    decisionMetadataJson: jsonb("decision_metadata_json")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    draftOutputCiphertext: text("draft_output_ciphertext"),
    terminalReason: varchar("terminal_reason", { length: 128 }),
    lastObservedEventJson: jsonb("last_observed_event_json").$type<unknown>(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("interaction_runs_space_generation_unique").on(
      table.spaceId,
      table.generation,
    ),
    index("interaction_runs_space_state_idx").on(table.spaceId, table.state),
    check(
      "interaction_runs_generation_nonnegative",
      sql`${table.generation} >= 0`,
    ),
    check(
      "interaction_runs_sequence_order",
      sql`${table.startedThroughSequence} <= ${table.acceptedThroughSequence}`,
    ),
    check(
      "interaction_runs_completion_consistent",
      sql`(${table.state} in ('completed', 'failed', 'canceled', 'interrupted', 'orphaned') and ${table.completedAt} is not null) or (${table.state} in ('starting', 'active', 'finalizing') and ${table.completedAt} is null)`,
    ),
    check(
      "interaction_runs_terminal_reason_consistent",
      sql`${table.state} not in ('failed', 'canceled', 'interrupted', 'orphaned') or ${table.terminalReason} is not null`,
    ),
  ],
);

export const conversationStates = pgTable(
  "conversation_states",
  {
    spaceId: uuid("space_id")
      .primaryKey()
      .references(() => spaces.id, { onDelete: "cascade" }),
    latestInputSequence: bigint("latest_input_sequence", { mode: "number" })
      .default(0)
      .notNull(),
    acceptedThroughSequence: bigint("accepted_through_sequence", {
      mode: "number",
    })
      .default(0)
      .notNull(),
    finalizedThroughSequence: bigint("finalized_through_sequence", {
      mode: "number",
    })
      .default(0)
      .notNull(),
    actorGeneration: bigint("actor_generation", { mode: "number" })
      .default(0)
      .notNull(),
    activeInteractionRunId: uuid("active_interaction_run_id").references(
      () => interactionRuns.id,
      { onDelete: "set null" },
    ),
    state: conversationActorState("state").default("idle").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "conversation_states_finalized_nonnegative",
      sql`${table.finalizedThroughSequence} >= 0`,
    ),
    check(
      "conversation_states_finalized_accepted_order",
      sql`${table.finalizedThroughSequence} <= ${table.acceptedThroughSequence}`,
    ),
    check(
      "conversation_states_accepted_latest_order",
      sql`${table.acceptedThroughSequence} <= ${table.latestInputSequence}`,
    ),
    check(
      "conversation_states_actor_generation_nonnegative",
      sql`${table.actorGeneration} >= 0`,
    ),
  ],
);

export const interactionSteers = pgTable(
  "interaction_steers",
  {
    id: uuid("id").primaryKey(),
    interactionRunId: uuid("interaction_run_id")
      .notNull()
      .references(() => interactionRuns.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    generation: bigint("generation", { mode: "number" }).notNull(),
    state: interactionSteerState("state").default("pending").notNull(),
    clientUserMessageId: uuid("client_user_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "restrict" }),
    fromSequence: bigint("from_sequence", { mode: "number" }).notNull(),
    throughSequence: bigint("through_sequence", { mode: "number" }).notNull(),
    expectedTurnId: text("expected_turn_id"),
    submissionGeneration: bigint("submission_generation", {
      mode: "number",
    }).notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("interaction_steers_run_message_unique").on(
      table.interactionRunId,
      table.clientUserMessageId,
    ),
    uniqueIndex("interaction_steers_run_range_unique").on(
      table.interactionRunId,
      table.fromSequence,
      table.throughSequence,
    ),
    index("interaction_steers_reconcile_idx").on(
      table.interactionRunId,
      table.state,
      table.updatedAt,
    ),
    check(
      "interaction_steers_sequence_order",
      sql`${table.fromSequence} <= ${table.throughSequence}`,
    ),
  ],
);

export const interactionAuthorizationReferences = pgTable(
  "interaction_authorization_references",
  {
    interactionRunId: uuid("interaction_run_id")
      .primaryKey()
      .references(() => interactionRuns.id, { onDelete: "cascade" }),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "restrict" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id, { onDelete: "restrict" }),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => channelIdentities.id, { onDelete: "restrict" }),
    authorizationRevision: bigint("authorization_revision", {
      mode: "number",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("interaction_authorization_identity_idx").on(table.identityId),
  ],
);

export type ConversationStateRow = typeof conversationStates.$inferSelect;
export type InteractionRunRow = typeof interactionRuns.$inferSelect;
export type InteractionSteerRow = typeof interactionSteers.$inferSelect;
export type InteractionAuthorizationReferenceRow =
  typeof interactionAuthorizationReferences.$inferSelect;

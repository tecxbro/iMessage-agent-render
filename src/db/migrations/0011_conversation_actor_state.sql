CREATE TYPE "public"."conversation_actor_state" AS ENUM('idle', 'starting', 'active', 'finalizing', 'recovering');--> statement-breakpoint
CREATE TYPE "public"."interaction_run_state" AS ENUM('starting', 'active', 'finalizing', 'completed', 'failed', 'canceled', 'interrupted', 'orphaned');--> statement-breakpoint
CREATE TYPE "public"."interaction_steer_state" AS ENUM('pending', 'submitting', 'accepted', 'superseded', 'failed');--> statement-breakpoint
CREATE TABLE "conversation_states" (
	"space_id" uuid PRIMARY KEY NOT NULL,
	"latest_input_sequence" bigint DEFAULT 0 NOT NULL,
	"accepted_through_sequence" bigint DEFAULT 0 NOT NULL,
	"finalized_through_sequence" bigint DEFAULT 0 NOT NULL,
	"actor_generation" bigint DEFAULT 0 NOT NULL,
	"active_interaction_run_id" uuid,
	"state" "conversation_actor_state" DEFAULT 'idle' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_states_finalized_nonnegative" CHECK ("conversation_states"."finalized_through_sequence" >= 0),
	CONSTRAINT "conversation_states_finalized_accepted_order" CHECK ("conversation_states"."finalized_through_sequence" <= "conversation_states"."accepted_through_sequence"),
	CONSTRAINT "conversation_states_accepted_latest_order" CHECK ("conversation_states"."accepted_through_sequence" <= "conversation_states"."latest_input_sequence"),
	CONSTRAINT "conversation_states_actor_generation_nonnegative" CHECK ("conversation_states"."actor_generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "interaction_authorization_references" (
	"interaction_run_id" uuid PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"authorization_revision" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interaction_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"generation" bigint NOT NULL,
	"state" "interaction_run_state" DEFAULT 'starting' NOT NULL,
	"thread_id" text,
	"turn_id" text,
	"started_through_sequence" bigint NOT NULL,
	"accepted_through_sequence" bigint NOT NULL,
	"model_id" varchar(128) NOT NULL,
	"reasoning_effort" varchar(32) NOT NULL,
	"prompt_version" varchar(128) NOT NULL,
	"prompt_sha256" varchar(64) NOT NULL,
	"decision_metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"draft_output_ciphertext" text,
	"terminal_reason" varchar(128),
	"last_observed_event_json" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interaction_runs_generation_nonnegative" CHECK ("interaction_runs"."generation" >= 0),
	CONSTRAINT "interaction_runs_sequence_order" CHECK ("interaction_runs"."started_through_sequence" <= "interaction_runs"."accepted_through_sequence"),
	CONSTRAINT "interaction_runs_completion_consistent" CHECK (("interaction_runs"."state" in ('completed', 'failed', 'canceled', 'interrupted', 'orphaned') and "interaction_runs"."completed_at" is not null) or ("interaction_runs"."state" in ('starting', 'active', 'finalizing') and "interaction_runs"."completed_at" is null)),
	CONSTRAINT "interaction_runs_terminal_reason_consistent" CHECK ("interaction_runs"."state" not in ('failed', 'canceled', 'interrupted', 'orphaned') or "interaction_runs"."terminal_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "interaction_steers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"interaction_run_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"generation" bigint NOT NULL,
	"state" "interaction_steer_state" DEFAULT 'pending' NOT NULL,
	"client_user_message_id" uuid NOT NULL,
	"from_sequence" bigint NOT NULL,
	"through_sequence" bigint NOT NULL,
	"expected_turn_id" text,
	"submission_generation" bigint NOT NULL,
	"submitted_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interaction_steers_sequence_order" CHECK ("interaction_steers"."from_sequence" <= "interaction_steers"."through_sequence")
);
--> statement-breakpoint
ALTER TABLE "chains" ADD COLUMN "source_interaction_run_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "input_sequence" bigint;--> statement-breakpoint
WITH "ranked_inbound" AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "space_id"
			ORDER BY "received_at" ASC NULLS LAST, "created_at" ASC, "id" ASC
		) AS "input_sequence"
	FROM "messages"
	WHERE "direction" = 'inbound'
)
UPDATE "messages" AS "message"
SET "input_sequence" = "ranked_inbound"."input_sequence"
FROM "ranked_inbound"
WHERE "message"."id" = "ranked_inbound"."id";--> statement-breakpoint
INSERT INTO "conversation_states" (
	"space_id",
	"latest_input_sequence",
	"accepted_through_sequence",
	"finalized_through_sequence",
	"actor_generation",
	"active_interaction_run_id",
	"state"
)
SELECT
	"space"."id",
	coalesce(max("message"."input_sequence"), 0),
	coalesce(max("message"."input_sequence"), 0),
	coalesce(max("message"."input_sequence"), 0),
	0,
	NULL,
	'idle'
FROM "spaces" AS "space"
LEFT JOIN "messages" AS "message"
	ON "message"."space_id" = "space"."id"
	AND "message"."direction" = 'inbound'
GROUP BY "space"."id"
ON CONFLICT ("space_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "outbound_batches" ADD COLUMN "claim_owner" varchar(128);--> statement-breakpoint
ALTER TABLE "outbound_batches" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "outbound_batches" ADD COLUMN "claim_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_states" ADD CONSTRAINT "conversation_states_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_states" ADD CONSTRAINT "conversation_states_active_interaction_run_id_interaction_runs_id_fk" FOREIGN KEY ("active_interaction_run_id") REFERENCES "public"."interaction_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_authorization_references" ADD CONSTRAINT "interaction_authorization_references_interaction_run_id_interaction_runs_id_fk" FOREIGN KEY ("interaction_run_id") REFERENCES "public"."interaction_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_authorization_references" ADD CONSTRAINT "interaction_authorization_references_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_authorization_references" ADD CONSTRAINT "interaction_authorization_references_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_authorization_references" ADD CONSTRAINT "interaction_authorization_references_identity_id_channel_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."channel_identities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_runs" ADD CONSTRAINT "interaction_runs_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_steers" ADD CONSTRAINT "interaction_steers_interaction_run_id_interaction_runs_id_fk" FOREIGN KEY ("interaction_run_id") REFERENCES "public"."interaction_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_steers" ADD CONSTRAINT "interaction_steers_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_steers" ADD CONSTRAINT "interaction_steers_client_user_message_id_messages_id_fk" FOREIGN KEY ("client_user_message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chains" ADD CONSTRAINT "chains_source_interaction_run_id_interaction_runs_id_fk" FOREIGN KEY ("source_interaction_run_id") REFERENCES "public"."interaction_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interaction_authorization_identity_idx" ON "interaction_authorization_references" USING btree ("identity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "interaction_runs_space_generation_unique" ON "interaction_runs" USING btree ("space_id","generation");--> statement-breakpoint
CREATE INDEX "interaction_runs_space_state_idx" ON "interaction_runs" USING btree ("space_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "interaction_steers_run_message_unique" ON "interaction_steers" USING btree ("interaction_run_id","client_user_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "interaction_steers_run_range_unique" ON "interaction_steers" USING btree ("interaction_run_id","from_sequence","through_sequence");--> statement-breakpoint
CREATE INDEX "interaction_steers_reconcile_idx" ON "interaction_steers" USING btree ("interaction_run_id","state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_inbound_sequence_unique" ON "messages" USING btree ("space_id","input_sequence") WHERE "messages"."direction" = 'inbound';

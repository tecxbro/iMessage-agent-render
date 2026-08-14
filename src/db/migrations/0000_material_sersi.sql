CREATE TYPE "public"."agent_thread_status" AS ENUM('active', 'reset', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired', 'consumed');--> statement-breakpoint
CREATE TYPE "public"."chain_state" AS ENUM('queued', 'planning', 'executing', 'awaiting_approval', 'synthesizing', 'sending', 'complete', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."content_type" AS ENUM('text');--> statement-breakpoint
CREATE TYPE "public"."deployment_status" AS ENUM('active', 'disabled', 'maintenance');--> statement-breakpoint
CREATE TYPE "public"."execution_task_state" AS ENUM('queued', 'running', 'succeeded', 'failed', 'canceled', 'needs_approval');--> statement-breakpoint
CREATE TYPE "public"."identity_role" AS ENUM('owner', 'collaborator');--> statement-breakpoint
CREATE TYPE "public"."memory_operation" AS ENUM('add', 'update', 'delete', 'recall');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."outbound_batch_state" AS ENUM('queued', 'sending', 'sent', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."outbound_part_state" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."owner_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('imessage');--> statement-breakpoint
CREATE TYPE "public"."projection_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."space_type" AS ENUM('dm', 'group');--> statement-breakpoint
CREATE TABLE "agent_threads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_name" varchar(128) NOT NULL,
	"workspace_binding" text NOT NULL,
	"codex_thread_id" text,
	"summary" text,
	"last_model_profile" varchar(64),
	"status" "agent_thread_status" DEFAULT 'active' NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"chain_id" uuid NOT NULL,
	"execution_task_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"action_type" varchar(128) NOT NULL,
	"normalized_payload_ciphertext" text,
	"action_hash" varchar(128) NOT NULL,
	"human_summary" text NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_by_identity_id" uuid,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carried_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"source_chain_id" uuid NOT NULL,
	"source_message_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"consumed_by_chain_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carried_messages_position_nonnegative" CHECK ("carried_messages"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "chains" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"state" "chain_state" DEFAULT 'queued' NOT NULL,
	"chain_started_at" timestamp with time zone NOT NULL,
	"canceled_at" timestamp with time zone,
	"canceled_by_message_id" uuid,
	"model_profile" varchar(64),
	"prompt_version" varchar(128),
	"decision_json" jsonb,
	"terminal_error_code" varchar(128),
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chains_version_positive" CHECK ("chains"."version" > 0),
	CONSTRAINT "chains_cancellation_consistent" CHECK (("chains"."state" = 'canceled' and "chains"."canceled_at" is not null) or ("chains"."state" <> 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "channel_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"platform" "platform" DEFAULT 'imessage' NOT NULL,
	"normalized_handle_ciphertext" text NOT NULL,
	"handle_fingerprint" varchar(128) NOT NULL,
	"role" "identity_role" NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "deployment_status" DEFAULT 'active' NOT NULL,
	"default_model_profile" varchar(64) NOT NULL,
	"settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"chain_id" uuid NOT NULL,
	"agent_thread_id" uuid,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"instructions_ciphertext" text,
	"model_profile" varchar(64) NOT NULL,
	"permission_profile" varchar(64) NOT NULL,
	"state" "execution_task_state" DEFAULT 'queued' NOT NULL,
	"depends_on_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result_json" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_tasks_attempt_nonnegative" CHECK ("execution_tasks"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "failure_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"correlation_type" varchar(64) NOT NULL,
	"correlation_id" text NOT NULL,
	"component" varchar(64) NOT NULL,
	"error_code" varchar(128) NOT NULL,
	"retryable" boolean NOT NULL,
	"safe_message" text NOT NULL,
	"payload_summary_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retention_expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_sync_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"chain_id" uuid NOT NULL,
	"operation" "memory_operation" NOT NULL,
	"external_memory_id" text,
	"content_hash" varchar(128) NOT NULL,
	"status" "projection_status" DEFAULT 'pending' NOT NULL,
	"safe_summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"external_message_id" text,
	"direction" "message_direction" NOT NULL,
	"sender_identity_id" uuid,
	"content_type" "content_type" DEFAULT 'text' NOT NULL,
	"content_ciphertext" text,
	"content_hash" varchar(128) NOT NULL,
	"received_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"drained_chain_id" uuid,
	"retention_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_direction_timestamp_check" CHECK (("messages"."direction" = 'inbound' and "messages"."received_at" is not null) or ("messages"."direction" = 'outbound' and "messages"."sent_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "outbound_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"chain_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"state" "outbound_batch_state" DEFAULT 'queued' NOT NULL,
	"start_index" integer DEFAULT 0 NOT NULL,
	"part_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_batches_cursor_bounds" CHECK ("outbound_batches"."start_index" >= 0 and "outbound_batches"."part_count" >= 0 and "outbound_batches"."start_index" <= "outbound_batches"."part_count")
);
--> statement-breakpoint
CREATE TABLE "outbound_parts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"client_guid" varchar(64) NOT NULL,
	"content_ciphertext" text NOT NULL,
	"state" "outbound_part_state" DEFAULT 'pending' NOT NULL,
	"external_message_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_parts_position_nonnegative" CHECK ("outbound_parts"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "owners" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"display_name" text,
	"timezone" text NOT NULL,
	"locale" text,
	"status" "owner_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "space_members" (
	"space_id" uuid NOT NULL,
	"observed_handle_fingerprint" varchar(128) NOT NULL,
	"channel_identity_id" uuid,
	"is_authorized" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "space_members_space_id_observed_handle_fingerprint_pk" PRIMARY KEY("space_id","observed_handle_fingerprint")
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"platform" "platform" DEFAULT 'imessage' NOT NULL,
	"external_space_guid" text NOT NULL,
	"route_phone_ciphertext" text,
	"route_phone_fingerprint" varchar(128),
	"type" "space_type" NOT NULL,
	"model_profile_override" varchar(64),
	"interaction_thread_id" text,
	"interaction_summary" text,
	"last_message_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain_id" uuid,
	"execution_task_id" uuid,
	"event_type" varchar(128) NOT NULL,
	"model" varchar(128),
	"effort" varchar(32),
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"estimated_cost_microunits" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_threads" ADD CONSTRAINT "agent_threads_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_execution_task_id_execution_tasks_id_fk" FOREIGN KEY ("execution_task_id") REFERENCES "public"."execution_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approved_by_identity_id_channel_identities_id_fk" FOREIGN KEY ("approved_by_identity_id") REFERENCES "public"."channel_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carried_messages" ADD CONSTRAINT "carried_messages_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carried_messages" ADD CONSTRAINT "carried_messages_source_chain_id_chains_id_fk" FOREIGN KEY ("source_chain_id") REFERENCES "public"."chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carried_messages" ADD CONSTRAINT "carried_messages_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carried_messages" ADD CONSTRAINT "carried_messages_consumed_by_chain_id_chains_id_fk" FOREIGN KEY ("consumed_by_chain_id") REFERENCES "public"."chains"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chains" ADD CONSTRAINT "chains_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chains" ADD CONSTRAINT "chains_canceled_by_message_id_messages_id_fk" FOREIGN KEY ("canceled_by_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_tasks" ADD CONSTRAINT "execution_tasks_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_tasks" ADD CONSTRAINT "execution_tasks_agent_thread_id_agent_threads_id_fk" FOREIGN KEY ("agent_thread_id") REFERENCES "public"."agent_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sync_events" ADD CONSTRAINT "memory_sync_events_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sync_events" ADD CONSTRAINT "memory_sync_events_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_sync_events" ADD CONSTRAINT "memory_sync_events_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_identity_id_channel_identities_id_fk" FOREIGN KEY ("sender_identity_id") REFERENCES "public"."channel_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_drained_chain_id_chains_id_fk" FOREIGN KEY ("drained_chain_id") REFERENCES "public"."chains"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_batches" ADD CONSTRAINT "outbound_batches_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_batches" ADD CONSTRAINT "outbound_batches_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_parts" ADD CONSTRAINT "outbound_parts_batch_id_outbound_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."outbound_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owners" ADD CONSTRAINT "owners_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_channel_identity_id_channel_identities_id_fk" FOREIGN KEY ("channel_identity_id") REFERENCES "public"."channel_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_execution_task_id_execution_tasks_id_fk" FOREIGN KEY ("execution_task_id") REFERENCES "public"."execution_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_threads_binding_unique" ON "agent_threads" USING btree ("owner_id","agent_name","workspace_binding");--> statement-breakpoint
CREATE INDEX "approvals_pending_scope_idx" ON "approvals" USING btree ("owner_id","space_id","expires_at") WHERE "approvals"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "carried_messages_source_unique" ON "carried_messages" USING btree ("source_chain_id","source_message_id");--> statement-breakpoint
CREATE INDEX "carried_messages_pending_idx" ON "carried_messages" USING btree ("space_id","consumed_by_chain_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "chains_space_version_unique" ON "chains" USING btree ("space_id","version");--> statement-breakpoint
CREATE INDEX "chains_active_space_idx" ON "chains" USING btree ("space_id","version") WHERE "chains"."state" in ('queued', 'planning', 'executing', 'awaiting_approval', 'synthesizing', 'sending');--> statement-breakpoint
CREATE UNIQUE INDEX "channel_identities_handle_unique" ON "channel_identities" USING btree ("deployment_id","platform","handle_fingerprint");--> statement-breakpoint
CREATE INDEX "channel_identities_owner_idx" ON "channel_identities" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "execution_tasks_chain_state_idx" ON "execution_tasks" USING btree ("chain_id","state");--> statement-breakpoint
CREATE INDEX "failure_events_retention_idx" ON "failure_events" USING btree ("retention_expires_at");--> statement-breakpoint
CREATE INDEX "memory_sync_events_scope_idx" ON "memory_sync_events" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_sync_events_projection_unique" ON "memory_sync_events" USING btree ("owner_id","operation","content_hash") WHERE "memory_sync_events"."operation" in ('add', 'update');--> statement-breakpoint
CREATE UNIQUE INDEX "messages_external_identity_unique" ON "messages" USING btree ("space_id","external_message_id") WHERE "messages"."external_message_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_undrained_inbound_idx" ON "messages" USING btree ("space_id","received_at","id") WHERE "messages"."direction" = 'inbound' and "messages"."drained_chain_id" is null;--> statement-breakpoint
CREATE INDEX "messages_retention_idx" ON "messages" USING btree ("retention_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_batches_chain_unique" ON "outbound_batches" USING btree ("chain_id");--> statement-breakpoint
CREATE INDEX "outbound_batches_resume_idx" ON "outbound_batches" USING btree ("state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_parts_batch_position_unique" ON "outbound_parts" USING btree ("batch_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_parts_client_guid_unique" ON "outbound_parts" USING btree ("client_guid");--> statement-breakpoint
CREATE INDEX "owners_deployment_idx" ON "owners" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "space_members_identity_idx" ON "space_members" USING btree ("channel_identity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_external_route_unique" ON "spaces" USING btree ("deployment_id","platform","external_space_guid",coalesce("route_phone_fingerprint", ''));--> statement-breakpoint
CREATE INDEX "spaces_recent_idx" ON "spaces" USING btree ("deployment_id","last_message_at");--> statement-breakpoint
CREATE INDEX "usage_events_created_idx" ON "usage_events" USING btree ("created_at");
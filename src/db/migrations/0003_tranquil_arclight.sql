CREATE TYPE "public"."pairing_status" AS ENUM('pending', 'consumed', 'expired');--> statement-breakpoint
CREATE TABLE "pairing_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"handle_fingerprint" varchar(128) NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pairing_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"role" "identity_role" DEFAULT 'collaborator' NOT NULL,
	"salt" varchar(128) NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"status" "pairing_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pairing_challenges_collaborator_role" CHECK ("pairing_challenges"."role" = 'collaborator'),
	CONSTRAINT "pairing_challenges_code_hash" CHECK ("pairing_challenges"."code_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "pairing_challenges_consumption_consistent" CHECK (("pairing_challenges"."status" = 'consumed' and "pairing_challenges"."consumed_at" is not null) or ("pairing_challenges"."status" <> 'consumed' and "pairing_challenges"."consumed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "pairing_attempts" ADD CONSTRAINT "pairing_attempts_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_challenges" ADD CONSTRAINT "pairing_challenges_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_challenges" ADD CONSTRAINT "pairing_challenges_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pairing_attempts_handle_window_idx" ON "pairing_attempts" USING btree ("deployment_id","handle_fingerprint","attempted_at");--> statement-breakpoint
CREATE INDEX "pairing_attempts_deployment_window_idx" ON "pairing_attempts" USING btree ("deployment_id","attempted_at");--> statement-breakpoint
CREATE INDEX "pairing_challenges_pending_idx" ON "pairing_challenges" USING btree ("deployment_id","expires_at") WHERE "pairing_challenges"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_active_task_unique" ON "approvals" USING btree ("execution_task_id") WHERE "approvals"."status" in ('pending', 'approved');--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_action_hash_sha256" CHECK ("approvals"."action_hash" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_action_type_registered" CHECK ("approvals"."action_type" in ('filesystem.destructive', 'external.send', 'purchase', 'authentication.change', 'permission.change', 'deployment.change', 'secret.access', 'network.broad', 'dependency.install', 'other.consequential'));--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_consumption_consistent" CHECK (("approvals"."status" = 'consumed' and "approvals"."consumed_at" is not null) or ("approvals"."status" <> 'consumed' and "approvals"."consumed_at" is null));--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_approval_request_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
		OR NEW.space_id IS DISTINCT FROM OLD.space_id
		OR NEW.chain_id IS DISTINCT FROM OLD.chain_id
		OR NEW.execution_task_id IS DISTINCT FROM OLD.execution_task_id
		OR NEW.action_type IS DISTINCT FROM OLD.action_type
		OR NEW.action_hash IS DISTINCT FROM OLD.action_hash
		OR NEW.human_summary IS DISTINCT FROM OLD.human_summary
		OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
		RAISE EXCEPTION 'approval request scope and action fields are immutable';
	END IF;

	IF NEW.normalized_payload_ciphertext IS DISTINCT FROM OLD.normalized_payload_ciphertext
		AND NOT (
			OLD.status IN ('rejected', 'expired', 'consumed')
			AND NEW.normalized_payload_ciphertext IS NULL
		) THEN
		RAISE EXCEPTION 'approval request payload is immutable';
	END IF;

	IF NEW.status IS DISTINCT FROM OLD.status
		AND NOT (
			(OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'expired'))
			OR (OLD.status = 'approved' AND NEW.status IN ('consumed', 'expired'))
		) THEN
		RAISE EXCEPTION 'illegal approval status transition from % to %', OLD.status, NEW.status;
	END IF;

	IF NEW.approved_by_identity_id IS DISTINCT FROM OLD.approved_by_identity_id
		AND NOT (
			OLD.status = 'pending'
			AND NEW.status = 'approved'
			AND OLD.approved_by_identity_id IS NULL
			AND NEW.approved_by_identity_id IS NOT NULL
		) THEN
		RAISE EXCEPTION 'approval actor is immutable outside pending-to-approved transition';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER approvals_immutable_request
BEFORE UPDATE ON "approvals"
FOR EACH ROW
EXECUTE FUNCTION protect_approval_request_immutability();

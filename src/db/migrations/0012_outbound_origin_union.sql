ALTER TABLE "outbound_batches" ALTER COLUMN "chain_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_batches" ADD COLUMN "interaction_run_id" uuid;--> statement-breakpoint
ALTER TABLE "outbound_batches" ADD CONSTRAINT "outbound_batches_interaction_run_id_interaction_runs_id_fk" FOREIGN KEY ("interaction_run_id") REFERENCES "public"."interaction_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_batches_interaction_run_unique" ON "outbound_batches" USING btree ("interaction_run_id");--> statement-breakpoint
ALTER TABLE "outbound_batches" ADD CONSTRAINT "outbound_batches_origin_union" CHECK (("outbound_batches"."chain_id" is not null and "outbound_batches"."interaction_run_id" is null) or ("outbound_batches"."chain_id" is null and "outbound_batches"."interaction_run_id" is not null));

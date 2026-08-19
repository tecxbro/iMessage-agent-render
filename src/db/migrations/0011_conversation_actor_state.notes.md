# Migration 0011 compatibility and rollback

## Compatibility

- Apply after `0010_memory_curation_pipeline`. Every table and column in this
  migration is additive; the existing spaces, chain pipeline, queue handlers,
  and outbound sender remain valid after the migration.
- Existing inbound rows are backfilled deterministically per space by
  `received_at`, `created_at`, then `id`. Migration-created conversation state
  initializes `latest`, `accepted`, and `finalized` through that historical
  maximum so activating the new actor cannot repeat user-visible work already
  owned by the legacy runtime.
- `messages.input_sequence` remains nullable for rolling compatibility because
  the legacy runtime can still insert rows without a sequence. Before actor
  activation, `ConversationRepositoryPort.initializeConversation()` must lock
  the space, sequence every remaining `NULL` inbound row in the same order,
  advance all three historical cursors, and return the initialized state.
  `ingestInput()` performs that initialization under the same transaction as
  encrypted message insertion and next-sequence assignment. This legacy
  finalization is allowed only while `actor_generation = 0`, actor state is
  `idle`, and no run is active. A later `NULL` sequence is an invariant failure
  that requires operator repair rather than silent finalization.
- `spaces.interaction_thread_id` and `spaces.interaction_summary` remain in
  place for the legacy runtime. A later integration migration may move their
  ownership only after the conversation coordinator is implemented and
  restart-tested.
- `chains.source_interaction_run_id` is nullable and does not change the
  current chain lifecycle or outbound origin requirement. Existing and legacy
  chains continue to use a required chain ID.
- The outbound claim columns are nullable and unused by current workers. A
  delivery coordinator must use all three as one lease and compare the claim
  token before advancing a cursor; this migration does not activate that path.
- `decision_metadata_json` is for routing and task metadata only. User-visible
  draft output must be encrypted into `draft_output_ciphertext` before it is
  persisted.
- `interrupted` and `orphaned` are terminal run states. `interrupted` records a
  run that was still authoritative when its runtime stopped; `orphaned`
  records a nonterminal run that no longer matches the conversation's active
  run/generation during reconciliation. Both require `completed_at` and a
  bounded `terminal_reason`, and neither may be resumed in place.
- Every actor mutation compares the complete frozen conversation precondition
  plus the relevant run/steer precondition. A generation mismatch returns the
  typed `stale_generation` result; another compare-and-set miss returns
  `precondition_failed`. Callers reload instead of inferring success from a
  nullable row.
- Deploy this migration before publishing `interaction.coordinate` or
  `outbound.coordinate` jobs. The queues may be created before their workers
  are registered.

## Rollback

Prefer an application-only rollback while leaving the additive schema in
place. Older application revisions ignore these columns and tables.

If a schema rollback is mandatory, stop all conversation and delivery
coordinator publishers/workers, confirm no new-queue jobs remain runnable,
preserve required audit records, and run:

```sql
ALTER TABLE chains
  DROP CONSTRAINT IF EXISTS chains_source_interaction_run_id_interaction_runs_id_fk;
ALTER TABLE chains DROP COLUMN IF EXISTS source_interaction_run_id;
ALTER TABLE messages DROP COLUMN IF EXISTS input_sequence;
ALTER TABLE outbound_batches
  DROP COLUMN IF EXISTS claim_owner,
  DROP COLUMN IF EXISTS claim_token,
  DROP COLUMN IF EXISTS claim_expires_at;
DROP TABLE IF EXISTS interaction_authorization_references;
DROP TABLE IF EXISTS interaction_steers;
DROP TABLE IF EXISTS conversation_states;
DROP TABLE IF EXISTS interaction_runs;
DROP TYPE IF EXISTS interaction_steer_state;
DROP TYPE IF EXISTS interaction_run_state;
DROP TYPE IF EXISTS conversation_actor_state;
```

Dropping these tables deletes actor checkpoints, steer reconciliation state,
authorization snapshots, and encrypted draft output. It does not delete
legacy chains, messages, outbound parts, provider records, or Codex sessions.

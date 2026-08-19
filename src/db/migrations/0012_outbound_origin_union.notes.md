# Migration 0012 compatibility and rollback

## Compatibility

- Apply after `0011_conversation_actor_state`. Existing rows already have a
  non-null `chain_id`, so they satisfy the new exclusive-origin check without
  a data rewrite and retain their parts, cursor, claim, and checkpoint state.
- `chain_id` becomes nullable only so an outbound batch can instead name one
  `interaction_run_id`. Exactly one origin must be present. The interaction
  origin is a cascading foreign key, and the unique indexes permit at most one
  batch per chain or interaction run.
- Chain-origin batches keep the legacy chain-state and cancellation checks and
  complete the chain only after the final materialized part is checkpointed.
- Interaction-origin batches are sendable only while the referenced run is the
  current `finalizing` run for the same space and actor generation. Their final
  checkpoint completes the run, clears the active run, and advances the
  conversation's finalized cursor through the run's accepted sequence.
- New code publishes `outbound.coordinate` and also wakes the in-process
  coordinator immediately. The `outbound.send` queue remains registered only
  so jobs created by an older revision wake that same coordinator.

## Rollback

Prefer an application-only rollback while leaving this forward-compatible
schema in place. An older application continues to create chain-origin rows
with a non-null `chain_id` and ignores `interaction_run_id`.

Before a schema rollback, stop publishers and both outbound workers, confirm no
interaction-origin batch remains, and preserve all chain-origin batches and
parts. Then run:

```sql
DROP INDEX IF EXISTS outbound_batches_interaction_run_unique;
ALTER TABLE outbound_batches
  DROP CONSTRAINT IF EXISTS outbound_batches_interaction_run_id_interaction_runs_id_fk,
  DROP CONSTRAINT IF EXISTS outbound_batches_origin_union;
ALTER TABLE outbound_batches DROP COLUMN IF EXISTS interaction_run_id;
ALTER TABLE outbound_batches ALTER COLUMN chain_id SET NOT NULL;
```

Do not set `chain_id` to not-null while any interaction-origin batch exists.
That would discard or strand its materialized parts and finalization cursor.

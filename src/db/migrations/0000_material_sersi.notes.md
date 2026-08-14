# Migration 0000 compatibility and rollback

## Compatibility

- Requires PostgreSQL 13 or newer, matching pg-boss 12.27.0.
- Uses ordinary enums, partial/expression indexes, JSONB, advisory transaction locks,
  and `FOR UPDATE`; it does not require PostgreSQL 14+ features.
- This is the initial application schema. Run it before accepting any Spectrum
  messages or starting pg-boss workers.
- pg-boss owns its separate `pgboss` schema and migrates it through pg-boss. This
  migration owns only the application tables in `public`.

## Rollback

This initial rollback is intentionally destructive and is safe only before launch or
after a verified database backup/restore point. Stop the service and pg-boss workers,
then drop the application tables in dependency order (or restore the pre-migration
database snapshot):

```sql
DROP TABLE IF EXISTS
  approvals,
  memory_sync_events,
  usage_events,
  failure_events,
  outbound_parts,
  outbound_batches,
  execution_tasks,
  agent_threads,
  carried_messages,
  messages,
  chains,
  space_members,
  spaces,
  channel_identities,
  owners,
  deployments
CASCADE;

DROP TYPE IF EXISTS
  agent_thread_status,
  approval_status,
  chain_state,
  content_type,
  deployment_status,
  execution_task_state,
  identity_role,
  memory_operation,
  message_direction,
  outbound_batch_state,
  outbound_part_state,
  owner_status,
  platform,
  projection_status,
  space_type;
```

Do not drop the `pgboss` schema as part of an application rollback unless all queued
work has been intentionally abandoned and a backup exists.

# Migration 0001 compatibility and rollback

## Compatibility

- Requires PostgreSQL 13 or newer.
- Replaces the initial memory projection uniqueness key so `add` and `update`
  operations with the same owner/content hash deduplicate each other.
- The index rebuild takes a write lock on `memory_sync_events`; apply this before
  enabling Supermemory workers or during a maintenance window on an existing database.
- If preexisting duplicate `(owner_id, content_hash)` rows exist across `add` and
  `update`, reconcile them before applying this migration.

## Rollback

Rollback restores operation-specific uniqueness. It is metadata-only but briefly locks
the table while rebuilding the index:

```sql
DROP INDEX IF EXISTS memory_sync_events_projection_unique;
CREATE UNIQUE INDEX memory_sync_events_projection_unique
  ON memory_sync_events (owner_id, operation, content_hash)
  WHERE operation IN ('add', 'update');
```

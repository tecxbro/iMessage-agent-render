# Migration 0002 compatibility and rollback

## Compatibility

- Requires PostgreSQL 13 or newer.
- Adds the unique `(chain_id, name)` key used to map a model-local task name to
  one durable UUID execution task. This makes delegation commits idempotent and
  prevents a retried plan from creating a second copy of the same logical task.
- Before applying this migration to a database that has accepted orchestration
  traffic, verify there are no duplicate task names inside one chain:

```sql
SELECT chain_id, name, count(*)
FROM execution_tasks
GROUP BY chain_id, name
HAVING count(*) > 1;
```

- If that query returns rows, stop workers and reconcile the duplicate tasks and
  any dependent UUID references before creating the index.

## Rollback

Dropping the index is metadata-only but removes the database-level idempotency
guard. Stop planning workers before rollback, then run:

```sql
DROP INDEX IF EXISTS execution_tasks_chain_name_unique;
```

Do not resume orchestration without an equivalent per-chain logical-task
uniqueness guard.

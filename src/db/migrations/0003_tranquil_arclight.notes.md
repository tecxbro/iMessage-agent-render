# Migration 0003 compatibility and rollback

## Compatibility

- Requires PostgreSQL 13 or newer and a maintenance window for the approval
  constraint/index validation on an existing database.
- Apply after `0002_slippery_rocket_raccoon`; this migration adds the security
  approval and pairing schema without removing the orchestration task-name guard.
- Before applying, expire or otherwise reconcile duplicate active approvals for
  one `execution_task_id`; the new partial unique index permits only one
  `pending` or `approved` row per task.
- Before applying, reconcile legacy approval rows whose action type is not a
  registered Step 7 action or whose action hash is not lowercase SHA-256 hex.
- Approval scope, exact encrypted payload, hash, summary, and expiry become
  database-immutable. Terminal retention may still crypto-shred the payload by
  changing its ciphertext from non-null to null.
- Pairing attempts are intentionally durable for restart-safe brute-force
  accounting. A maintenance job may delete attempts older than the configured
  pairing attempt window.

## Rollback

Rollback removes the trigger, constraints, indexes, pairing tables, and enum.
This deletes pairing challenges and attempts, so disable pairing before rollback:

```sql
DROP TRIGGER IF EXISTS approvals_immutable_request ON approvals;
DROP FUNCTION IF EXISTS protect_approval_request_immutability();
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_consumption_consistent;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_action_type_registered;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_action_hash_sha256;
DROP INDEX IF EXISTS approvals_active_task_unique;
DROP TABLE IF EXISTS pairing_attempts;
DROP TABLE IF EXISTS pairing_challenges;
DROP TYPE IF EXISTS pairing_status;
```

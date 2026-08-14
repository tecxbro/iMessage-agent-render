# Security operations and threat model

This starter treats models, message text, repository files, memories, web pages,
and tool output as untrusted data. Security decisions come from deterministic
application code and authoritative PostgreSQL rows. Prompt instructions are
defense in depth, never an authorization mechanism.

## Trust boundaries

| Boundary | Code-owned control | Failure behavior |
|---|---|---|
| Spectrum sender → accepted inbound | HMAC handle fingerprint, active identity/deployment/owner lookup, role check | Silent unauthorized disposition before persistence or queueing |
| Group message → accepted inbound | Authorized author plus native agent mention, configured textual fallback, or reply to a persisted same-space outbound ID | No task or model work |
| Unknown sender → pairing | Pairing off by default; operator-created salted/scrypt code, ten-minute expiry, persistent per-handle/deployment attempt limits, atomic collaborator creation | Unknown sender remains unauthorized |
| Accepted message → queued execution | Identity is re-read immediately before start; per-owner task limiter and global/per-owner Codex concurrency gates apply | No child process starts |
| Model task → Codex permissions | Requested profile must be a capability subset of the code-owned owner/workspace ceiling; collaborators are capped at read-only | Reject escalation; never downgrade or ask the model |
| Service → Codex CLI | Explicit environment allowlist, controlled `HOME`/`CODEX_HOME`, startup path/mode checks | Startup or construction fails closed |
| Codex CLI → model-spawned shell | `shell_environment_policy.inherit = "none"`, no shell profile, explicit non-secret `PATH`, locale, and workspace `HOME` | Service/API/Codex credentials are unavailable to shell commands |
| Proposed action → pending approval | Code validates action class, canonicalizes exact target/payload, derives the confirmation text, encrypts bytes, and hashes owner/space/task/action | Always pending; model prose cannot approve |
| Owner reply → approval state | Deterministic command interception, active owner identity, exact space, finite expiry, compare-and-set | Collaborators, ambiguity, expiry, replay, and wrong scope fail closed |
| Approved action → execution | Persisted ciphertext is authenticated/decrypted, schema-validated, re-hashed, and consumed atomically with task start | Executor receives only the stored payload; mutation/replay returns no action |
| Runtime data → logs/failures | Sensitive keys, credentials, handles, message bodies, and configured literal secret values are redacted and bounded | Diagnostics omit unsafe detail |

## Roles

- `owner`: may request work and, when still active and unrevoked, approve or
  reject exact actions and create pairing challenges through an authenticated
  operator surface.
- `collaborator`: may request read-only work under group/space policy. A
  collaborator cannot create pairing challenges or approve/reject actions.

Role, identity, owner, and deployment state are re-read from PostgreSQL. Model
output cannot create an identity, select a role, or change these records.

## Approval operations

Consequential classes include destructive filesystem operations, external
sends, purchases, authentication/permission/deployment changes, secret access,
broad network access, and persistent dependency installation.

Use `/approve <uuid>` or `/reject <uuid>`. Plain `yes`/`no` is accepted only
when exactly one live pending request exists in the same space. Approval
commands are intercepted before normal ingest so they cannot supersede the
chain they address. Rejection and expiry cancel the waiting task. Superseding a
chain expires its pending or approved requests.

The database migration installs legal-transition constraints and a trigger that
prevents changes to approval scope, payload, hash, summary, and expiry. Terminal
retention may replace ciphertext with `NULL` to crypto-shred it.

## Pairing operations

Pairing is disabled unless `PAIRING_MODE=on`. Expose
`PairingService.createChallenge(true)` only from a separately authenticated
operator CLI/admin process; never expose it to the message model or normal
inbound handler. Deliver the returned credential through that protected
channel. The database stores only its salt and scrypt-derived hash.

Pairing always creates a collaborator identity bound to the sender handle
fingerprint observed on the `/pair` message. A code is one-use. Failed attempts
are counted durably so restarts do not reset brute-force protection.

## Startup checklist

1. Keep `CODEX_HOME` absolute, private (`0700`), owned by the service account,
   and separate from `AGENT_WORKSPACE_ROOT` and the service `.env` file.
2. Keep `CODEX_HOME/auth.json` a regular service-owned `0600` file in ChatGPT
   mode. Do not put it in a task workspace.
3. Configure an absolute-only minimal `PATH`; empty/relative components fail
   the startup audit.
4. Supply `OPENAI_API_KEY` only in API-key mode. It may reach the Codex CLI but
   is excluded from model-spawned shell environments.
5. Inject database, Photon, encryption, memory, and OpenAI values into the
   value-aware logger/failure redactor. Never log environment snapshots.
6. Keep `MAX_OWNER_EXECUTION_CONCURRENCY` at or below the global maximum and
   set message/task limits appropriate for the deployment.

## Incident response

- Unknown or abusive traffic: leave pairing off, revoke the affected identity,
  and inspect only safe correlation metadata.
- Suspected Codex credential exposure: stop workers, revoke the Codex session,
  remove and recreate `auth.json`, then re-enroll.
- Service secret exposure: rotate the affected Photon/OpenAI/Supermemory/
  database credential and `APP_ENCRYPTION_KEY`; assess encrypted-data recovery
  before rotating the encryption key.
- Approval anomaly: disable the deployment, preserve database audit rows,
  reject/expire active approvals, and do not reconstruct an action from model
  output or logs.
- Database outage: stop untracked execution. Do not fall back to prompts,
  memory, or process-local state for authorization or approvals.

## Verification

Run:

```bash
npm run typecheck
npm run test:security
npm test
POSTGRES_PIPELINE_TEST_DATABASE_URL=postgresql://... npm run test:integration
git diff --check
```

The security suite asserts zero persistence, queue, model, and Codex process
calls for unauthorized paths. The PostgreSQL suite additionally exercises
owner-only compare-and-set, immutable rows, hash/action constraints, revocation,
one-time consumption, supersession, and retention behavior.

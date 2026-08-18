# Operations Runbook

This runbook covers day-two operation of the private single-instance Render deployment. Initial deployment and enrollment instructions live in [Deployment](./DEPLOYMENT.md). The release smoke record lives in [`../test/e2e/render-smoke.md`](../test/e2e/render-smoke.md).

## Current release gate

`npm start` runs the composed lifecycle through `src/server.ts` and `src/runtime/production-bootstrap.ts`. Keep the release blocked until `/readyz` is `200`, an authorized live DM receives one reply, restart/replay checks are recorded, and the remaining Spectrum 12.7 outbound GUID limitation is accepted or removed. A healthy `/healthz` alone is insufficient.

## Routine checks

Run from a trusted operator environment:

```bash
curl --fail --silent "https://<service-host>/healthz"
curl --silent --show-error "https://<service-host>/readyz"
```

Expected composed-service states:

- `/healthz` is HTTP 200 whenever the Node process can serve diagnostics.
- `/readyz` is HTTP 200 only when every critical component is `ok`.
- `/readyz` is HTTP 503 during shutdown, missing owner setup, missing/expired Codex auth, database failure, migration/queue failure, invalid disk/workspace storage, or Spectrum disconnect.
- Supermemory may be `disabled` or `degraded` without blocking the operational pipeline.

The public readiness response is limited to safe aggregate state. Authenticate to the dashboard for provider and component detail. If any unauthenticated response contains a device code, verification URL, assigned number, owner information, provider error, credential, message, database URL, setup action, or private path, treat that as a security incident.

## Operator dashboard access

Retrieve `DASHBOARD_SETUP_SECRET` only from the private Render Web Service **Environment** page and enter it in the dashboard's **Deployment setup code** field. Successful authentication creates an eight-hour server-side session; the service retains at most eight active sessions, and the cookie contains only an opaque identifier. Setup mutations additionally require the session-bound CSRF token and same-origin request checks.

Log out after setup or diagnostics on a trusted browser. Logout revokes the session immediately. Eight-hour expiration and service restart also end a session; sign in again instead of weakening the boundary or trying the removed `x-agent-setup` header.

After login, the owner card shows either the setup form or only the masked active phone. Saving or changing it uses the operator session, session-bound CSRF token, and same-origin checks. The saved personal phone is the only authorized sender; the separately assigned Photon number is the destination shown at completion.

To replace the owner, open **Change phone number**, save the new E.164 value, and verify one message from the new owner plus rejection of the previous owner. The replacement transaction activates the new encrypted identity and revokes all prior owner-phone identities while leaving collaborator identities unchanged. Never place a phone in a URL, log, or support ticket.

## Deploy procedure

1. Record the outgoing application commit and current `/readyz` response.
2. Read new migration notes and confirm backward compatibility.
3. Confirm a database recovery point exists.
4. Validate `render.yaml` in an authenticated Render CLI workspace:

   ```bash
   render workspace set
   npm run render:validate
   ```

5. Run the required local test suite and record skipped tests.
6. Deploy the reviewed commit. Confirm the pre-deploy migration succeeds before the service starts.
7. Require `/healthz` HTTP 200 and `/readyz` HTTP 200.
8. Send one authorized, non-mutating test message only after readiness passes.
9. Restart the service and repeat readiness plus one follow-up turn.

The Render CLI requires an explicit/default workspace. A validation attempt without one is not Blueprint validation evidence.

## Graceful restart

Render sends `SIGTERM` using its platform-managed shutdown delay for this disk-backed service. The composed bootstrap marks readiness false and aborts active work before running stop hooks in this order:

1. Spectrum receive loop.
2. Active Codex work.
3. Outbound cursor checkpoint.
4. pg-boss workers.
5. PostgreSQL connections.
6. HTTP listener.

After restart, require reconciliation of undrained inbound messages, queued planning chains, and resumable outbound batches before readiness returns to 200. Verify no stale chain sends and no outbound cursor moves backward.

Operator sessions are held in bounded server memory and are closed during graceful shutdown. A restart invalidates every dashboard session; this does not affect Photon, Codex, queue, database, memory, or owner identity state.

## Incident playbooks

### Codex auth missing or expired

Symptoms: `/healthz` 200; public `/readyz` 503; the authenticated dashboard reports Codex authentication needs attention; Spectrum startup remains paused.

ChatGPT mode:

```bash
npm run codex:login
npm run codex:status
```

Complete device login, verify `$CODEX_HOME/auth.json` remains mode `0600`, then restart and rerun capability probes.

API-key mode: replace `OPENAI_API_KEY` in Render, restart, and rerun capability probes. Do not change `CODEX_AUTH_MODE` as a fallback unless that is an explicit operator decision.

### Owner identity missing or legacy migration required

Symptoms: `/healthz` 200; public `/readyz` 503; Spectrum intake remains stopped; the authenticated dashboard asks for an owner phone.

For a fresh deployment, save the personal owner phone in E.164 form and continue to Photon. For an existing deployment, first verify whether `OWNER_PHONE_NUMBER`, the former long Render alias, or `AGENT_OWNER_HANDLES` is present. The runtime imports only one unambiguous E.164 value and never imports from Photon credentials. If multiple handles or an email-only handle caused migration-required state, authenticate to the dashboard and save the intended phone explicitly. Verify the masked status and an authorized message before manually removing old environment values.

### Spectrum disconnect

Symptoms: public `/readyz` 503; the authenticated dashboard or private logs report `SPECTRUM_STREAM_DISCONNECTED` or `SPECTRUM_STREAM_RESTART_EXHAUSTED`.

1. Check Photon provider status and the Web Service's Spectrum credentials without printing them.
2. Allow the bounded supervised reconnect policy to run.
3. If exhausted, restart after provider recovery.
4. Verify reconciliation and route rehydration from persisted space GUID/route phone.
5. Confirm one authorized DM and check for duplicate outbound parts.

### PostgreSQL timeout/outage

Symptoms: `/healthz` 200; public `/readyz` 503; authenticated diagnostics or private logs report `DATABASE_UNAVAILABLE`; downstream startup stages do not run.

1. Stop manual message execution.
2. Check Render Postgres health and the dynamic `DATABASE_URL` reference.
3. Restore connectivity and verify migrations.
4. Restart the service.
5. Run reconciliation and inspect safe failure counts/correlation IDs.
6. Confirm queued work resumes exactly once.

### Supermemory timeout/outage

Symptoms: the authenticated dashboard or private logs report memory recall unavailable/degraded; core readiness can remain healthy.

This is the required operating policy. The dedicated memory-provider outage exercise has not been recorded as protected release evidence. Incidental fake-provider coverage in a broad offline suite is not accepted as outage validation.

1. Do not stop operational messaging solely for memory unavailability.
2. Verify planning used an empty memory context rather than stale cross-owner data.
3. Leave projection jobs retryable; inspect redacted receipt/failure codes.
4. After recovery, verify a bounded recall and one temporary add/search/delete smoke item in a test owner container.
5. Never replay raw messages into Supermemory.

### Persistent disk missing or invalid

Symptoms: public `/readyz` 503; authenticated diagnostics or private logs report `PERSISTENT_STORAGE_INVALID`.

1. Stop execution; do not create replacement Codex threads on ephemeral storage.
2. Verify the `/var/data` mount, ownership, space, and directory permissions.
3. If the disk is lost, revoke potentially exposed credentials, attach replacement storage, and re-enroll Codex.
4. Recreate workspaces from trusted remotes/backups.
5. Resume from bounded PostgreSQL summaries.

### Partial outbound batch

1. Do not reset the outbound cursor manually.
2. Restore Spectrum connectivity.
3. Let the resumable batch job claim the persisted `start_index`.
4. Confirm every retry uses the materialized part's original client GUID.
5. Compare database part states with visible provider results; preserve evidence of any provider-level duplicate.

## Rollback

Roll back application and schema independently.

1. Stop new execution and let graceful shutdown checkpoint state.
2. Select the last known-good application commit compatible with the **current** schema.
3. Roll back the Render deploy to that commit.
4. Do not undo forward-compatible migrations merely to match code.
5. If schema rollback is mandatory, stop all workers, verify a backup/recovery point, and use only the SQL in the migration's `.notes.md`.
6. Restart, reconcile, verify both health endpoints, and run a non-mutating authorized turn.

If compatibility is uncertain, roll forward with a fix or restore the application and database together to a matched recovery point. The initial migration rollback is destructive and must not be used on a live database without an explicit data-loss decision.

## Auth transfer and re-enrollment

When ownership changes or a credential may be exposed:

1. Stop the service.
2. Revoke the old ChatGPT session/API key and rotate the dashboard setup secret, Photon, Supermemory, encryption, and database credentials as applicable.
3. Remove only the compromised Codex auth file after confirming the exact persistent path; do not delete the disk or workspace tree.
4. Run the appropriate enrollment flow.
5. Verify credential file permissions, status, capability probes, restart persistence, and readiness.
6. Review failure/audit logs for unexpected use, without copying private payloads.

## Setup-code rotation and recovery

Rotate `DASHBOARD_SETUP_SECRET` when it is exposed, shared beyond authorized operators, or an operator's Render access changes:

1. Open the Web Service's private **Environment** page in Render.
2. Regenerate or replace `DASHBOARD_SETUP_SECRET` with new high-entropy material.
3. Save the environment change and redeploy or restart the service.
4. Confirm the old code is rejected and authenticate with the replacement.
5. Log out other trusted browsers or rely on the restart to invalidate their in-memory sessions.

If the code is lost, follow the same Render-side replacement procedure. Blueprint synchronization preserves an existing generated value and is not a rotation mechanism. There is intentionally no public email, URL, or browser-based reset flow.

## Evidence and escalation

Record timestamps, commit, Render deploy ID, public aggregate readiness, authenticated redacted diagnostic states, correlation IDs, tests run, and whether a live provider was actually exercised. Never paste raw messages, setup codes, session identifiers, CSRF tokens, device codes, secrets, auth files, phone/email handles, or full provider exceptions into incident tickets.

Escalate and keep execution paused when:

- authorization or outbound routing cannot be proven;
- PostgreSQL state is unavailable or inconsistent;
- a stale/canceled chain sends;
- an outbound retry changes client GUID;
- credentials appear in logs or health responses;
- the old application/schema compatibility is unknown; or
- executable composition does not match the reviewed `src/server.ts` and `production-bootstrap.ts` release.

# Clean Local and Render Release Smoke

Use this file as an evidence record, not as a statement that a check passed. Mark every row `PASS`, `FAIL`, `BLOCKED`, or `NOT RUN`, then attach redacted output. Never store secrets, auth files, owner handles, raw messages, database URLs, or full provider errors here.

## Release identity

| Field | Evidence |
|---|---|
| Reviewer | |
| UTC date/time | |
| Commit SHA | |
| Branch/tag | |
| Node/npm versions | |
| PostgreSQL version | |
| Render CLI version/workspace | |
| Render deploy ID | |

## Known blocker on `feat/render-docs`

`src/index.ts` provides the final injectable lifecycle, but `npm start` still executes `dist/server.js` built from the foundation `src/server.ts`. The current production entrypoint exposes `/healthz` and a redacted `/readyz`, but it does not compose the queue, Spectrum, Codex, memory, or security handlers, so readiness never becomes true. Therefore clean first-message, ready-state, restart-resume, and live Render agent gates must remain `BLOCKED` until the integration owner wires the production composition.

## A. Offline preflight

Run from a clean checkout:

```bash
git status --short --branch
npm ci
npm run typecheck
npm test
npm run test:chaos
git diff --check
```

Database integration tests require a disposable database and truncate application tables:

```bash
POSTGRES_PIPELINE_TEST_DATABASE_URL=postgresql://<test-user>:<test-password>@127.0.0.1:5432/<disposable-test-db> npm run test:integration
```

Blueprint validation requires an authenticated/default Render workspace:

```bash
render workspace set
npm run render:validate
```

| Check | Status | Evidence/notes |
|---|---|---|
| Clean dependency install | | |
| Typecheck | | |
| Unit/contract tests | | |
| Database integration tests (not skipped) | | |
| Chaos suite | | |
| `git diff --check` | | |
| Render Blueprint validation | | |
| Secret scan | | |

If Render CLI reports `no workspace specified and no default workspace set`, mark Blueprint validation `BLOCKED`; the YAML has not been validated.

## B. Clean local install

Follow [`../../DEPLOYMENT_AND_AUTH.md`](../../DEPLOYMENT_AND_AUTH.md), including a dedicated PostgreSQL database, absolute non-overlapping storage paths, and one explicit Codex auth mode.

```bash
npm run db:migrate
npm run codex:status
npm run dev
curl --fail --silent http://127.0.0.1:10000/healthz
curl --silent --show-error http://127.0.0.1:10000/readyz
```

| Check | Expected | Status | Evidence/notes |
|---|---|---|---|
| Migration | exits 0; checked-in migrations applied once | | |
| `CODEX_HOME` | absolute directory, mode `0700` | | |
| Workspace root | separate absolute directory, mode `0700` | | |
| Codex auth | chosen mode reported; no secret printed | | |
| `/healthz` | HTTP 200 | | |
| `/readyz` | HTTP 200 only after full composition | | |
| Authorized first message | one terminal response | | |
| Unknown sender | zero Codex child processes | | |

On the current branch, `/readyz` is expected to return HTTP 503. Its endpoint/redaction check can pass, but ready-state and both message checks remain `BLOCKED` by the uncomposed production entrypoint.

## C. Clean Render Blueprint

Create the Blueprint in a fresh Render workspace from the exact commit above.

| Check | Expected | Status | Evidence/notes |
|---|---|---|---|
| Resource count | one Web Service, one Postgres database | | |
| Web plan/instances | paid service, exactly one instance | | |
| Disk | one disk at `/var/data` | | |
| Codex path | `CODEX_HOME=/var/data/codex` | | |
| Workspace path | `AGENT_WORKSPACE_ROOT=/var/data/workspaces` | | |
| Database wiring | `DATABASE_URL` dynamic reference; no manual URL | | |
| Required prompts | Photon project ID/secret plus application owner handles; no literal secrets in Blueprint | | |
| Optional Supermemory | absent from initial prompts; add `SUPERMEMORY_API_KEY` to the service only when enabled | | |
| Build | `npm ci --include=dev && npm run build` exits 0 | | |
| Pre-deploy | `npm run db:migrate` exits 0 | | |
| Start | `npm start` binds Render `PORT` | | |
| Liveness | external `/healthz` HTTP 200 | | |
| Initial readiness | 503 only for expected missing auth/dependency | | |

Do not record the Render deployment as cleanly functional while `npm start` uses the foundation entrypoint.

## D. Codex enrollment and restart persistence

### ChatGPT mode

In private Render Shell:

```bash
npm run codex:login
npm run codex:status
test -f "$CODEX_HOME/auth.json"
chmod 600 "$CODEX_HOME/auth.json"
```

Restart/redeploy, then rerun `npm run codex:status` and inspect `/readyz`. Device login must be enabled by the ChatGPT account/workspace. Do not attach the URL code, token, or `auth.json`.

### API-key mode

Add `OPENAI_API_KEY` as a Render secret, set `CODEX_AUTH_MODE=api_key`, restart, and run the protected capability probe. Do not run device login and do not print the key.

| Check | Status | Evidence/notes |
|---|---|---|
| Chosen auth mode enforced | | |
| Status/capability probe passes | | |
| Credentials survive restart (ChatGPT mode) | | |
| `/readyz` becomes 200 after all critical components | | |
| Expired/revoked auth pauses execution | | |
| Re-enrollment restores readiness | | |

## E. Protected live provider tests

These are opt-in and must stay `NOT RUN` unless real credentials/accounts and an authorized test recipient are configured.

Codex account smoke:

```bash
RUN_CODEX_LIVE=1 npm test -- test/e2e/codex-live.test.ts
```

Spectrum authorized DM smoke:

```bash
SPECTRUM_LIVE_TEST=true npm test -- test/live/spectrum-dm.test.ts
```

The Spectrum test also requires every documented `SPECTRUM_LIVE_*` value in a protected environment. Supermemory requires a separate add/search/delete item in a test owner container; no protected Supermemory live script is currently checked in, so mark it `BLOCKED` or `NOT RUN` rather than substituting fake-provider results.

The dedicated memory-provider outage/Supermemory-timeout resilience exercise was intentionally skipped by user direction for this Step 8 run. Preserve it as `NOT RUN`; incidental fake-provider coverage in a broad offline suite is not accepted as outage validation, and the expected invariant below remains policy unless a later authorized run supplies evidence.

| Provider | Status | Exact test/evidence | Live claim allowed? |
|---|---|---|---|
| Render | | clean Blueprint/deploy/restart record | only if passed |
| Photon/Spectrum | | protected authorized DM | only if passed |
| Codex | | protected schema-bound run | only if passed |
| Supermemory | | protected add/search/delete | only if passed |

## F. Failure and recovery matrix

For process-kill tests, use a staging deployment/test database. Record the durable row/job state immediately before the kill, kill only the Web Service process/instance, restart it, and capture the reconciled terminal state. A test-only failure hook must be deterministic and excluded from production. If the integrated release has no hook at a stage, mark that stage `BLOCKED`; do not simulate it only in prose.

| Failure point | Injection/evidence requirement | Expected invariant | Status |
|---|---|---|---|
| Receive | fail queue schedule after accepted DB insert; run `npx vitest run test/chaos/durable-stage-recovery.test.ts` | durable message is reconciled into one flush | |
| Debounce | kill after accepted rows exist while flush is delayed | rows remain undrained; one movable per-space flush resumes | |
| Planning | kill after chain enters planning and before decision commit | same chain/version retries or is superseded; no stale outbound | |
| Execution | kill one active execution worker | bounded retry/failure; canceled chain cannot synthesize/send | |
| Synthesis | kill after terminal task scan and before/after singleton enqueue | exactly one synthesis job/outbound batch | |
| Outbound part 1..N | for every materialized part, kill after provider acknowledgement and before cursor checkpoint; run `npx vitest run test/chaos/outbound-restart.test.ts` | retry uses identical client GUID; cursor only advances after checkpoint | |
| Memory write | timeout/fail after operational response completes | response remains complete; safe receipt/failure is retryable | |
| Spectrum disconnect | run `npx vitest run test/chaos/service-lifecycle.test.ts -t "surfaces a Spectrum disconnect"` | readiness 503; bounded reconnect; no leaked provider data | |
| Database timeout | run `npx vitest run test/chaos/database-timeout.test.ts` | liveness 200, readiness 503, no downstream startup | |
| Supermemory timeout | intentionally skipped by user direction; optional later command: `npx vitest run test/integration/memory-isolation.test.ts -t "MEMORY_PROVIDER_TIMEOUT"` | policy: planning continues with explicit empty degraded context | NOT RUN |
| Expired Codex auth | run `npx vitest run test/chaos/service-lifecycle.test.ts -t "Codex auth expires"` | Spectrum intake paused; safe re-enrollment action | |
| Graceful SIGTERM | run `npx vitest run test/chaos/service-lifecycle.test.ts -t "gracefully checkpoints"` | readiness false; abort/checkpoint/close order completes | |

The fake transport verifies stable retry GUIDs; only a live provider test can establish the provider's visible deduplication behavior.

## G. End-to-end restart

After the composed entrypoint exists:

1. Send an authorized turn that establishes a Codex thread and one non-sensitive durable preference.
2. Record terminal chain/outbound state using safe IDs only.
3. Restart the Render Web Service normally.
4. Require `/healthz` and `/readyz` HTTP 200.
5. Send a follow-up that requires prior context.
6. Verify the persisted thread or bounded recovery summary is used, the memory remains owner-scoped, and no outbound part duplicates.
7. Repeat after a hard process kill during each stage in section F.

| Check | Status | Evidence/notes |
|---|---|---|
| Graceful restart recovery | | |
| Hard restart recovery | | |
| Codex auth persistence | | |
| Workspace persistence | | |
| Queue reconciliation | | |
| Outbound no-duplicate evidence | | |
| Owner-scoped memory continuity | | |

## H. Rollback drill

1. Record current and prior commits.
2. Read all intervening migration notes.
3. Verify a database recovery point.
4. Stop new execution and allow graceful shutdown.
5. Deploy the prior commit only if it supports the current schema.
6. Reconcile, verify both health endpoints, and send one authorized non-mutating turn.
7. If schema rollback is required, stop all workers and use only the checked-in migration rollback SQL.

| Check | Status | Evidence/notes |
|---|---|---|
| Prior app/schema compatibility proven | | |
| Graceful stop/checkpoint | | |
| Prior application deploy | | |
| Reconciliation | | |
| Post-rollback authorized turn | | |
| No queue/outbound corruption | | |

## Final release decision

| Gate | Status | Reason/evidence |
|---|---|---|
| Clean local | | |
| Clean Render | | |
| Restart recovery | | |
| Every failure stage | | |
| Security/secret boundary | | |
| Documentation commands copied exactly | | |

**Decision:** `GO` / `NO-GO`

A `GO` requires every required gate to pass. Any uncomposed entrypoint, skipped required database test, missing failure-stage evidence, or unsupported live-provider claim is `NO-GO`.

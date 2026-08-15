# Build Your Own iMessage Codex Agent

A production-oriented, single-owner iMessage agent starter built around Photon Spectrum Cloud, Codex, PostgreSQL/pg-boss, and optional Supermemory.

## Release status

This branch contains the Render Blueprint, database migrations, durable transport/queue/runtime modules, persistent-storage preparation, component readiness, and graceful-shutdown composition boundary. It is **not yet a clean-account, zero-to-first-message release**:

- `src/index.ts` defines the final injected boot and shutdown order.
- `src/http/server.ts` implements `/healthz` and `/readyz` for the composed service.
- `src/server.ts`, which is still the executable used by `npm run dev` and `npm start`, exposes the foundation health/readiness shell but does not start operational dependencies.
- The final authorization and plan/execute/synthesize handlers are not composed into that entrypoint.

Consequently, a local start or Render deploy of this branch can prove the foundation process is alive, but it cannot yet accept an authorized iMessage and complete an agent turn. The protected Render, Photon, Codex, and Supermemory live tests have not been run for this release. See [Evidence and release gate](#evidence-and-release-gate).

## Architecture at a glance

```text
Authorized iMessage owner
  ↕
Photon Spectrum Cloud (persistent app.messages gRPC stream)
  ↓
Authorize, deduplicate, persist, and debounce
  ↓
PostgreSQL + pg-boss durable pipeline
  ↓
Interaction Codex thread
  ├─ direct answer
  └─ bounded named execution threads
  ↓
Materialized outbound parts + restart-safe cursor
  ↓
Photon Spectrum Cloud

Successful turn ──> optional curated Supermemory projection
```

PostgreSQL is the operational source of truth. Supermemory is a bounded semantic projection and is never the queue, authorization store, or delivery ledger. Codex credentials and workspaces live in separate directories on the persistent disk.

Read [ARCHITECTURE.md](./ARCHITECTURE.md) for component boundaries, boot/shutdown order, recovery behavior, and extension points.

## Deployment shape

The checked-in [render.yaml](./render.yaml) declares:

- one paid Render Web Service, pinned to one instance;
- one Render PostgreSQL database, wired through a dynamic `DATABASE_URL` reference;
- one persistent disk mounted at `/var/data`;
- `CODEX_HOME=/var/data/codex`;
- `AGENT_WORKSPACE_ROOT=/var/data/workspaces`;
- `npm run db:migrate` as the pre-deploy command;
- `/healthz` as the Render health-check path; and
- a 120-second maximum shutdown delay.

The disk makes the v1 deployment single-instance. Do not enable horizontal scaling without redesigning credential and workspace storage.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://dashboard.render.com/blueprint/new?repo=https://github.com/tecxbro/iMessage-agent-render)

Deploy the private agent infrastructure to Render. After deployment, ChatGPT mode requires one private Codex device-login step in Render Shell. The button provisions infrastructure; it does not make the current branch end-to-end ready or authenticate private provider accounts.

## Configuration

Start from [.env.example](./.env.example). The environment loader validates all values together and refuses unsafe or overlapping storage paths.

| Setting | Purpose |
|---|---|
| `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET` | Photon project with Spectrum Cloud iMessage configured |
| `DATABASE_URL` | PostgreSQL connection; supplied dynamically by Render |
| `AGENT_OWNER_HANDLES` | Comma-separated E.164 numbers or email addresses allowed to use the private agent |
| `DEPLOYMENT_ID` | Stable local UUID; on Render it is derived from `RENDER_SERVICE_ID` when omitted |
| `APP_ENCRYPTION_KEY` | 32-byte base64 or 64-character hexadecimal application key |
| `CODEX_HOME` | Absolute private directory for Codex config, auth, and sessions |
| `AGENT_WORKSPACE_ROOT` | Separate absolute directory for agent workspaces |
| `CODEX_AUTH_MODE` | `chatgpt` or `api_key` |
| `OPENAI_API_KEY` | Required only in API-key mode |
| `SUPERMEMORY_API_KEY` | Optional; leave empty to disable semantic memory |

Never commit `.env`, `$CODEX_HOME/auth.json`, provider credentials, database URLs, or workspace data.

## Clean local installation

### Prerequisites

- Node.js 22.12 through 22.x, or Node.js 24 or newer. Node 23 is not supported by the pinned test runner.
- PostgreSQL and a database the service can migrate.
- A Photon project configured for Spectrum Cloud iMessage.
- Codex authentication through ChatGPT device auth or an OpenAI API key.
- A Supermemory key only if semantic memory is enabled.

### Install and configure

```bash
git clone https://github.com/tecxbro/iMessage-agent-render.git
cd iMessage-agent-render
cp .env.example .env
npm ci
```

Edit `.env` before continuing:

1. Set the Photon credentials, PostgreSQL URL, and authorized owner handles.
2. Generate `APP_ENCRYPTION_KEY` with `openssl rand -base64 32`.
3. Generate a stable local UUID for `DEPLOYMENT_ID`.
4. Set `CODEX_HOME` and `AGENT_WORKSPACE_ROOT` to two separate, non-overlapping absolute paths. Values such as `$PWD` are not expanded inside `.env`; write the resolved paths.
5. Choose one Codex auth mode below.
6. Leave `SUPERMEMORY_API_KEY` empty if memory should be disabled.

Apply the checked-in forward migrations:

```bash
npm run db:migrate
```

### ChatGPT device-login mode

Set:

```dotenv
CODEX_AUTH_MODE=chatgpt
```

The login script needs the same `CODEX_HOME` as the service. Export its resolved value in the shell, then enroll and verify:

```bash
export CODEX_HOME=/absolute/path/from-your-env-file
npm run codex:login
npm run codex:status
```

The pinned command is `codex login --device-auth`. Treat `$CODEX_HOME/auth.json` as a password. The persistent-storage preparation code requires private directory/file permissions and configures file-backed credentials for headless operation.

### API-key mode

Set:

```dotenv
CODEX_AUTH_MODE=api_key
OPENAI_API_KEY=replace-with-a-secret
```

Do not run device login in this mode. The key is supplied only to the Codex child process through its explicit environment allowlist and must not be written to the persistent disk.

### Validate and start

```bash
npm run typecheck
npm test
npm run test:integration
npm run dev
```

On the current branch, `npm run dev` starts the foundation `src/server.ts` entrypoint. It exposes both health endpoints, but it does **not** exercise the operational startup stages, Spectrum receive loop, Codex runtime, or first-message flow. The expected current checks are:

```bash
curl --fail http://localhost:10000/healthz
curl --fail http://localhost:10000/readyz
```

`/healthz` means the HTTP process is alive. `/readyz` means all critical components are ready; it should remain `503` with redacted remediation while Codex enrollment, database, queue, storage, capabilities, or Spectrum connectivity is incomplete.

Because the current entrypoint never starts those dependencies, its `/readyz` remains `503`. Do not use a `200` response from `/healthz` as deployment acceptance evidence. After the integration owner wires the final bootstrap into the executable entrypoint, `/readyz` must become `200` before message execution.

## Clean Render deployment

1. Fork the repository or open the Deploy to Render link above.
2. Review the Blueprint before applying it. It creates one Web Service, one PostgreSQL database, and one disk; `autoDeployTrigger` is intentionally off.
3. Enter Photon credentials and authorized owner handles in the secret prompts. Add `SUPERMEMORY_API_KEY` only when memory is enabled.
4. For API-key mode, change `CODEX_AUTH_MODE` to `api_key` and add `OPENAI_API_KEY` as a Render secret before starting execution.
5. Let the pre-deploy command run `npm run db:migrate` and the build run `npm ci && npm run build`.
6. In ChatGPT mode, open the private Render Shell and run:

   ```bash
   npm run codex:login
   npm run codex:status
   ```

7. Restart the service so the final composed readiness probe can re-check auth and model/effort capabilities.
8. Check `/healthz` and `/readyz`. Do not send a test message until `/readyz` is `200` on an integration build that actually uses `startAgentService`.
9. From an authorized handle, send a DM, confirm exactly one reply, restart the service, and send a follow-up. Record this as protected live evidence; it is not established by the current branch.

In ChatGPT mode, device credentials are stored under `/var/data/codex`. In API-key mode, the key remains a Render secret environment variable. Render Shell access should remain private to operators.

## Health, shutdown, and recovery

The final composition boundary starts liveness first, then prepares configuration and storage, connects the database, checks migrations, starts the queue, probes Codex auth/capabilities, configures optional memory, and only then starts Spectrum. Missing or expired Codex auth keeps liveness healthy while readiness stays false and message execution remains paused.

On `SIGTERM` or `SIGINT`, the shutdown coordinator drops readiness, aborts active work, and runs bounded hooks in this order: Spectrum, Codex, outbound checkpoint, queue, database, then HTTP. A critical cleanup failure produces only a redacted failure code and a nonzero process exit status.

Recovery relies on two durable locations:

- PostgreSQL stores accepted messages, chains, queue state, approvals, thread identifiers/summaries, outbound materialization/cursor state, and memory receipts.
- The persistent disk stores Codex auth/session files and workspaces.

Provider outages must degrade safely: Spectrum reconnects with bounded backoff, PostgreSQL loss makes the service not ready and stops untracked execution, Supermemory recall times out and the turn may continue without memory, memory writes retry independently, and expired Codex auth pauses new execution until re-enrollment.

## Rollback

1. Disable deploys and record the currently running commit and migration level.
2. Back up PostgreSQL before any migration that rewrites encrypted content or identity data.
3. Choose a prior application revision explicitly documented as compatible with the **current** forward schema.
4. Redeploy that revision from Render. Do not run speculative down migrations and do not delete pg-boss tables, durable messages, outbound cursors, or the persistent disk.
5. Confirm `/healthz`, then inspect `/readyz` and redacted logs before resuming message execution.
6. If Codex credentials were revoked or the disk changed, run `npm run codex:login` and `npm run codex:status` again in the private shell.
7. Exercise a non-destructive authorized DM and a restart-recovery turn before calling the rollback healthy.

If an older application is not compatible with the current database schema, roll forward with a compatibility fix instead. Migration-specific compatibility notes live beside the SQL files in `src/db/migrations/`.

## Evidence and release gate

Automated fake/unit/integration tests can establish module invariants such as storage permissions, redacted readiness, bounded shutdown, durable queue singleton keys, stable outbound client GUIDs, and transport reconnect state. They are not substitutes for protected provider tests. Supermemory timeout/outage validation was intentionally skipped by user direction in this release work; the documented behavior remains an expected contract, not evidence.

This branch has no recorded clean-account evidence for:

- a fresh Render Blueprint deployment;
- a live Photon/Spectrum authorized DM;
- a live authenticated Codex turn or restart resume; or
- a live Supermemory add/search/delete cycle.

The release gate remains open until an integration build composes the executable pipeline and a clean-room reviewer completes the local and Render flows, every failure point in [TEST_PLAN.md](./TEST_PLAN.md), rollback, and restart recovery. Do not describe any provider path as live-working before that evidence exists.

## Documentation

| File | Purpose |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Runtime topology, ownership boundaries, recovery, extension points |
| [DEPLOYMENT_AND_AUTH.md](./DEPLOYMENT_AND_AUTH.md) | Detailed deployment and Codex authentication policy |
| [docs/OPERATIONS.md](./docs/OPERATIONS.md) | Restart, outage, rollback, and credential runbooks |
| [docs/llms.txt](./docs/llms.txt) | LLM-oriented local implementation documentation index |
| [test/e2e/render-smoke.md](./test/e2e/render-smoke.md) | Clean local/Render evidence checklist and release decision |
| [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) | Eight implementation steps and release gates |
| [TEST_PLAN.md](./TEST_PLAN.md) | Unit, integration, protected E2E, chaos, and documentation tests |
| [SECURITY_AND_PRIVACY.md](./SECURITY_AND_PRIVACY.md) | Identity, sandbox, approvals, secrets, retention |
| [SECURITY.md](./SECURITY.md) | Implemented security boundaries, operator checks, and incident response |
| [DATA_MODEL.md](./DATA_MODEL.md) | PostgreSQL schema and durable state model |
| [MODEL_ROUTING.md](./MODEL_ROUTING.md) | Model profiles and capability probing |
| [PROMPTING_AND_ORCHESTRATION.md](./PROMPTING_AND_ORCHESTRATION.md) | Interaction/execution contracts |
| [DECISIONS.md](./DECISIONS.md) | Architecture decision records |
| [DOCS_INDEX.md](./DOCS_INDEX.md) | LLM-friendly primary documentation index |
| [AGENTS.md](./AGENTS.md) | Repository rules for implementation agents |

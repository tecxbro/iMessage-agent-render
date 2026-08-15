# Build Your Own iMessage Codex Agent

Deploy a private iMessage agent powered by Photon Spectrum, Codex, PostgreSQL, and optional Supermemory.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/tecxbro/iMessage-agent-render)

> This provisions a paid Render Web Service, a Render PostgreSQL database, and a persistent disk. The deployed web URL is an operator status page. You talk to the agent through iMessage.

## Before you deploy

You need:

- a Photon project with Spectrum Cloud iMessage configured;
- the phone number or email address allowed to message the agent;
- either a ChatGPT account with Codex device login enabled or an OpenAI API key; and
- an optional Supermemory API key if you want semantic memory.

Review current Render pricing before deploying. The Blueprint creates paid resources and intentionally keeps the Web Service at one instance because its Codex credentials and workspaces live on an attached disk.

## Deploy in five steps

1. Click **Deploy to Render** above.
2. Enter the Spectrum project ID, Spectrum secret, and authorized owner handle when Render prompts for them. Add a Supermemory API key or leave it blank.
3. Let Render create the Web Service, PostgreSQL database, persistent disk, and application encryption key. The pre-deploy command applies the checked-in database migrations.
4. Open the Web Service's private **Manage > Shell** and run `npm run codex:login`, followed by `npm run codex:status`. If you choose API-key mode instead, set `CODEX_AUTH_MODE=api_key` and add `OPENAI_API_KEY` as a Render secret.
5. Confirm `/readyz` returns HTTP 200, then message the agent from the authorized iMessage handle.

Render keeps auto-deploys off for template-created services. Deploy reviewed updates manually so a push to the original template cannot redeploy every user's copy.

## Finish Codex authentication

### ChatGPT device login

The default `CODEX_AUTH_MODE` is `chatgpt`.

1. Open the deployed **Web Service** in Render.
2. Open **Manage > Shell**. Do not use Connect/SSH for this flow.
3. Run:

   ```bash
   npm run codex:login
   npm run codex:status
   ```

4. Open the displayed device-auth URL in a trusted browser, sign in, and enter the one-time code.
5. Restart the service, then run `npm run codex:status` again.

ChatGPT credentials persist under `/var/data/codex`. Treat `auth.json` like a password: never print it, copy it into a ticket, or commit it.

### OpenAI API key

Set these Web Service environment variables and redeploy:

```dotenv
CODEX_AUTH_MODE=api_key
OPENAI_API_KEY=replace-with-a-Render-secret
```

API-key mode does not require device login. The runtime supplies the key only to the Codex child process through an explicit environment allowlist.

## Verify the deployment

Open the Render service URL or check the endpoints directly:

```bash
curl --fail --silent "https://<service-host>/healthz"
curl --silent --show-error "https://<service-host>/readyz"
```

- `/healthz` returning 200 means the HTTP process is alive.
- `/readyz` returning 200 means critical storage, PostgreSQL, migration, queue, Codex, and Spectrum checks are ready.
- `/readyz` returning 503 means setup is incomplete or a dependency is degraded. Its response contains redacted component states and safe next actions.

The root URL is an operator status page, not an iMessage chat or Photon enrollment link. It must never display credentials, owner handles, message content, provider errors, database URLs, or private paths.

## Send the first iMessage

After `/readyz` is 200:

1. Send a direct iMessage to the Spectrum-connected line from a phone number or email listed in `AGENT_OWNER_HANDLES`.
2. Confirm the agent sends one terminal response.
3. Send from an unauthorized handle and confirm no Codex process starts.
4. Restart the Web Service, wait for `/readyz` to return 200, and send a follow-up.

Record protected live evidence before describing any provider path as live-working. Offline tests and a healthy `/healthz` are not substitutes for an authorized live message.

## What gets deployed

The checked-in [`render.yaml`](./render.yaml) creates:

- one paid Node Web Service in Oregon on the Starter plan;
- one Render PostgreSQL 18 database on the Basic 256 MB plan;
- one 1 GB persistent disk mounted at `/var/data`;
- `/var/data/codex` for Codex credentials and sessions;
- `/var/data/workspaces` for agent workspaces;
- a generated application encryption key;
- a dynamic `DATABASE_URL` from the attached database;
- `npm run db:migrate` before each deploy; and
- `/healthz` as Render's liveness check.

The disk makes this version single-instance. Do not enable horizontal scaling without redesigning credential and workspace ownership.

## Customize your agent

The most common edits are:

| Goal | File or setting |
|---|---|
| Personality and conversational style | `prompts/interaction.system.md`, `prompts/voice-policy.md` |
| Execution behavior | `prompts/execution.system.md` |
| Approval rules | `prompts/approval-policy.md` |
| Models and reasoning effort | `.env` model variables |
| Authorized senders | `AGENT_OWNER_HANDLES` |
| Semantic memory | `SUPERMEMORY_API_KEY` |
| Render region, plans, and disk | `render.yaml` |
| Concurrency and runtime limits | `.env` |
| Tools or repository workspaces | `src/runtime/production-bootstrap.ts` capability composition |

See [Customization](./docs/CUSTOMIZATION.md) before editing the runtime composition or approval policy.

## Local development

### Prerequisites

- Node.js 22.12 through 22.x, or Node.js 24 or newer;
- PostgreSQL 13 or newer;
- Photon Spectrum credentials;
- ChatGPT device authentication or an OpenAI API key; and
- a Supermemory key only if memory is enabled.

### Install and start

```bash
git clone https://github.com/tecxbro/iMessage-agent-render.git
cd iMessage-agent-render
npm ci
cp .env.example .env
```

Edit `.env`, then generate the required encryption key:

```bash
openssl rand -base64 32
```

Use separate, absolute paths for `CODEX_HOME` and `AGENT_WORKSPACE_ROOT`; `.env` does not expand `$HOME` or `$PWD`. Apply migrations, authenticate Codex, and start the composed service:

```bash
npm run db:migrate
npm run codex:login
npm run codex:status
npm run dev
```

Before proposing a change, run:

```bash
npm run typecheck
npm test
npm run test:integration
npm run test:chaos
npm run docs:check
```

Database-backed integration coverage needs a separate disposable database in `POSTGRES_PIPELINE_TEST_DATABASE_URL`; the suite truncates application tables. Protected provider tests are opt-in and require private accounts.

## How it works

```text
Authorized iMessage owner
  ↕
Photon Spectrum Cloud (persistent app.messages gRPC stream)
  ↓
Authorize, normalize, persist, and schedule
  ↓
PostgreSQL + pg-boss durable pipeline
  ↓
Interaction Codex thread
  ├─ direct response
  └─ bounded execution threads
  ↓
Materialized outbound parts + restart-safe cursor
  ↓
Photon Spectrum Cloud

Successful turn ──> optional curated Supermemory projection
```

`src/server.ts` is the executable entrypoint. It loads the production adapters from `src/runtime/production-bootstrap.ts` and passes them to the generic lifecycle in `src/index.ts`. HTTP liveness starts first; PostgreSQL, migrations, queue workers, Codex checks, optional memory, reconciliation, and Spectrum follow in dependency order.

PostgreSQL is the operational source of truth. Supermemory stores only bounded, curated semantic facts and summaries. The receive loop never runs model work inline.

## Security and privacy

- Unknown senders are rejected before persistence, queueing, or model work.
- Authorization is checked again immediately before Codex or another child process starts.
- Codex children receive an explicit environment allowlist, never the full server environment.
- Models cannot approve actions or broaden code-owned permission profiles.
- Queue payloads contain identifiers, not raw personal content.
- Logs, health endpoints, and failure records must remain redacted.
- Codex credentials and workspaces use separate private directories on the persistent disk.

Never commit `.env`, `auth.json`, provider credentials, database URLs, owner handles, or workspace data. Read [Security and privacy](./SECURITY_AND_PRIVACY.md) for the full trust model.

## Known limitations and release evidence

The executable production runtime is composed. Clean-account Render deployment and protected live-provider evidence remain separate release checks.

The repository does not currently include recorded evidence for a fresh Render deployment, live Photon/Spectrum authorized DM, authenticated Codex restart/resume, or live Supermemory add/search/delete cycle. Run the [release smoke checklist](./test/e2e/render-smoke.md) for the exact commit under review.

The pinned Spectrum API sends through native `space.send(...)` but does not accept the database's stable client GUID. PostgreSQL prevents normal resend, but a crash after provider acknowledgement and before cursor checkpoint can duplicate one bubble. Do not claim exactly-once provider delivery without protected live evidence and provider support.

A blank Render disk has no code-owned execution workspace capability. The default template can answer conversational turns; repository execution requires an explicit reviewed workspace/capability binding.

## Documentation

- [Documentation index](./docs/README.md)
- [Deployment](./DEPLOYMENT_AND_AUTH.md)
- [Architecture](./ARCHITECTURE.md)
- [Operations](./docs/OPERATIONS.md)
- [Configuration](./docs/CONFIGURATION.md)
- [Customization](./docs/CUSTOMIZATION.md)
- [Troubleshooting](./docs/TROUBLESHOOTING.md)
- [Security and privacy](./SECURITY_AND_PRIVACY.md)
- [Maintainer references](./DOCS_INDEX.md)

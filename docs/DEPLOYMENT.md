# Deploy the iMessage Codex Agent

This guide takes a new Render account from the repository Blueprint to the first authorized iMessage. The executable production runtime is composed. Clean-account Render deployment and protected live-provider evidence remain separate release checks.

## 1. Render deployment

Use the repository's deploy button:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/tecxbro/iMessage-agent-render)

Before approving the Blueprint, confirm it creates exactly:

- one paid Node Web Service;
- one Render PostgreSQL database; and
- one persistent disk attached to the Web Service.

Enter the required Spectrum credentials and application owner handles when prompted. `SUPERMEMORY_API_KEY` is optional. Render generates `APP_ENCRYPTION_KEY` and supplies `DATABASE_URL` from the attached database.

The build runs `npm ci --include=dev && npm run build`, the pre-deploy phase runs `npm run db:migrate`, and the service starts with `npm start`. The generated `onrender.com` URL is an operator status page, not an iMessage chat or Photon enrollment link.

## 2. Required accounts and credentials

| Requirement | Why it is needed | Where to obtain it |
|---|---|---|
| Render account | Hosts the service, database, and disk | [Render](https://render.com/) |
| Photon Spectrum project | Connects the iMessage line and persistent message stream | Photon dashboard |
| Allowed owner handle | Restricts who can command the agent | Your E.164 phone number or iMessage email |
| ChatGPT device login or OpenAI API key | Authenticates Codex | ChatGPT account security or OpenAI Platform |
| Supermemory API key | Optional semantic memory | Supermemory dashboard |

`SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET` connect the provider line. `AGENT_OWNER_HANDLES` is a separate application allowlist. Enter the phone number or email Spectrum reports as the sender, such as `+15551234567` or `owner@example.com`.

Never place credentials in source control, screenshots, tickets, database rows, Supermemory, or logs.

## 3. Blueprint resources and expected cost shape

The checked-in [`render.yaml`](../render.yaml) declares:

| Resource | Blueprint shape | Purpose |
|---|---|---|
| Web Service | Starter, Oregon, one instance | HTTP status page, queue workers, Codex runtime, Spectrum loop |
| PostgreSQL | Basic 256 MB, PostgreSQL 18, Oregon | Operational source of truth and pg-boss queue |
| Persistent disk | 1 GB at `/var/data` | Codex credentials, sessions, and workspaces |

These are paid resources. Check current Render pricing before deployment. The disk makes this version single-instance; do not increase `numInstances` or remove the disk without redesigning credential and workspace ownership.

`autoDeployTrigger: "off"` is intentional for a public deploy-button repository. Each template user controls updates to their own service.

## 4. Environment values entered during deployment

Render prompts for values marked `sync: false` only when the Blueprint is first created.

| Variable | Required | Value |
|---|---:|---|
| `SPECTRUM_PROJECT_ID` | Yes | Photon Spectrum project ID |
| `SPECTRUM_PROJECT_SECRET` | Yes | Photon Spectrum project secret |
| `AGENT_OWNER_HANDLES` | Yes | Comma-separated E.164 numbers or email addresses |
| `SUPERMEMORY_API_KEY` | No | API key, or blank to disable semantic memory |

The Blueprint supplies these values without prompting:

- `DATABASE_URL` from the attached database;
- `APP_ENCRYPTION_KEY` as a generated secret;
- `CODEX_HOME=/var/data/codex`;
- `AGENT_WORKSPACE_ROOT=/var/data/workspaces`; and
- `CODEX_AUTH_MODE=chatgpt`.

For an existing service, add or rotate secrets under **Web Service > Manage > Environment**, then rebuild and deploy. Render does not replay newly added `sync: false` prompts during a Blueprint update.

See [Configuration](./CONFIGURATION.md) for every supported variable.

## 5. ChatGPT device-login flow

The default mode is `CODEX_AUTH_MODE=chatgpt`.

1. Enable device-code login in the ChatGPT account or workspace if required.
2. In Render, open the deployed **Web Service**.
3. Open **Manage > Shell**. Do not use Connect/SSH for this flow.
4. Run:

   ```bash
   npm run codex:login
   npm run codex:status
   ```

5. Open the displayed device-auth URL in a trusted browser, sign in, and enter the one-time code.
6. Restart the Web Service.
7. Run `npm run codex:status` again and confirm `/readyz` reports both `codexAuth` and `codexCapabilities` as `ok`.

Credentials persist under `/var/data/codex`. Do not print or copy `$CODEX_HOME/auth.json`. If permissions need repair, use the private shell:

```bash
test -f "$CODEX_HOME/auth.json"
chmod 600 "$CODEX_HOME/auth.json"
npm run codex:status
```

## 6. API-key authentication flow

API-key mode uses OpenAI Platform billing and does not use a ChatGPT device login.

1. Add `OPENAI_API_KEY` as a Render secret.
2. Set `CODEX_AUTH_MODE=api_key`.
3. Rebuild and deploy the Web Service.
4. Check `/readyz` for redacted authentication and capability states.

Do not run `npm run codex:login` in this mode. The runtime passes `OPENAI_API_KEY` only to the Codex child process through an explicit allowlist; it must not be written to the disk or logged.

## 7. Readiness verification

Check the generated service URL:

```bash
curl --fail --silent "https://<service-host>/healthz"
curl --silent --show-error "https://<service-host>/readyz"
```

Expected results:

- `/healthz` returns HTTP 200 when the HTTP process is alive.
- `/readyz` returns HTTP 200 only when configuration, storage, PostgreSQL, migrations, queue, Codex authentication, Codex capabilities, and Spectrum are ready.
- `/readyz` returns HTTP 503 with redacted component states when setup is incomplete or a critical dependency is degraded.
- Supermemory may be `disabled` or `degraded` without blocking the operational pipeline.

Do not use `/healthz` as deployment acceptance. Do not expose the full response if it ever includes a credential, owner handle, message, database URL, provider exception, or private filesystem path.

## 8. First-message test

Only start after `/readyz` returns 200.

1. Send a direct iMessage from a handle in `AGENT_OWNER_HANDLES`.
2. Confirm one terminal response is delivered.
3. Send from an unauthorized handle and confirm zero Codex child processes start.
4. Restart the Web Service normally.
5. Wait for `/readyz` to return 200 and send a follow-up.
6. Record the exact commit, Render deploy ID, timestamps, redacted readiness responses, and provider paths actually exercised in [`../test/e2e/render-smoke.md`](../test/e2e/render-smoke.md).

Offline unit, integration, and chaos tests do not prove a live Render, Photon, Codex, or Supermemory path.

## 9. Updating an existing deployment

1. Review the incoming commit and new migration notes.
2. Confirm a database recovery point exists.
3. Run the repository's required checks, including `npm run docs:check` and Render schema validation.
4. Manually deploy the reviewed revision because auto-deploy is off.
5. Confirm the pre-deploy migration succeeds.
6. Require `/healthz` and `/readyz` to return 200.
7. Run one authorized non-mutating message and one restart follow-up.

If a new `sync: false` variable was added, configure it directly on the existing Web Service before deploying.

## 10. Rollback

Application rollback and schema rollback are separate decisions.

1. Stop new execution and allow graceful shutdown to checkpoint state.
2. Record the current and target application commits.
3. Read every intervening migration `.notes.md` file.
4. Deploy the prior revision only if it is compatible with the current schema.
5. Preserve PostgreSQL, pg-boss state, the persistent disk, and outbound cursors.
6. Restart, run reconciliation, verify both health endpoints, and send one authorized non-mutating message.

Do not run an improvised down migration or delete pg-boss tables, durable messages, outbound cursors, Codex credentials, or workspaces. If compatibility is uncertain, roll forward with a fix or restore application and database together to a matched recovery point.

For incident and provider-outage procedures, use [Operations](./OPERATIONS.md). For visible deployment failures, use [Troubleshooting](./TROUBLESHOOTING.md).

# Deploy the iMessage Codex Agent

This guide takes a new Render account from the repository Blueprint to the first authorized iMessage. The executable production runtime is composed. Clean-account Render deployment and protected live-provider evidence remain separate release checks.

## 1. Render deployment

Use the repository's deploy button:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/tecxbro/iMessage-agent-render)

Before approving the Blueprint, confirm it creates exactly:

- one paid Node Web Service;
- one Render PostgreSQL database; and
- one persistent disk attached to the Web Service.

New Blueprint deployments ask for zero user-supplied environment values. Render generates `APP_ENCRYPTION_KEY` and supplies `DATABASE_URL` from the attached database; the owner phone, Photon, and ChatGPT are configured from the deployed public dashboard. The owner phone is not a Blueprint prompt.

The build runs `npm ci --include=dev && npm run build`, the pre-deploy phase runs `npm run db:migrate`, and the service starts with `npm start`. The generated `onrender.com` URL is a public setup entry point, not an iMessage chat.

## 2. Required accounts and credentials

| Requirement | Why it is needed | Where to obtain it |
|---|---|---|
| Render account | Hosts the service, database, and disk | [Render](https://render.com/) |
| Photon account | Creates or connects the Spectrum project, iMessage line, and persistent message stream | Photon dashboard |
| Allowed owner phone | Restricts who can command the agent | Your personal phone number |
| ChatGPT device login or OpenAI API key | Authenticates Codex | ChatGPT account security or OpenAI Platform |
| Supermemory API key | Optional semantic memory | Supermemory dashboard |

In the dashboard, U.S. owners enter a normal 10-digit phone number; `+1` is added automatically, though pasting a complete `+1` number also works. International owners select **Not in the U.S.?**, choose their country, and enter either a national or complete international number. The server validates the selected country and stores only normalized E.164. The result becomes the only authorized sender and the phone registered during Photon owner provisioning. Photon separately assigns the iMessage destination displayed at completion.

Never place credentials in source control, screenshots, tickets, database rows, Supermemory, or logs.

## 3. Blueprint resources and expected cost shape

The checked-in [`render.yaml`](../render.yaml) declares:

| Resource | Blueprint shape | Purpose |
|---|---|---|
| Web Service | Starter, Oregon, one instance | Public setup dashboard, health HTTP, queue workers, Codex runtime, Spectrum loop |
| PostgreSQL | Basic 256 MB, PostgreSQL 18, Oregon | Operational source of truth and pg-boss queue |
| Persistent disk | 1 GB at `/var/data` | Codex credentials, sessions, and workspaces |

These are paid resources. Check current Render pricing before deployment. The disk makes this version single-instance; do not increase `numInstances` or remove the disk without redesigning credential and workspace ownership.

`autoDeployTrigger: "off"` is intentional for a public deploy-button repository. Each template user controls updates to their own service.

## 4. Environment values during deployment

The Blueprint supplies these values without prompting for any user input:

- `DATABASE_URL` from the attached database;
- `APP_ENCRYPTION_KEY` as a generated secret;
- `CODEX_HOME=/var/data/codex`;
- `AGENT_WORKSPACE_ROOT=/var/data/workspaces`; and
- `CODEX_AUTH_MODE=chatgpt`.

No phone, dashboard password, Photon, ChatGPT, Supermemory, database, or encryption value is requested from the deployer. The phone stays in the dashboard. Existing-deployment compatibility is documented only in [Troubleshooting](./TROUBLESHOOTING.md).

See [Configuration](./CONFIGURATION.md) for every supported variable.

## 5. Public setup dashboard

1. Open the deployed Web Service URL in a trusted browser.
2. Save the owner's phone, complete Photon setup, and then complete ChatGPT setup.

There is no dashboard password or operator session. Anyone who can reach the public service URL can view setup status, device codes, verification URLs, assigned number, masked owner status, bounded error codes, and detailed readiness, and can deliberately submit setup changes. A matching `Origin` and non-cross-site fetch context block ordinary drive-by cross-site mutations, but they do not authenticate a visitor.

Owner status returns only a masked phone, and the write route never echoes the submitted raw number. Photon setup is unavailable until an owner is stored. Raw provider credentials, project secrets, Codex credentials, database credentials, and unrestricted provider errors remain server-side.

## 6. ChatGPT device-login flow

The default mode is `CODEX_AUTH_MODE=chatgpt`.

1. Enable device-code login in the ChatGPT account or workspace if required.
2. In Render, open the deployed **Web Service** URL.
3. Save the owner phone and complete Photon authentication on the public agent dashboard.
4. Select **Connect ChatGPT**, open the device-auth popup, sign in, and enter the one-time code.
5. Keep the dashboard open. It closes the popup when the browser permits, returns focus to setup, and shows Codex preparing.
6. Confirm the dashboard reaches **Your agent is ready** and public `/readyz` returns HTTP 200.

Credentials persist under `/var/data/codex`. Do not print or copy `$CODEX_HOME/auth.json`. The private **Manage > Shell** flow remains an operator recovery path if permissions need repair:

```bash
test -f "$CODEX_HOME/auth.json"
chmod 600 "$CODEX_HOME/auth.json"
npm run codex:status
```

## 7. API-key authentication flow

API-key mode uses OpenAI Platform billing and does not use a ChatGPT device login.

1. Add `OPENAI_API_KEY` as a Render secret.
2. Set `CODEX_AUTH_MODE=api_key`.
3. Rebuild and deploy the Web Service.
4. Check the public dashboard or `/readyz` for authentication and capability state.

Do not run `npm run codex:login` in this mode. The runtime passes `OPENAI_API_KEY` only to the Codex child process through an explicit allowlist; it must not be written to the disk or logged.

## 8. Readiness verification

Check the generated service URL:

```bash
curl --fail --silent "https://<service-host>/healthz"
curl --silent --show-error "https://<service-host>/readyz"
```

Expected results:

- `/healthz` returns HTTP 200 when the HTTP process is alive.
- `/readyz` returns HTTP 200 only when configuration, storage, PostgreSQL, migrations, queue, owner identity, Codex authentication, Codex capabilities, and Spectrum are ready.
- `/readyz` returns HTTP 503 with a detailed component snapshot and bounded remediation actions when setup is incomplete or a critical dependency is degraded.
- A fresh deployment before owner setup is expected to return `/healthz` 200 and `/readyz` 503.
- Supermemory may be `disabled` or `degraded` without blocking the operational pipeline.

Public readiness includes component states, bounded error codes, and remediation actions. It never includes raw owner phone values, credentials, private paths, or unrestricted provider errors. Do not use `/healthz` as deployment acceptance.

## 9. First-message test

Only start after `/readyz` returns 200.

1. Send a direct iMessage from the configured owner phone number.
2. Confirm one terminal response is delivered.
3. Send from an unauthorized handle and confirm zero Codex child processes start.
4. Restart the Web Service normally.
5. Wait for `/readyz` to return 200 and send a follow-up.
6. Record the exact commit, Render deploy ID, timestamps, redacted readiness responses, and provider paths actually exercised in [`../test/e2e/render-smoke.md`](../test/e2e/render-smoke.md).

Offline unit, integration, and chaos tests do not prove a live Render, Photon, Codex, or Supermemory path.

## 10. Updating an existing deployment

1. Review the incoming commit and new migration notes.
2. Confirm a database recovery point exists.
3. Run the repository's required checks, including `npm run docs:check` and Render schema validation.
4. Manually deploy the reviewed revision because auto-deploy is off.
5. Confirm the pre-deploy migration succeeds.
6. Require `/healthz` and `/readyz` to return 200.
7. Run one authorized non-mutating message and one restart follow-up.

Before deploying this version, delete both former dashboard credential variables from the existing Render service; startup rejects either obsolete key, even when empty. An active database owner wins. If none exists, the runtime imports `OWNER_PHONE_NUMBER`, then the former long Render alias, then one unambiguous E.164 `AGENT_OWNER_HANDLES` value. It never imports authorization from stored Photon metadata and never overwrites a database owner on later restarts. Multiple handles or a non-phone handle require the user to open the public dashboard and save the intended phone. After verifying migration, old owner environment values may be removed manually.

## 11. Rollback

Application rollback and schema rollback are separate decisions.

1. Stop new execution and allow graceful shutdown to checkpoint state.
2. Record the current and target application commits.
3. Read every intervening migration `.notes.md` file.
4. Deploy the prior revision only if it is compatible with the current schema.
5. Preserve PostgreSQL, pg-boss state, the persistent disk, and outbound cursors.
6. Restart, run reconciliation, verify both health endpoints, and send one authorized non-mutating message.

Do not run an improvised down migration or delete pg-boss tables, durable messages, outbound cursors, Codex credentials, or workspaces. If compatibility is uncertain, roll forward with a fix or restore application and database together to a matched recovery point.

For incident and provider-outage procedures, use [Operations](./OPERATIONS.md). For visible deployment failures, use [Troubleshooting](./TROUBLESHOOTING.md).

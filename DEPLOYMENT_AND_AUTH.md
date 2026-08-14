# Deployment and Codex Authentication

## 1. Deployment promise

The accurate promise is:

> One-click Render infrastructure provisioning, followed by one private Codex enrollment step when using ChatGPT authentication.

Render can create the service, PostgreSQL database, environment wiring, health checks, and persistent disk from `render.yaml`. It cannot complete a user’s private ChatGPT device authorization without the user.

## 2. What “Codex in the cloud” means

The Codex TypeScript SDK starts a Codex CLI process inside the Node service. On Render, that process and its sessions run inside the Render instance. This is a private, self-hosted Codex runtime; it is not the separate Codex Cloud product.

The same application can run locally. The transport remains Spectrum Cloud gRPC unless a separate macOS-local iMessage provider is intentionally added later.

## 3. Render resources

V1 Blueprint:

- One paid Node Web Service.
- One Render PostgreSQL database.
- One persistent disk attached to the web service.
- Dynamic `DATABASE_URL` from the database resource.
- Prompted Photon and Supermemory secrets.
- Generated application encryption key.

The disk makes the service single-instance in v1. Do not configure horizontal scaling.

## 4. Blueprint shape

Use this as the implementation target, then validate it against current Render Blueprint documentation before release:

```yaml
services:
  - type: web
    name: imessage-codex-agent
    runtime: node
    plan: starter
    autoDeployTrigger: off
    buildCommand: npm ci && npm run build
    preDeployCommand: npm run db:migrate
    startCommand: npm start
    healthCheckPath: /healthz
    maxShutdownDelaySeconds: 120
    disk:
      name: codex-data
      mountPath: /var/data
      sizeGB: 1
    envVars:
      - key: NODE_VERSION
        value: 22.12.0
      - key: DATABASE_URL
        fromDatabase:
          name: imessage-agent-db
          property: connectionPoolString
      - key: CODEX_HOME
        value: /var/data/codex
      - key: AGENT_WORKSPACE_ROOT
        value: /var/data/workspaces
      - key: SPECTRUM_PROJECT_ID
        sync: false
      - key: SPECTRUM_PROJECT_SECRET
        sync: false
      - key: SUPERMEMORY_API_KEY
        sync: false
      - key: AGENT_OWNER_HANDLES
        sync: false
      - key: APP_ENCRYPTION_KEY
        generateValue: true

databases:
  - name: imessage-agent-db
    plan: basic-256mb
    postgresMajorVersion: "18"
    diskSizeGB: 15
```

Plan names and supported fields can change. The repository must include a CI command that validates the actual file against the current Render specification.

## 5. Boot phases

```text
Phase 1: process liveness
  HTTP /healthz starts.

Phase 2: operational dependencies
  Disk, config, database, migrations, pg-boss initialize.

Phase 3: Codex enrollment/capabilities
  Check auth and configured model/effort support.

Phase 4: messaging
  Start Spectrum gRPC stream and mark readiness when connected.
```

A missing Codex login should not crash the service repeatedly. `/healthz` remains healthy while `/readyz` reports the exact missing enrollment step. Inbound messages should not be accepted for execution until readiness is complete; the operator may optionally configure a fixed “setup incomplete” reply for the authorized owner.

## 6. ChatGPT authentication on Render

### Required configuration

`CODEX_HOME` must point to the persistent disk. Configure Codex to store credentials in a file inside that directory rather than relying on an OS keychain unavailable in a headless container.

Startup setup script:

```bash
install -d -m 700 "$CODEX_HOME"
cat > "$CODEX_HOME/config.toml" <<'EOF'
cli_auth_credentials_store = "file"
forced_login_method = "chatgpt"
EOF
chmod 600 "$CODEX_HOME/config.toml"
```

Confirm the exact config keys against the pinned Codex release before shipping.

### Enrollment

From the private Render Shell:

```bash
npm run codex:login
# script: codex login --device-auth
```

The CLI prints a URL and device code. The operator completes sign-in in their browser, then verifies:

```bash
npm run codex:status
# script: codex login status
```

Restart or redeploy the service and confirm `/readyz` reports `codexAuth: ok`.

### Credential rules

- Treat `$CODEX_HOME/auth.json` as a password.
- Never print, upload, commit, or place it in PostgreSQL/Supermemory.
- Set directory mode `0700` and file mode `0600` where the filesystem permits.
- Do not expose Render Shell access to ordinary agent users.
- Revoke and re-enroll if the deployment is transferred.
- The service must detect missing/expired auth and stop new execution safely.

## 7. API-key mode

For noninteractive deployments:

```dotenv
CODEX_AUTH_MODE=api_key
OPENAI_API_KEY=<secret>
```

In this mode:

- Pass the API key only to the Codex child process.
- Do not write it to disk.
- Remove it from the parent environment passed to any unrelated subprocess.
- Track API token costs using current official pricing.
- `/readyz` verifies a minimal capability call without exposing key details.

The repository should recommend API-key or enterprise/workspace credential approaches for programmatic multi-user products rather than reusing one person’s ChatGPT login.

## 8. Local setup

Prerequisites:

- Node 22.12+.
- PostgreSQL 13+ or a local container.
- A Photon project with cloud iMessage configured.
- A Supermemory API key for memory-enabled mode.
- Codex CLI authenticated with ChatGPT or an API key.

Commands:

```bash
git clone <new-repository-url>
cd imessage-codex-agent-boilerplate
cp .env.example .env
npm ci
npm run db:migrate
codex login
npm run dev
```

Set local paths:

```dotenv
CODEX_HOME=$HOME/.codex
AGENT_WORKSPACE_ROOT=./.agent-workspaces
DATABASE_URL=postgresql://...
```

Do not commit local Codex or workspace directories.

## 9. Photon setup

The gRPC path requires:

```dotenv
SPECTRUM_PROJECT_ID=
SPECTRUM_PROJECT_SECRET=
```

It does **not** require `SPECTRUM_WEBHOOK_SECRET`. Spectrum discovers cloud lines from project credentials and renews tokens when configured through the normal cloud provider path.

Operational notes:

- Shared-pool and dedicated-line capabilities differ, especially for groups.
- Persist route phone for reliable lookup on projects with multiple dedicated lines.
- New line provisioning may require process restart or waiting for token renewal before the running SDK observes it.
- Respect current per-server, per-line, and plan quotas.

## 10. Supermemory setup

```dotenv
SUPERMEMORY_API_KEY=
SUPERMEMORY_CONTAINER_PREFIX=imessage-agent
```

Readiness checks configuration, not a destructive write. A separate smoke command may add/search/delete a temporary test item during deployment verification.

## 11. Database migration and rollback

- Generate migrations in source control.
- Run forward-compatible migrations before starting new code.
- Avoid destructive column/table removal in the same release that stops writing the data.
- pg-boss schema initialization must be deterministic and version-compatible.
- Rollback instructions identify the last application version compatible with the current schema.
- Backup before migrations that rewrite encrypted content or identity fingerprints.

## 12. Health endpoints

```text
GET /healthz  → 200 {"status":"ok"}
GET /readyz   → 200 when ready; 503 with redacted component states otherwise
```

Neither endpoint requires public authentication because it contains no sensitive values. Do not add an unauthenticated admin UI.

## 13. Recovery procedures

### Expired/revoked ChatGPT auth

1. Readiness becomes false.
2. Existing durable messages stay queued; execution is paused.
3. Operator runs `npm run codex:login` again.
4. Capability probe succeeds.
5. Queue resumes.

### Corrupt Codex session

1. Mark the specific thread `reset`.
2. Preserve its bounded PostgreSQL summary.
3. Start a fresh thread with the summary.
4. Do not delete unrelated agents or owner memory.

### Persistent disk loss

1. Re-enroll Codex.
2. Recreate workspaces from configured Git remotes or backups.
3. Start fresh Codex threads using database summaries.
4. Database-backed messages, chains, approvals, and memory receipts remain intact.

### Database outage

1. Mark readiness false.
2. Do not accept untracked model execution.
3. Spectrum receive loop may reconnect after database recovery; provider behavior and replay guarantees must be tested.
4. Resume queued jobs after database recovery.

## 14. One-click button wording

Use:

> Deploy the private agent infrastructure to Render

Follow with:

> After deployment, complete one private Codex device-login step in Render Shell.

Do not label the full experience “zero configuration” or imply that Render can log into ChatGPT automatically.

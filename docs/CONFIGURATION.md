# Configuration Reference

[`../.env.example`](../.env.example) is the copyable configuration template. This file is the authoritative explanation of supported environment variables, including private service secrets. The service validates the complete environment at startup and reports safe configuration problems together.

All changes require a service restart. Render-managed values should be changed through the Blueprint or Web Service environment settings, never by editing files on the persistent disk.

## Required provider configuration

| Variable | Required | Default | Where to obtain it | Restart required | Sensitive |
|---|---:|---|---|---:|---:|
| `SPECTRUM_PROJECT_ID` | Yes | — | Photon dashboard | Yes | Yes |
| `SPECTRUM_PROJECT_SECRET` | Yes | — | Photon dashboard | Yes | Yes |
| `DATABASE_URL` | Yes | — | Local PostgreSQL or Render dynamic database reference | Yes | Yes |

`DATABASE_URL` must use the `postgres://` or `postgresql://` protocol. On Render it is supplied automatically from `imessage-agent-db`; do not paste it into a Blueprint prompt.

## Authorization

| Variable | Required | Default | Where to obtain it | Restart required | Sensitive |
|---|---:|---|---|---:|---:|
| `OWNER_PHONE_NUMBER` | Yes locally or on existing deployments | — | Owner's E.164 phone number | Yes | Private |
| `OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123` | New Render deployments only | — | Render Blueprint prompt | Yes | Private |
| `AGENT_OWNER_HANDLES` | Legacy fallback only | — | Existing comma-separated numbers or iMessage emails | Yes | Private |
| `PAIRING_MODE` | No | `off` | Operator policy | Yes | No |
| `GROUP_MODE` | No | `owner_mentions_only` | Operator policy | Yes | No |

The Render Blueprint uses the long `OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123` key because Render's `sync: false` form does not support custom placeholders. Enter the actual owner number in E.164 format, such as `+19495550123`; the key's example is not a value to copy. The runtime normalizes that Render-only alias to `OWNER_PHONE_NUMBER`.

Existing deployments and local `.env` files may continue using `OWNER_PHONE_NUMBER`. If both phone variables are set, they must match. `AGENT_OWNER_HANDLES` remains a backwards-compatible fallback for existing comma-separated phone numbers or iMessage emails; emails are normalized to lowercase. Photon line setup does not replace this application allowlist.

Keep `PAIRING_MODE=off` unless pairing has been explicitly reviewed for the deployment. `GROUP_MODE=disabled` rejects group use; `owner_mentions_only` requires the owner/group policy enforced by the application.

## Operator dashboard authentication

| Variable | Required | Default | Where to obtain it | Restart required | Sensitive |
|---|---:|---|---|---:|---:|
| `DASHBOARD_SETUP_SECRET` | Production | — | Render-generated secret or independent high-entropy local value | Yes | Yes |

Render declares this variable with `generateValue: true`, so a new deployment receives a random base64-encoded 256-bit value without prompting the user. Find it in the deployed Web Service's private **Environment** page and enter it only in the dashboard's **Deployment setup code** field. It is separate from the owner phone allowlist: authenticating the setup dashboard does not authorize an iMessage sender, and the owner phone remains a Render Blueprint input until Prompt 2.

Each successful login creates an eight-hour server-side session, with at most eight active sessions retained. Logout revokes the session, and restarting the service invalidates every session.

Production startup rejects a missing, empty, or insufficiently strong dashboard setup secret. Validation identifies only `DASHBOARD_SETUP_SECRET` and a safe configuration problem; it must never include the submitted or configured value. For local development, set an independent high-entropy value in `.env`. Do not reuse `APP_ENCRYPTION_KEY`, commit the value, put it in a URL, or store it in browser storage.

Render generates the value once when the environment variable is missing and preserves it across Blueprint sync. To rotate or recover a lost value, regenerate or replace it under **Web Service > Environment**, save the change, and redeploy or restart the service. Existing in-memory operator sessions are not a substitute for retaining authorized access to the Render environment.

## Codex authentication

| Variable | Required | Default | Where to obtain it | Restart required | Sensitive |
|---|---:|---|---|---:|---:|
| `CODEX_AUTH_MODE` | Yes | `chatgpt` | Operator choice: `chatgpt` or `api_key` | Yes | No |
| `OPENAI_API_KEY` | Only in API-key mode | — | OpenAI Platform | Yes | Yes |

ChatGPT mode stores device-login credentials below `CODEX_HOME`. API-key mode supplies `OPENAI_API_KEY` only to the Codex child process through an explicit environment allowlist. The runtime never silently switches modes.

## Persistent storage

| Variable | Required | Default | Where to obtain it | Restart required | Sensitive |
|---|---:|---|---|---:|---:|
| `DEPLOYMENT_ID` | Local only | Derived from `RENDER_SERVICE_ID` on Render | Generate a stable UUID locally | Yes | No |
| `APP_ENCRYPTION_KEY` | Yes | Render generates it | `openssl rand -base64 32` locally | Yes | Yes |
| `CODEX_HOME` | Yes | `/var/data/codex` on Render | Absolute private directory | Yes | Contains secrets |
| `AGENT_WORKSPACE_ROOT` | Yes | `/var/data/workspaces` on Render | Separate absolute directory | Yes | Private data |

`APP_ENCRYPTION_KEY` must be 32 bytes encoded as base64 or 64 hexadecimal characters. Rotating it requires a migration plan for already encrypted data.

`CODEX_HOME` and `AGENT_WORKSPACE_ROOT` must be absolute, non-root, separate, and non-overlapping. `.env` does not expand `$HOME`, `$PWD`, `~`, or command substitutions.

Render service IDs are provider-specific strings, not UUIDs. When `DEPLOYMENT_ID` is absent on Render, the loader hashes `RENDER_SERVICE_ID` into a deterministic UUID. This keeps the internal deployment namespace stable without storing the raw provider identifier in memory namespaces.

## Optional memory

| Variable | Required | Default | Where to obtain it | Restart required | Sensitive |
|---|---:|---|---|---:|---:|
| `SUPERMEMORY_API_KEY` | No | Disabled | Supermemory dashboard | Yes | Yes |
| `SUPERMEMORY_CONTAINER_PREFIX` | No | `imessage-agent` | Operator-chosen namespace prefix | Yes | No |

Leave `SUPERMEMORY_API_KEY` blank to disable semantic memory. PostgreSQL remains the operational source of truth. Supermemory may contain only bounded curated facts and summaries, never authorization, delivery, queue, or raw-message state.

The container prefix must be 1–64 letters, digits, or hyphens and begin with a letter or digit.

## Model routing

| Variable | Required | Default | Restart required | Sensitive |
|---|---:|---|---:|---:|
| `MODEL_FAST` | No | `gpt-5.6-luna` | Yes | No |
| `MODEL_FAST_EFFORT` | No | `medium` | Yes | No |
| `MODEL_MAIN` | No | `gpt-5.6-luna` | Yes | No |
| `MODEL_MAIN_EFFORT` | No | `high` | Yes | No |
| `MODEL_BALANCED` | No | `gpt-5.6-terra` | Yes | No |
| `MODEL_BALANCED_EFFORT` | No | `high` | Yes | No |
| `MODEL_HARD` | No | `gpt-5.6-luna` | Yes | No |
| `MODEL_HARD_EFFORT` | No | `max` | Yes | No |
| `MODEL_DEEP` | No | `gpt-5.6-sol` | Yes | No |
| `MODEL_DEEP_EFFORT` | No | `max` | Yes | No |
| `ALLOW_REASONING_FALLBACK` | No | `false` | Yes | No |

Configured model/effort pairs are capability-probed before Spectrum intake starts. Keep `ALLOW_REASONING_FALLBACK=false` unless an explicit product policy permits a different effort level. The runtime must not silently downgrade models or reasoning effort.

## Concurrency and limits

| Variable | Required | Default | Allowed range | Restart required |
|---|---:|---:|---:|---:|
| `INBOUND_DEBOUNCE_MS` | No | `4000` | 3000–5000 | Yes |
| `MAX_EXECUTION_CONCURRENCY` | No | `3` | 1–20 | Yes |
| `MAX_OWNER_EXECUTION_CONCURRENCY` | No | `2` | 1–20 and no greater than global | Yes |
| `MESSAGE_RATE_LIMIT_PER_MINUTE` | No | `60` | 1–10000 | Yes |
| `TASK_RATE_LIMIT_PER_HOUR` | No | `120` | 1–10000 | Yes |
| `MAX_TASK_RUNTIME_MS` | No | `900000` | 1000–3600000 | Yes |

These bounds protect provider load and child-process capacity. Increasing them changes resource and abuse risk; validate queue recovery, cancellation, and Render capacity before deployment.

## Retention and logging

| Variable | Required | Default | Allowed range | Restart required | Sensitive |
|---|---:|---:|---:|---:|---:|
| `RAW_MESSAGE_RETENTION_DAYS` | No | `30` | 1–3650 | Yes | Private data policy |
| `FAILURE_RETENTION_DAYS` | No | `14` | 1–365 | Yes | Private metadata policy |
| `LOG_MESSAGE_CONTENT` | No | `false` | `true` or `false` | Yes | Security-critical |

Keep `LOG_MESSAGE_CONTENT=false` in production. Enabling raw content logging materially changes the privacy boundary and requires an explicit reviewed requirement.

## Server configuration

| Variable | Required | Default | Where to obtain it | Restart required | Sensitive |
|---|---:|---:|---|---:|---:|
| `PORT` | No | `10000` | Render injects or operator chooses | Yes | No |

`PORT` must be between 1 and 65535. `NODE_ENV`, `PATH`, locale variables, and `RENDER_SERVICE_ID` are runtime/platform inputs rather than template-user configuration and are intentionally not copied into `.env.example`.

## Cross-field safety checks

Startup fails with an actionable combined error when:

- API-key mode lacks `OPENAI_API_KEY`;
- production lacks nonempty high-entropy `DASHBOARD_SETUP_SECRET` material;
- owner concurrency exceeds global concurrency;
- protected paths overlap, resolve to a filesystem root, or contain traversal;
- the database URL uses a non-PostgreSQL protocol;
- the encryption key has the wrong encoding or byte length; or
- owner handles, model identifiers, effort values, durations, booleans, or enum values are invalid.

Fix the reported values and restart. Never work around validation by weakening schemas or logging secrets.

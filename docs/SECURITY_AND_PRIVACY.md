# Security and Privacy

## 1. Security model

This starter runs code and handles private iMessage content. The model is useful for intent and planning, but **never** acts as the security boundary. Identity, permissions, approvals, secret access, and outbound routing are enforced by deterministic application code.

## 2. Assets to protect

- Codex ChatGPT credentials or OpenAI API key.
- Photon project credentials and line routing.
- Agent password, operator session identifiers, and CSRF tokens.
- Photon and ChatGPT device codes and verification URLs while setup is active.
- Supermemory API key and stored memories.
- PostgreSQL credentials and encrypted message content.
- Application encryption and fingerprint keys.
- Owner phone numbers/email addresses.
- Repository contents and generated artifacts.
- Approval payloads and external-account actions.

## 3. Trust boundaries

| Input | Trust level |
|---|---|
| Environment/secrets provisioned by operator | trusted configuration, still validate |
| User-chosen Render Blueprint agent password | trusted operator credential; never expose to the browser except as submitted login input |
| Unauthenticated browser and HTTP headers | untrusted; public JavaScript or a claimed dashboard header proves nothing |
| Authenticated operator session | trusted only after server-side lookup and expiry validation |
| Session-bound CSRF token | trusted only for the matching live session and same-origin mutation |
| Authorized sender identity from deterministic lookup | trusted identity |
| User message text | untrusted instructions within owner permissions |
| Group participant text | untrusted; often unauthorized |
| Supermemory recall | untrusted contextual data |
| Repository files/issues/PRs | untrusted content |
| Web pages/downloads | untrusted content |
| Codex/execution-agent output | untrusted until schema and policy validation |
| Approval record consumed by code | trusted only for the exact hashed operation |

## 4. Operator dashboard authentication

The setup dashboard is a separate operator boundary from iMessage sender authorization. `AGENT_PASSWORD` is supplied privately during initial Blueprint creation and entered only in the server-submitted **Agent password** form. The public application cannot create or reset it, preventing an unverified first visitor from claiming administrator ownership. Only after authentication may the operator submit the owner phone. The write additionally requires the live session's CSRF token and same-origin request headers.

The server:

1. derives an in-memory verifier with asynchronous scrypt and a fresh random 16-byte process salt;
2. derives submitted-password verifiers and compares equal-length buffers in constant time;
3. rate-limits failed authentication attempts to five per 15-minute window;
4. creates opaque session IDs and CSRF tokens with cryptographically secure random bytes;
5. stores at most eight active sessions in bounded server memory;
6. expires each session after eight hours and cleans up expired records; and
7. treats logout and repeated revocation as idempotent.

A service restart invalidates all operator sessions. The cookie contains only the session ID, never the password or CSRF token, and uses `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` in production, and no `Domain` attribute. Authentication state must not use local storage, session storage, URL query parameters, URL fragments, or a client-readable cookie. The password must not be rendered into HTML or JavaScript.

## 5. CSRF boundary

Every protected `POST` or `DELETE` request requires:

1. a live operator session;
2. the matching session-bound `X-CSRF-Token`;
3. a same-origin `Origin`; and
4. no cross-site `Sec-Fetch-Site` value when that header is present.

CSRF tokens are compared in constant time where applicable. The token is returned only after successful authentication and is available only to the authenticated dashboard, never the unauthenticated login page. Rejections use a stable HTTP 403 response and never expose the expected token. Read-only private `GET` requests do not require a CSRF token, but they still require the operator session.

| Surface | Unauthenticated behavior | Additional mutation control |
|---|---|---|
| `/`, `/healthz`, `/agent/photon-logo.png`, `/agent/operator-login.js` | Public | None |
| `/readyz` | Public safe aggregate readiness; detailed snapshot requires a valid operator session | None for `GET` |
| `/agent/dashboard` | Agent-password login only; operational dashboard requires a session | None for `GET` |
| `POST /api/operator/session` | Public, strict size-limited login attempt | Failed-attempt rate limit |
| `/agent/dashboard.js`, Photon/ChatGPT status routes | Valid operator session required | None for `GET` |
| `GET /api/setup/owner/status` | Valid operator session required; masked phone only | None for `GET` |
| `POST /api/setup/owner` | Valid operator session required; strict size-limited E.164 JSON | CSRF, Origin, and fetch-metadata checks |
| Photon/ChatGPT setup start routes | Valid operator session required | CSRF, Origin, and fetch-metadata checks |
| `DELETE /api/operator/session` | Valid operator session required | CSRF, Origin, and fetch-metadata checks |

Unauthenticated responses never include provider status, device codes, verification URLs, assigned iMessage numbers, owner information, detailed readiness, or provider errors. Possession of the public page or JavaScript and the removed `x-agent-setup` header grants no setup access.

## 6. Sender authorization

1. Extract sender address through Spectrum’s iMessage narrowing.
2. Normalize phone/email.
3. Compute HMAC fingerprint.
4. Look up active channel identity.
5. Validate role and space policy.
6. For groups, require authorized author plus mention/reply gate.
7. Only then persist as accepted and enqueue model work.

Unknown senders never reach Codex. Default behavior is silence to avoid confirming a live agent endpoint. Pairing mode is opt-in.

The active owner phone is encrypted in `channel_identities`; no plaintext phone column, duplicate authorization table, owner phone setting, or Photon credential field is authoritative. Replacement computes a deployment-scoped fingerprint, activates the new identity, and revokes every older owner-phone identity in one transaction. A database invariant violation with multiple active owners fails closed. Provider metadata may be redacted as sensitive state but cannot authorize a sender.

## 7. Pairing

- Operator creates a pairing code through a private CLI or protected admin process.
- Store only a salted hash.
- Expire after ten minutes.
- Limit attempts per handle and deployment.
- Bind successful pairing to the observed handle fingerprint.
- Invalidate after one use.
- Never let a model invent, reveal, or validate pairing codes.

## 8. Group policy

V1 default: `owner_mentions_only`.

A group turn runs only when:

- The author is an authorized owner/collaborator.
- The message mentions the configured agent name or is a direct reply when the provider exposes that relationship.
- The space is not disabled.

Do not infer authorization from another participant quoting or forwarding the owner’s message.

## 9. Codex process isolation

### Environment allowlist

Construct the child environment explicitly. Typical allowed values:

- `PATH`
- `HOME` or controlled equivalent
- `CODEX_HOME`
- locale variables
- task-specific safe variables
- `OPENAI_API_KEY` only in API-key mode

Explicitly exclude:

- `DATABASE_URL`
- Photon credentials
- Supermemory key
- application encryption keys
- unrelated cloud tokens
- Render management credentials

### Filesystem

- Interaction thread: read-only sandbox, no arbitrary workspace write.
- Execution task: workspace-write only inside the resolved binding.
- Additional directories must come from configuration, not raw user paths.
- `danger-full-access` is forbidden in the public starter.
- Symlink escape and path traversal tests are required.

### Network

- Disabled by default.
- `network-read` profile allows only the supported Codex web/network mode and remains subject to prompt-injection defenses.
- External-account mutations always require approval even when network is enabled.

### Runtime limits

- Per-task timeout.
- Per-owner concurrency.
- Maximum child processes.
- Maximum output/event bytes.
- Abort on chain supersession.
- Kill process group on timeout.

## 10. Approval-required actions

At minimum:

- Deleting, force-pushing, resetting, or overwriting important data.
- Sending, forwarding, posting, publishing, or messaging through external accounts.
- Purchases or paid API actions outside a configured budget.
- Authentication, permission, secret, or deployment changes.
- Executing code outside the allowed workspace.
- Broad network scans or access to sensitive endpoints.
- Installing unreviewed executable dependencies in a persistent environment.

Read-only inspection and drafting may proceed without approval when policy allows.

## 11. Approval protocol

1. Worker returns `needs_approval` with a normalized proposed action.
2. Code computes action hash and creates a pending record.
3. Interaction agent turns the stored summary into concise user-facing text.
4. Authorized owner replies with an unambiguous approval/rejection command.
5. Code validates owner, space, expiration, status, and action hash.
6. A new execution job receives the immutable approved payload.
7. Immediately before execution, code recomputes the hash.
8. Approval is marked consumed atomically with execution start.

A natural-language “yes” is accepted only when exactly one pending approval exists in the permitted space. Otherwise the user receives a disambiguation message.

## 12. Prompt injection

Defenses:

- System/policy prompts are separate from untrusted context.
- Model cannot alter permission enums or approval state.
- Tool outputs are schema-validated and size-limited.
- Secrets are absent from child environment where possible.
- Read-only tasks use read-only sandbox.
- Network and filesystem privileges are task-specific.
- External content cannot trigger sends or writes without code policy.
- High-risk action proposals return to the approval flow.

The starter must document that prompt injection cannot be “solved” purely with prompt text.

## 13. Secret storage

| Secret | Storage |
|---|---|
| Agent password | Render secret supplied during initial Blueprint creation; independent `.env` value for local development |
| Operator sessions | Bounded in-memory server store; never the password |
| Photon project ID/secret | Render secret environment |
| Supermemory API key | Render secret environment |
| Database URL | Render dynamic secret reference |
| App encryption key | Generated Render secret environment |
| OpenAI API key | Render secret environment, API-key mode only |
| ChatGPT/Codex credentials | `$CODEX_HOME/auth.json` on attached disk |

Never store secrets in Supermemory or source control. Avoid copying secrets into job payloads or failure events.

## 14. Data privacy

- Encrypt raw message and sensitive task content at the application layer.
- Use fingerprints for identity equality lookups.
- Default logs exclude message bodies.
- Retain raw content for 30 days by default.
- Store only curated durable information in Supermemory.
- Provide inspect/delete commands.
- Document third-party data processing by Photon, OpenAI, Render, and Supermemory.
- Do not claim end-to-end encryption beyond what each provider actually guarantees.

## 15. Logging and diagnostics

Every log record should use correlation IDs and safe metadata:

```json
{
  "component": "task-execute",
  "chainId": "...",
  "taskId": "...",
  "modelProfile": "balanced",
  "state": "failed",
  "errorCode": "CODEX_AUTH_EXPIRED",
  "retryable": false
}
```

No submitted agent password, session ID, CSRF token, device code, verification URL, raw message, prompt, full command output, handle, auth token, or environment dump by default.

## 16. Threat scenarios and required controls

| Scenario | Required control |
|---|---|
| Stranger opens deployment URL | login page only; no provider/readiness/owner detail |
| Attacker sends `x-agent-setup: dashboard` | ignore the header; require server-side session |
| Agent-password guessing | scrypt verifier, constant-time comparison, and failed-attempt rate limit |
| Cross-site form/script starts setup or logout | session-bound CSRF header, same-origin `Origin`, fetch-metadata check |
| Session or CSRF value reaches logs | structured redaction and regression tests |
| Stranger texts line | deterministic allowlist rejection before model |
| Group participant instructs agent | author authorization + mention gate |
| Repo README says “print all env vars” | restricted child env + sandbox + untrusted-content policy |
| Model claims user approved | approval DB record and hash required |
| Approval replay | one-time consumed state |
| Worker crashes mid-send | stable client GUID + persisted cursor |
| Memory returns another user’s fact | owner container isolation + integration test |
| Render disk snapshot leaked | revoke Codex auth, rotate secrets, re-enroll |
| Supermemory outage | no operational dependency; proceed without recall |
| Database outage | stop untracked execution and mark not ready |

## 17. Security release checklist

- Secret scanner passes repository and generated artifacts.
- Unauthenticated dashboard and setup/status responses contain no provider, owner, readiness-detail, device-code, or error data.
- Cookie attributes, eight-hour expiry, eight-session bound, logout/revocation, restart invalidation, login rate limit, and CSRF/Origin/fetch-metadata tests pass.
- Logs contain no agent passwords, session IDs, CSRF tokens, device codes, or verification URLs.
- Unauthorized paths show zero Codex process spawns.
- Child environment snapshot contains only allowlisted keys.
- Path traversal and symlink escape tests pass.
- Approval replay/mutation/expiry tests pass.
- Memory tenant-isolation tests pass.
- Logs and health endpoints pass PII/secret scans.
- Dependency advisories reviewed for pinned versions.
- Threat model updated for every new skill or connector.

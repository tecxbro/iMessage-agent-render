# PostgreSQL-Backed Dashboard Password PRD

**Status:** Proposed implementation handoff

**Scope:** Single-owner Render deployment only

## 1. Objective

Protect the post-deploy setup dashboard with a password chosen on the dashboard and stored only as a password hash in PostgreSQL.

A fresh deployment is claimed through one successful database transaction.
After that claim, setup state and setup actions require an authenticated session.

No email address, email delivery service, magic link, SMS OTP, or password value supplied during Render Blueprint creation is required.

## 2. User outcome

### Fresh deployment

1. The user deploys the Render Blueprint.
2. The user opens the service URL.
3. The unclaimed page asks for:
   - the owner's phone number using the existing U.S.-first/international entry behavior;
   - a password; and
   - password confirmation.
4. One submission transactionally stores the normalized owner phone and claims the dashboard password.
5. The browser receives an authenticated session and continues to Photon and ChatGPT setup.
6. Every later unauthenticated visit to the same URL sees only the password login page.

### Returning operator

1. The operator opens the same service URL.
2. The operator enters the dashboard password.
3. A successful login opens the setup/status dashboard.
4. Logout revokes the current session.

### Forgotten password

1. The operator selects **Forgot password?** on the login page.
2. The link opens the canonical GitHub README section:
   `https://github.com/tecxbro/iMessage-agent-render#forgot-your-dashboard-password`
3. The README directs the operator to the authenticated Render service **Shell** page.
4. In the private shell, the operator runs:

   ```bash
   npm run \
     dashboard:reset-password
   ```

5. The command prompts privately for the new password and confirmation, replaces the PostgreSQL hash, and revokes every dashboard session.
6. The operator returns to the service URL and signs in with the new password.

The forgot-password page never resets the password, accepts a recovery token, or reveals account state beyond the fact that this deployment uses dashboard authentication.

## 3. Product decisions

### 3.1 Initial dashboard claim

While no dashboard credential exists, the dashboard presents the claim form.
The first successful database transaction wins the claim. A second or
concurrent claim must fail closed and must not change the owner phone or
password.

### 3.2 Phone number, not email

The claim form uses the owner phone that is already required for iMessage authorization. It does not collect or store an email address. The phone number identifies the authorized iMessage sender but is not treated as a password or password-reset factor.

### 3.3 PostgreSQL is authoritative

PostgreSQL is the source of truth for:

- whether the dashboard is unclaimed or claimed;
- the password hash and hash format/version; and
- active dashboard sessions and their revocation state.

The persistent disk, browser storage, Photon metadata, owner phone, and `APP_ENCRYPTION_KEY` are not dashboard-authentication authorities.

### 3.4 Render account is the recovery authority

Possession of the authenticated Render workspace/service is the recovery proof. Password recovery must never delete the credential or return the deployment to the unclaimed state. The private reset command replaces the hash directly and revokes sessions.

## 4. Functional requirements

### 4.1 Claim

- The server must expose a claim action only while no credential row exists for the deployment.
- The request boundary must accept an exact, size-limited phone/password payload and reject unknown fields.
- The existing phone normalizer must produce canonical E.164 before persistence.
- Password and confirmation must match in the browser before submission.
- Passwords must contain 15 to 128 Unicode characters. Do not impose uppercase, number, or symbol composition rules.
- Claiming the password and replacing/creating the active owner phone must be one PostgreSQL transaction.
- A database uniqueness constraint must guarantee one credential per deployment.
- Concurrent claim attempts must result in exactly one winner.
- A successful claim must create a new authenticated session without returning the password or password hash.
- A failed or partial claim must not leave the phone and credential owned by different claimants.

### 4.2 Password storage and verification

- Never store, log, return, encrypt, or place the plaintext password in browser storage.
- Use asynchronous scrypt with a unique cryptographically random salt and explicit reviewed work factors that satisfy current OWASP password-storage guidance for the deployed Render plan.
- Store a self-describing encoded hash containing the algorithm version, parameters, salt, and derived verifier.
- Use constant-time verifier comparison.
- Hashing must be bounded so malformed input cannot cause uncontrolled memory or CPU use.
- `APP_ENCRYPTION_KEY`, database credentials, Photon secrets, and Codex credentials must never be reused as the password, salt, pepper, or session secret.
- The stored hash format must support future work-factor upgrades after a successful login.

### 4.3 Login and sessions

- After claim, unauthenticated visitors see only the login page.
- A successful login creates a new random opaque session token with at least 256 bits of entropy.
- Store only a cryptographic hash of the session token in PostgreSQL.
- Store a session-bound CSRF verifier in PostgreSQL.
- Session cookies must be `HttpOnly`, `SameSite=Strict`, `Path=/`, have no `Domain`, and use `Secure` in the production HTTPS deployment.
- Sessions expire after eight hours and are limited to eight active sessions per deployment.
- Logout revokes the current session server-side and clears the cookie.
- Login and claim responses must use `Cache-Control: no-store`.
- Login attempts must have bounded throttling without logging the submitted password.
- Authentication failures must use stable generic errors and must not expose stored hash state.

### 4.4 Protected HTTP surface

Unauthenticated access after claim must be limited to:

- `GET /` redirecting to the claim or login entry point;
- `GET /healthz` with liveness only;
- `GET /readyz` with aggregate ready/not-ready state only;
- the Photon logo and claim/login JavaScript; and
- the claim/login actions required by this PRD.

The following must require a live operator session:

- the complete dashboard page and dashboard JavaScript;
- owner status and phone replacement;
- Photon setup start and status;
- ChatGPT setup start and status;
- device codes and verification URLs;
- the assigned iMessage number;
- detailed readiness and remediation; and
- password change and logout.

Every cookie-authenticated state-changing request must also require a session-bound CSRF token, matching `Origin`, and non-cross-site fetch metadata.

### 4.5 Change password

- The authenticated dashboard must provide **Change password**.
- The operator supplies the current password, new password, and confirmation.
- A successful change atomically replaces the password hash and revokes all existing sessions.
- The current browser is returned to the login page and must authenticate with the new password.
- Wrong-current-password and invalid-new-password responses must not expose credential details.

### 4.6 Forgot-password documentation link

- The login page must display **Forgot password?**.
- It must be a normal HTTPS link to the canonical README heading `Forgot your dashboard password`.
- Open it in a new tab with `rel="noreferrer noopener"`.
- Do not add the service URL, phone number, session, token, or any secret as a query parameter or fragment.
- The link is documentation navigation only; it is not a magic link or password-reset endpoint.

### 4.7 Private reset command

- Add the package script `dashboard:reset-password`, invoked through npm as shown in the recovery journey.
- It must run only as an interactive terminal command against the configured deployment database.
- It must prompt without echoing the password and require confirmation.
- Do not accept the new password as a command-line argument, URL value, environment variable, or standard input pipe.
- It must refuse to operate when no claimed credential exists; initial setup remains a dashboard flow.
- It must transactionally replace the password hash and revoke all dashboard sessions.
- It must print only a safe success/failure message and the operator's next action.
- Database failures must leave the previous hash and sessions unchanged.

The README recovery section must explain:

1. Sign in to the Render account/workspace that owns the service.
2. Open the paid Web Service and select **Shell**.
3. Run the documented `dashboard:reset-password` npm package script.
4. Enter and confirm the new password when prompted.
5. Return to the service URL and log in again.
6. Never paste the password into logs, support tickets, GitHub issues, command arguments, or environment variables.

Render's paid Web Service dashboard shell is the supported recovery path for this Blueprint. SSH may be documented as an equivalent advanced recovery path, but no in-application reset fallback is allowed.

## 5. Data requirements

Use the next available Drizzle migration. Exact names may follow repository conventions, but the schema must represent these concepts:

### Dashboard credential

- deployment ID, unique/primary and foreign-keyed to the deployment;
- encoded password hash;
- hash format/version;
- created timestamp; and
- updated/password-changed timestamp.

### Dashboard session

- hashed session token, unique/primary;
- deployment ID;
- hashed CSRF token;
- created timestamp;
- expiry timestamp; and
- revoked timestamp or equivalent deletion/revocation state.

Database rows must never contain plaintext passwords, plaintext session tokens, raw CSRF tokens, provider credentials, or Codex credentials.

## 6. Migration and compatibility

- Fresh deployments begin `unclaimed` after migrations and database initialization.
- Existing deployments upgrading from the current dashboard also begin `unclaimed` because no password hash exists yet.
- The first successful claim on an existing deployment may confirm or replace the existing owner phone as part of the same transaction.
- Existing Photon and Codex credentials must not be deleted or re-enrolled merely because dashboard authentication is added.
- Removed legacy dashboard environment variables remain unsupported; do not restore `AGENT_PASSWORD` or `DASHBOARD_SETUP_SECRET`.
- Until the claim is complete, Spectrum intake follows the existing owner/provider readiness rules. Dashboard authentication must not be misreported as live-provider verification.
- Rollback must preserve the new tables. Do not down-migrate or delete password/session rows during an application rollback.

## 7. User-interface requirements

- Preserve the existing Photon branding, U.S.-first phone entry, international selector, device-flow polling, return-to-dashboard behavior, progress treatment, compact footer, reduced-motion behavior, and no-green visual direction.
- The claim and login pages must be narrow, mobile-friendly, keyboard accessible, and explicit about what the password protects.
- Do not display masked phone, assigned number, provider state, device code, verification URL, detailed readiness, or change-phone controls before authentication.
- Password fields use appropriate browser autocomplete values:
  - claim/change: `new-password`;
  - login/current password: `current-password`.
- Errors must use an `aria-live` region and must not clear a submitted password before the browser can communicate a validation mismatch, except after successful submission.
- The forgot-password link remains visible on the login page but not on the fresh claim form.

## 8. Security and privacy requirements

- Treat all browser input as untrusted and validate exact payload shapes server-side.
- Protect every cookie-authenticated mutation against CSRF.
- Do not store auth/session material in `localStorage` or `sessionStorage`.
- Do not put credentials in URLs.
- Redact password, password hash, session token, CSRF token, cookies, and reset input from logs and failure events.
- Unknown or unauthenticated browsers must never reach Codex, Photon setup mutation, owner replacement, or detailed status data.
- Models cannot create, change, verify, or reset dashboard credentials.
- Password reset is an operator control-plane action, not an iMessage command or model tool.

## 9. Explicit non-goals

- Email collection, verification, or email-based password reset.
- SMS OTP or phone-number ownership verification for dashboard authentication.
- OAuth, passkeys, social login, multi-factor authentication, or Render SSO.
- Multiple dashboard users, roles, organizations, or a hosted multi-tenant control plane.
- Secret URLs, query-string tokens, or generated passwords rendered on the claim or login page.
- Changes to Photon device authorization, ChatGPT device-code protocol, Codex permissions, messaging behavior, or Supermemory behavior beyond protecting their dashboard surfaces.

## 10. Acceptance criteria

### Claim and persistence

- One fresh deployment can claim with phone and password and continue setup.
- Two concurrent claim requests produce exactly one credential and one active owner phone.
- Password and session state survive a service restart.
- PostgreSQL inspection confirms no plaintext password/session/CSRF value exists.

### Access control

- An unauthenticated browser cannot view owner status, assigned number, device codes, provider status, detailed readiness, or dashboard JavaScript.
- An unauthenticated browser cannot change the owner or start Photon/ChatGPT setup.
- A valid session can use the existing setup flow without provider behavior changes.
- Wrong passwords, expired sessions, revoked sessions, missing CSRF tokens, cross-origin requests, and malformed payloads fail closed.

### Password lifecycle

- Change password requires the current password and revokes every prior session.
- **Forgot password?** opens the exact GitHub README recovery heading with no sensitive URL data.
- The private reset command changes the hash, revokes every session, and never returns the deployment to the unclaimed state.
- The old password and all old session cookies fail after change/reset.
- Password/hash/session values do not appear in logs, HTTP responses, failure rows, or test snapshots.

### Verification

- Add focused unit tests for hashing, payload validation, cookie attributes, CSRF, session expiry, and claim state.
- Add PostgreSQL integration coverage for concurrent claim, password replacement, session revocation, restart persistence, and transaction rollback.
- Update HTTP security tests from the current dashboard contract to the claim/login/protected-dashboard contract.
- Update dashboard script/browser tests for claim, login, logout, change password, and the documentation link.
- Run the repository's required typecheck, unit, security, serial PostgreSQL integration, chaos, docs, migration, and diff checks.
- Run a protected Render smoke test for claim, restart, login, forgot-password documentation, shell reset, and prior-session revocation.
- Keep Photon, ChatGPT, Spectrum, and iMessage live-provider evidence separate; dashboard tests do not prove those providers.

## 11. Implementation plan for the next chat

### Phase 1 — Contracts and migration

1. Reconfirm worktree ownership and start from current `main` without modifying sibling worktrees.
2. Add strict authentication schemas/interfaces and the next Drizzle migration for credentials and sessions.
3. Add PostgreSQL repository methods for atomic claim, session creation/lookup/revocation, password change, and private reset.
4. Add database integration tests before HTTP wiring.

### Phase 2 — Authentication service

1. Implement async scrypt hashing/verification and password validation.
2. Implement opaque database-backed sessions, expiry, maximum-session enforcement, and CSRF verification.
3. Bind the authentication repository only after PostgreSQL/migrations are ready; HTTP liveness may start earlier but auth actions must fail closed until initialization completes.
4. Add unit tests for every state and error code.

### Phase 3 — HTTP and dashboard

1. Add unclaimed claim page, claimed login page, logout, and password-change controls.
2. Make claim atomically configure the owner and credential.
3. Require session plus CSRF/origin/fetch-metadata checks for all private setup mutations.
4. Require the session for private status data and return only aggregate readiness.
5. Preserve the existing provider device-flow UX after authentication.

### Phase 4 — Recovery and documentation

1. Add the `dashboard:reset-password` npm package script with a non-echoing interactive prompt.
2. Add `## Forgot your dashboard password` to the root README with Render Shell instructions.
3. Wire **Forgot password?** to the canonical GitHub README heading.
4. Update architecture, deployment, configuration, operations, troubleshooting, security, decisions, smoke checklist, and docs-contract assertions to match the claim/login/protected-dashboard contract.

### Phase 5 — Verification and handoff

1. Run focused tests first, then every required repository check.
2. Run database tests serially against a disposable PostgreSQL instance; skipped database tests are incomplete evidence.
3. Inspect the full diff, migration, authenticated/unauthenticated response boundary, and credential redaction.
4. Do not commit, push, deploy, or claim live-provider success unless the new chat receives that explicit authorization and corresponding evidence.

## 12. Source guidance

Implementation must recheck current primary documentation before selecting exact work factors or session-library behavior:

- OWASP Password Storage Cheat Sheet: <https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html>
- OWASP Session Management Cheat Sheet: <https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html>
- OWASP CSRF Prevention Cheat Sheet: <https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html>
- Express production security: <https://expressjs.com/en/advanced/best-practice-security.html>
- Render SSH and Shell access: <https://render.com/docs/ssh>
- Render Web Services: <https://render.com/docs/web-services>

This PRD intentionally defines product and acceptance behavior only. It does not implement or verify dashboard authentication.

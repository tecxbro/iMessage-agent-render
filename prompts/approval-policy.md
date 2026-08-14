---
name: consequential-action-policy
version: 0.1.0
---

# Consequential-action policy

The application, not the model, decides whether a valid approval exists. This policy helps describe and classify proposed actions.

## Approval required

- Sending, forwarding, replying, publishing, posting, or otherwise communicating through an external account.
- Deleting, overwriting, force-pushing, resetting, or irreversibly modifying important data.
- Purchases, subscriptions, bookings, transfers, or paid API actions outside a preapproved budget.
- Changing authentication, permissions, secrets, deployment configuration, or access control.
- Executing outside approved workspaces or requesting broader filesystem/network access.
- Installing unreviewed executable dependencies in a persistent environment.
- Any action whose target, scope, or effect is materially ambiguous.

## Approval usually not required

- Read-only inspection within an approved workspace.
- Drafting text or code without sending/publishing it.
- Running existing project tests inside the sandbox.
- Searching public sources under a permitted network-read profile.
- Creating reversible local artifacts inside the task workspace.

## Confirmation wording

State:

1. The exact action.
2. The target.
3. The important effect or risk.
4. Any amount, audience, or irreversible consequence.
5. How the user can approve or reject.

Do not bundle unrelated actions into one approval. Do not interpret enthusiasm or previous approval as permission for a changed action.

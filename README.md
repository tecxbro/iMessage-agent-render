# Build Your Own iMessage Codex Agent

A product and implementation specification for turning the existing Photon × Render “Hello World” starter into a private, Poke-inspired iMessage agent powered by Spectrum Cloud, the Codex SDK, GPT-5.6 model profiles, Supermemory, and a durable PostgreSQL job pipeline.

**Status:** implementation-ready specification
**Verified:** August 14, 2026
**Source starter:** <https://github.com/tecxbro/iMessage-boiler-plate->

## The decisive architecture

```text
User iMessage
  ↓
Photon Spectrum Cloud (persistent gRPC stream)
  ↓
Inbound authorization + deduplication
  ↓
PostgreSQL + pg-boss debounce/cancellation pipeline
  ↓
Interaction agent (Codex thread; human texting voice)
  ├─ direct answer for simple turns
  └─ named execution agents for real work, in parallel when independent
       ↓
Final synthesis + approval gate
  ↓
Stable, resumable outbound iMessage delivery
  ↓
Supermemory writes only durable facts and summaries
```

The service also exposes `/healthz` and `/readyz` for Render, but **iMessage delivery does not use a webhook**. The Spectrum process stays connected through `app.messages` over gRPC.

## Product shape

This is a **single-owner private agent boilerplate**, not a public multi-tenant consumer assistant. The person deploying it:

1. Creates or selects a Photon project.
2. Deploys the service and PostgreSQL database through a Render Blueprint.
3. Performs one private Codex device-login step inside the deployed service, or supplies an OpenAI API key instead.
4. Adds their own iMessage address or phone number to the owner allowlist.
5. Texts the agent and can delegate repository, research, planning, and other skill-backed work.

The Codex TypeScript SDK runs a Codex CLI process inside the deployment. “Sign in with ChatGPT” therefore means **enrolling the private deployment once**; it is not an end-user OAuth button and must not be represented as one.

## Default technology choices

| Concern | Default | Reason |
|---|---|---|
| Messaging | Photon Spectrum Cloud gRPC | Native iMessage transport; no webhook setup; persistent receive stream |
| Agent runtime | `@openai/codex-sdk` + Codex CLI | ChatGPT sign-in, resumable threads, sandbox and approval controls |
| Operational state | Render PostgreSQL + Drizzle | Durable transcript, routing, approvals, retries, and audit data |
| Job system | pg-boss in the same process | PostgreSQL-backed debounce, retry, scheduling, and exactly-once-style job semantics |
| Semantic memory | Supermemory | User profile, durable facts, semantic recall, and explicit deletion |
| Deployment | One Render Web Service + Postgres + persistent disk | Keeps the starter understandable while retaining recovery and durable Codex state |
| Model profiles | Luna / Terra / Sol, configurable | Fast, normal, hard, and deepest task lanes without hard-coding one model |

Convex remains a supported alternative described in [`CONVEX_VARIANT.md`](./CONVEX_VARIANT.md), but it is not the default because it adds another separately provisioned project to a one-click Render installation.

## Documentation map

| File | Purpose |
|---|---|
| [`PRD.md`](./PRD.md) | Product requirements, scope, journeys, metrics, launch gates |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Runtime topology, message pipeline, orchestration, recovery |
| [`REPOSITORY_BLUEPRINT.md`](./REPOSITORY_BLUEPRINT.md) | Exact proposed repository tree and file ownership |
| [`DATA_MODEL.md`](./DATA_MODEL.md) | PostgreSQL tables, keys, retention, job payloads |
| [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) | Eight implementation steps, worktrees, sub-agents, merge order |
| [`MODEL_ROUTING.md`](./MODEL_ROUTING.md) | GPT-5.6 profiles, routing rules, capability probing |
| [`PROMPTING_AND_ORCHESTRATION.md`](./PROMPTING_AND_ORCHESTRATION.md) | Poke-inspired interaction/execution design and schemas |
| [`DEPLOYMENT_AND_AUTH.md`](./DEPLOYMENT_AND_AUTH.md) | Local install, Render Blueprint, Codex device login, recovery |
| [`SECURITY_AND_PRIVACY.md`](./SECURITY_AND_PRIVACY.md) | Authorization, sandboxing, confirmations, secrets, retention |
| [`TEST_PLAN.md`](./TEST_PLAN.md) | Unit, integration, end-to-end, chaos, and security tests |
| [`BUSINESS_PROSPECTS.md`](./BUSINESS_PROSPECTS.md) | Positioning, monetization, market evidence, risks, launch plan |
| [`DOCS_INDEX.md`](./DOCS_INDEX.md) | Markdown-first official documentation links |
| [`DECISIONS.md`](./DECISIONS.md) | Architecture decision records and rejected alternatives |
| [`AGENTS.md`](./AGENTS.md) | Rules for coding agents working on the implementation |
| [`SKILLS.md`](./SKILLS.md) | Skill architecture and initial bundled skills |
| [`prompts/`](./prompts/) | Original prompt specifications; do not copy OpenPoke text verbatim |
| [`skills/`](./skills/) | Codex skill files for transport, runtime, memory, and integration work |

## Recommended build order

The minimum safe merge path is:

```text
Contracts → Spectrum gRPC → PostgreSQL/queue → Codex runtime
          → interaction/execution orchestration → Supermemory
          → security/approvals → Render/auth → full recovery tests
```

Transport, state, Codex, and memory can be developed in parallel after shared interfaces are frozen. The integration worktree owns all cross-cutting merges and end-to-end tests.

## Definition of done

The boilerplate is ready for public use only when all of these are true:

- An authorized owner can deploy, enroll Codex, text the agent, and receive a useful answer.
- Unknown senders cannot invoke Codex or tools.
- A burst of texts becomes one coherent turn.
- A follow-up text cancels or supersedes stale generation without losing earlier messages.
- Restarting during generation or sending does not duplicate or misroute messages.
- ChatGPT/Codex credentials survive restart but never enter PostgreSQL, Supermemory, or logs.
- Memory is scoped to the owner and thread, can be inspected, and can be deleted.
- Model selection is visible, configurable, and never silently downgraded.
- The Render Blueprint passes validation and the deployment guide works from a fresh account.
- The source repo includes current `README.md`, `ARCHITECTURE.md`, `AGENTS.md`, and `docs/llms.txt`-style references.

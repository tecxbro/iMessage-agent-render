# Photon Agent Starter for Render

The smallest useful Photon agent on Render: someone texts your iMessage line, and your service replies **Hello world 👋**.

No LLM. No tools. No database. Just Photon Spectrum webhooks on a single Render Web Service — a clean place to start building a real agent.

## What this template does

```text
User iMessage → Photon → POST /spectrum/webhook → Render Web Service
  → Spectrum verifies + deserializes → inbound text? → space.send("Hello world 👋")
  → Photon → User iMessage
```

Spectrum’s webhook path is the right fit for Render: HTTP deliveries instead of a long-lived `app.messages` stream. See [Spectrum webhooks](https://photon.codes/docs/spectrum-ts/webhooks).

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/tecxbro/iMessage-boiler-plate-)

That button uses this repo’s [`render.yaml`](./render.yaml) Blueprint ([Deploy to Render](https://render.com/docs/deploy-to-render), [Blueprint spec](https://render.com/docs/blueprint-spec)). Render will prompt for the three Photon secrets below.

## Requirements

1. A [Photon](https://app.photon.codes/) project with iMessage configured ([Getting started](https://photon.codes/docs/spectrum-ts/getting-started)).
2. Photon credentials: project id, project secret, and a webhook signing secret.
3. A [Render](https://dashboard.render.com/) account.

## Environment variables

Copy [`.env.example`](./.env.example). Spectrum reads these automatically ([getting started](https://photon.codes/docs/spectrum-ts/getting-started), [webhooks](https://photon.codes/docs/spectrum-ts/webhooks)):

| Variable | Where it comes from |
| --- | --- |
| `SPECTRUM_PROJECT_ID` | Photon dashboard → project **Settings** (or `photon projects show`). |
| `SPECTRUM_PROJECT_SECRET` | Same Settings page / CLI. Treat like a password. |
| `SPECTRUM_WEBHOOK_SECRET` | Returned **once** when you register a webhook URL ([managing webhooks](https://photon.codes/docs/webhooks/managing-webhooks)). Save it immediately. |

On Render, Blueprint create prompts for each (`sync: false` — [configure environment variables](https://render.com/docs/configure-environment-variables)). Never commit real values.

## Configure the webhook

After deploy, open your Render service and copy the public HTTPS URL (e.g. `https://photon-agent.onrender.com`).

Register Photon’s webhook to the Spectrum Express adapter path (default **`/spectrum/webhook`**):

```text
https://<your-render-service>.onrender.com/spectrum/webhook
```

Do that in the Photon dashboard **Webhook** tab, or via the API ([managing webhooks](https://photon.codes/docs/webhooks/managing-webhooks)):

```bash
curl -X POST "https://spectrum.photon.codes/projects/$SPECTRUM_PROJECT_ID/webhooks/" \
  -u "$SPECTRUM_PROJECT_ID:$SPECTRUM_PROJECT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"webhookUrl":"https://<your-render-service>.onrender.com/spectrum/webhook"}'
```

Put the response’s `signingSecret` into Render as `SPECTRUM_WEBHOOK_SECRET`, then redeploy if you added it after the first boot.

Confirm `GET https://<your-render-service>.onrender.com/health` returns `ok`.

## Test

1. Send any text iMessage to your Photon iMessage line (e.g. `hello`).
2. Expect exactly: **Hello world 👋**
3. The incoming text does not change the reply. Reactions, typing, reads, attachments, and other non-text events get no reply.

## Project structure

```text
src/photon.ts   # Spectrum app + inbound text handler
src/server.ts   # Express + Render bind/health + webhook mount
ARCHITECTURE.md # Lifecycle + how to extend
AGENTS.md       # Rules for coding agents working in this repo
render.yaml     # One Render Web Service
.env.example    # The three Spectrum env vars
```

- **`photon.ts`** — Photon only: create Spectrum with the iMessage provider, export `onMessage`.
- **`server.ts`** — HTTP only: mount `@spectrum-ts/express` **before** `express.json()`, `/health`, listen on `PORT` / `0.0.0.0`.
- **`ARCHITECTURE.md`** — request lifecycle and extension map.
- **`AGENTS.md`** — keep the repo small; use native Spectrum APIs.

## Build on top

This v1 is intentionally a Hello World foundation. Common next steps (not included):

- **LLM** — call a model inside `onMessage` (or a new `src/agent.ts`). No provider is prescribed.
- **Tools** — add `src/tools/` when you need them.
- **Memory** — add `src/memory/` when you need persistence; no default database.
- **Richer Photon** — use Spectrum natively (`message.reply`, `space.startTyping` / `stopTyping` / `responding`, markdown, attachments). Start at [messages](https://photon.codes/docs/spectrum-ts/messages), [content](https://photon.codes/docs/spectrum-ts/content), and the LLM index [llms.txt](https://photon.codes/docs/llms.txt).

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the extension map. Do not invent wrappers around Spectrum — teach Photon, not a second API.

## Local run

```bash
cp .env.example .env   # fill in the three Spectrum vars
npm install
npm run build
npm start              # listens on PORT or 10000
```

For local webhook delivery you still need a public HTTPS URL (e.g. ngrok) pointed at `/spectrum/webhook` ([webhooks quickstart](https://photon.codes/docs/webhooks/quickstart)).

## Docs

**Photon / Spectrum:** [getting started](https://photon.codes/docs/spectrum-ts/getting-started) · [webhooks](https://photon.codes/docs/spectrum-ts/webhooks) · [messages](https://photon.codes/docs/spectrum-ts/messages) · [content](https://photon.codes/docs/spectrum-ts/content) · [llms.txt](https://photon.codes/docs/llms.txt)

**Render:** [web services](https://render.com/docs/web-services) · [blueprint spec](https://render.com/docs/blueprint-spec) · [env vars](https://render.com/docs/configure-environment-variables) · [deploy to Render](https://render.com/docs/deploy-to-render)

# Architecture

A few-minute read. This starter is a **Hello World foundation only** — one inbound text path, one reply, no agent framework.

## What this starter is

A Render Web Service that mounts Spectrum’s official Express webhook adapter and answers inbound text with `Hello world 👋`.

It is deliberately small so you can add an LLM, tools, memory, or richer Photon features without fighting empty scaffolding.

## Request lifecycle

1. User sends an iMessage to your Photon line.
2. Photon delivers a signed HTTP `POST` to your Render URL (`/spectrum/webhook` by default).
3. `@spectrum-ts/express` receives the **raw** body and calls `app.webhook(...)`.
4. Spectrum verifies the HMAC (`SPECTRUM_WEBHOOK_SECRET`), deserializes the payload, and rehydrates `space` + `message`.
5. Your `onMessage(space, message)` runs (fire-and-forget after the HTTP ack).
6. Handler keeps only inbound `content.type === "text"`, then `await space.send("Hello world 👋")`.
7. Photon delivers that outbound message back to the user as iMessage.

Outbound echoes and non-text events (reactions, typing, reads, attachments, group events, edits, unsends) are ignored.

Docs: [webhooks](https://photon.codes/docs/spectrum-ts/webhooks) · [messages](https://photon.codes/docs/spectrum-ts/messages)

## File ownership

| File | Owns |
| --- | --- |
| `src/photon.ts` | Spectrum app, iMessage provider, `onMessage` business logic |
| `src/server.ts` | Express app, webhook mount order, `/health`, `PORT` / `0.0.0.0` |
| `render.yaml` | Exactly one Render Web Service + secret env prompts |
| `.env.example` | The three Spectrum credential names |
| `README.md` | Zero-to-deploy for humans |
| `AGENTS.md` | Rules for coding agents |

Transport (`server.ts`) stays separate from Photon behavior (`photon.ts`).

## How to extend

### LLM

Add something like `src/agent.ts` and call it from `onMessage`. This repo does not pick OpenAI / OpenRouter / Anthropic / etc. — choose what you need when you need it.

### Tools

Create `src/tools/` when tool calling becomes real. Do not pre-create empty folders.

### Memory

Create `src/memory/` when you need persistence. No default Postgres / Redis / vector DB — pick storage when the product requires it.

### Richer Photon features

Use Spectrum APIs directly — do not wrap them:

- Content shapes: [content](https://photon.codes/docs/spectrum-ts/content)
- Threaded replies: `await message.reply("...")` — [reactions and replies](https://photon.codes/docs/spectrum-ts/reactions-and-replies)
- Typing: `space.startTyping()` / `space.stopTyping()` / `space.responding(fn)` — [typing indicators](https://photon.codes/docs/spectrum-ts/content/typing-indicators)
- Markdown: [markdown](https://photon.codes/docs/spectrum-ts/content/markdown)

LLM-oriented index: [https://photon.codes/docs/llms.txt](https://photon.codes/docs/llms.txt)

### Render

Stay on one Web Service until you have a concrete need for workers, cron, databases, or workflows. Consult [web services](https://render.com/docs/web-services) and the [blueprint spec](https://render.com/docs/blueprint-spec).

## Non-goals (v1)

Not implemented: LLMs, tool calling, MCP, memory stores, auth, Mini Apps, attachments/polls/voice as product features, multiple Spectrum providers, multiple Render services, custom Photon wrapper APIs, custom agent frameworks.

Those are extension paths above — not missing folders.

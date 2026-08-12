# AGENTS.md

This repository is an **intentionally minimal** Photon × Render starter. Prefer the smallest change that teaches Photon/Spectrum and ships on Render.

Do **not** add infrastructure, dependencies, folders, or abstractions “just in case.” Add them when a real requirement appears.

## Architecture map

| Concern | Where |
| --- | --- |
| Spectrum app + inbound handler | `src/photon.ts` |
| HTTP / Render runtime | `src/server.ts` |
| Deploy blueprint | `render.yaml` |
| Human zero-to-deploy | `README.md` |
| Lifecycle + extension map | `ARCHITECTURE.md` |
| Spectrum credentials (names only) | `.env.example` |

Runtime should stay readable in one pass.

## Photon rules

1. **Read current docs before inventing APIs.** Start at [llms.txt](https://photon.codes/docs/llms.txt), then [getting started](https://photon.codes/docs/spectrum-ts/getting-started), [webhooks](https://photon.codes/docs/spectrum-ts/webhooks), [messages](https://photon.codes/docs/spectrum-ts/messages), [content](https://photon.codes/docs/spectrum-ts/content).
2. **Use native Spectrum APIs.** `space.send`, `message.reply`, `space.startTyping`, `space.stopTyping`, `space.responding`, content builders — not custom `sendText` / `sendMarkdown` / `sendReply` helpers.
3. **Do not wrap Photon.** Teach Spectrum; do not build a second SDK on top of it.
4. **Keep transport separate from behavior.** Express + `@spectrum-ts/express` in `server.ts`; message logic in `photon.ts` (or files you add later like `agent.ts`).
5. **Leave verification to Spectrum.** Do not hand-roll HMAC, raw-body reconstruction, or attachment rehydration — the official Express adapter exists for that.
6. **Mount the Spectrum adapter before `express.json()`.** Raw body is required for signature verification ([webhooks](https://photon.codes/docs/spectrum-ts/webhooks)).
7. Prefer Spectrum env vars: `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`, `SPECTRUM_WEBHOOK_SECRET`.

## Render rules

1. **One Web Service** is the default (`render.yaml`). Do not add workers, cron, databases, KV, private services, or workflows unless the task explicitly needs them.
2. Secrets use `sync: false` so Blueprint create prompts for values ([env vars](https://render.com/docs/configure-environment-variables)).
3. Bind `0.0.0.0` and `process.env.PORT`. Keep `healthCheckPath: /health`.
4. Consult [web services](https://render.com/docs/web-services), [blueprint spec](https://render.com/docs/blueprint-spec), [deploy to Render](https://render.com/docs/deploy-to-render).

## Extension map

When (and only when) needed:

| Capability | Suggested home |
| --- | --- |
| LLM / agent reasoning | `src/agent.ts` (no prescribed provider) |
| Tools | `src/tools/` |
| Memory | `src/memory/` (no default DB) |
| Richer Photon UX | Spectrum docs + native APIs |

Do not scaffold these folders empty.

## Deletion / anti-speculation rule

Do not anticipate hypothetical future requirements. No LLM SDKs, MCP, memory layers, agent frameworks, multi-service blueprints, or Photon wrapper modules until a concrete feature needs them.

If a change makes the Hello World path harder to read, it does not belong in this starter’s default shape.

## V1 behavior to preserve

- Inbound text → `Hello world 👋`
- Non-text → no reply
- Outbound → no reply
- Packages: `spectrum-ts` + `@spectrum-ts/express` + Express only for the Photon webhook path

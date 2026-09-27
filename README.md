# Walkaway (working name)

Find your subscriptions, walk each service's cancellation flow **just far enough to surface the
loyalty discount, accept it — and never actually cancel.** Pay 15% of verified savings,
$0 if nothing is saved.

| Path | What it is |
|---|---|
| `STATUS.md` | **Start here.** Current state, what's live, what's next, and a short history. |
| `landing/` | Static landing page, served by the Cloudflare Worker as assets. See `landing/README.md`. |
| `extension/` | The Chrome extension (WXT + React): Scan (AI discovery of signed-in subscription services) and Hunt (AI-driven cancellation-flow navigation that accepts loyalty offers and can never finalize a cancel). See `extension/README.md`. |
| `netlify/functions/` | The API handlers (`/api/discover`, `/api/classify`, `/api/agent-step`, Stripe `/api/checkout`, `/api/checkout-status`, `/api/settle`). Run by the Cloudflare Worker in production (Gemini, pinned by `AI_PROVIDER`); the folder name is historical. |
| `shared/` | Code used by both sides: `guardrails.js` (the safety rules), `page-scripts.js` (in-page snapshot/actions), `sensitive.js` (never-touch sites), `scrub.js` (secret and personal-data scrubbing), `services.js` (catalog of known services), `accounts.js` (work accounts, sign-in hosts), `brain-mock.js` (rule-based test brain). |
| `testbed/` | "Streamly": a fake subscription service driven by **100 scenario configs** (`scenarios.js`) — entry locations, survey types, pause/downgrade traps, dark-pattern offers, login walls, noise. Deploy as a second Netlify site (base dir `testbed`). |
| `scripts/` | `api-server.mjs` (the functions as a standalone server), `suite.mjs` (**the 100-scenario suite, scored 0–100**), `latency.mjs` (p50/p95 per endpoint), `probe-timeout.mjs` (the real function time limit of a deployed site), `e2e-testbed.mjs` (3-scenario smoke), `test-stripe.mjs` (Stripe test-mode integration), `package-extension.mjs`. |
| `TODO.md` | The short list of what to do next. |
| `LOGGING_TODO.md` | The plan for server-side logging, the retention-offer database and learning from flows. |
| `CLAUDE.md` | Rules and conventions for Claude Code sessions. |
| `ARCHITECTURE.md` | How the pieces fit: what the extension does, what the backend does, where state lives. |
| `HISTORY.md` | What was built and measured, and why each decision went the way it did. |
| `IMPLEMENTATION_PLAN.md` | Architecture, decisions, phases, deploy steps. |
| `worker/` | The Cloudflare Worker entry: routes `/api/*` to the handlers, serves `landing/` as assets. |
| `wrangler.jsonc` | Worker config. `npm run cf:dev` runs it locally on the real runtime; `npm run cf:deploy` ships it. |
| `netlify.toml` | The Netlify path, kept working as an alternative host. |

**Quick start:** `npm install && npm test` (unit tests, free) and `npm run suite:mock` (all 100 scenarios, mock brain, free). `npm run suite` runs 5 scenarios on the real model from `.env` (costs a few cents); `npm run suite:full` runs all 100 (about $1–2).

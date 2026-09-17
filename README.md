# Walkaway (working name)

Find your subscriptions, walk each service's cancellation flow **just far enough to surface the
loyalty discount, accept it — and never actually cancel.** Pay 10% of verified savings, $1 minimum,
$0 if nothing is saved.

| Path | What it is |
|---|---|
| `landing/` | Static landing page + waitlist. Netlify, auto-deploys from `main`. See `landing/README.md`. |
| `extension/` | The Chrome extension (WXT + React): Scan (AI discovery of signed-in subscription services) and Hunt (AI-driven cancellation-flow navigation that accepts loyalty offers and can never finalize a cancel). See `extension/README.md`. |
| `netlify/functions/` | The brain (`/api/discover`, `/api/classify`, `/api/agent-step`) on **Anthropic or Gemini** (`ANTHROPIC_API_KEY` / `GEMINI_API_KEY`, `AI_PROVIDER`), plus Stripe (`/api/checkout`, `/api/checkout-status`, `/api/settle`, `STRIPE_SECRET_KEY`). Deployed with the landing site. |
| `shared/` | Code used by both sides: `guardrails.js` (the safety rules), `page-scripts.js` (in-page snapshot/actions), `brain-mock.js` (rule-based test brain). |
| `testbed/` | "Streamly": a fake subscription service driven by **100 scenario configs** (`scenarios.js`) — entry locations, survey types, pause/downgrade traps, dark-pattern offers, login walls, noise. Deploy as a second Netlify site (base dir `testbed`). |
| `scripts/` | `api-server.mjs` (the functions as a standalone server), `suite.mjs` (**the 100-scenario suite, scored 0–100**), `latency.mjs` (p50/p95 per endpoint), `probe-timeout.mjs` (the real function time limit of a deployed site), `e2e-testbed.mjs` (3-scenario smoke), `test-stripe.mjs` (Stripe test-mode integration), `package-extension.mjs`. |
| `TODO.md` | **Start here.** The short list of what to do next. |
| `HISTORY.md` | What was built and measured, and why each decision went the way it did. |
| `IMPLEMENTATION_PLAN.md` | Architecture, decisions, phases, deploy steps. |
| `netlify.toml` | Publishes `landing/`, bundles the functions, security headers. |

**Quick start:** `npm install && npm run suite:mock` (no keys) runs all 100 scenarios and prints the score; `npm run suite` uses the real brain from `.env`.

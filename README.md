# Walkaway (working name)

Find your subscriptions, walk each service's cancellation flow **just far enough to surface the
loyalty discount, accept it — and never actually cancel.** Pay 10% of verified savings, $1 minimum,
$0 if nothing is saved.

| Path | What it is |
|---|---|
| `landing/` | Static landing page + waitlist. Netlify, auto-deploys from `main`. See `landing/README.md`. |
| `extension/` | The Chrome extension (WXT + React): Scan (AI discovery of signed-in subscription services) and Hunt (AI-driven cancellation-flow navigation that accepts loyalty offers and can never finalize a cancel). See `extension/README.md`. |
| `netlify/functions/` | The brain: `/api/discover`, `/api/classify`, `/api/agent-step` (Claude via structured outputs). Deployed with the landing site. Needs `ANTHROPIC_API_KEY`. |
| `shared/` | Code used by both sides: `guardrails.js` (the safety rules), `page-scripts.js` (in-page snapshot/actions), `brain-mock.js` (rule-based test brain), `playbooks.js` (curated services). |
| `testbed/` | "Streamly": a fake subscription service with a 3-step cancel flow + retention offer, for testing. Deploy as a second Netlify site (base dir `testbed`). |
| `scripts/` | `dev-api.mjs` (run the functions locally), `e2e-testbed.mjs` (headless end-to-end: 3 scenarios). |
| `IMPLEMENTATION_PLAN.md` | Architecture, decisions, phases, deploy steps. |
| `netlify.toml` | Publishes `landing/`, bundles the functions, security headers. |

**Quick start:** `npm install && npm run e2e:testbed:mock` (no API key needed) proves the loop end to end.

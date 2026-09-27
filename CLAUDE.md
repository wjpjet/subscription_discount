# Walkaway — notes for Claude Code

Start with **STATUS.md** (current state, what's live, what's next), then TODO.md, ARCHITECTURE.md, HISTORY.md.
LOGGING_TODO.md holds the plan for server-side logging and the offer database.

## Rules that never bend

- Nothing may ever finalize a cancellation, decline an offer, pause, downgrade, switch plans or buy. The model has
  no finalize action; `shared/guardrails.js` enforces the rest on the server and again in the extension.
- Banks, government, health, insurance and payroll sites (`shared/sensitive.js`) and the user's Never-explore list
  are never sent to the model, opened or walked.
- Only confirmed paid **personal** plans are walked (never work accounts, duplicates, unconfirmed or billed-elsewhere).
- Everything leaving the browser goes through `shared/scrub.js` (`sanitizeSnapshot` at the `api.ts` boundary);
  logs use `redactForLog`. Never log or commit tokens, card data, addresses or full emails.
- Never commit `.env`, `.dev.vars`, test logs (`walkaway-test-log-*.json`), `results/` or `flows/`. The owner's
  test logs contain personal data: read them to debug, never quote personal strings from them into code or docs.

## Cost

Tests that call the real model (Gemini) cost money. **Don't run them without asking.** Verify with the free ones:
`npm test`, `npm run e2e:extension` (mock), `npm run suite:mock`, `npm run flows -- <...> --replay` (mock). When a
real check is needed, propose `npm run suite` (5 scenarios) or `npm run e2e:extension -- --find --real`.

## Conventions

- Code style: dense, readable lines; short comments that say why. Functions in `shared/page-scripts.js` are
  injected into pages: fully self-contained ES5, no imports or closures.
- Copy style: plain words. The fee is "15% of what we actually save you"; never call it a tip. "No savings? No charge."
- Shipping: merge to main, `npm run cf:deploy`, `npm run package:extension`, commit the zip, push, deploy again.
  Pushing main also rebuilds the Streamly test site on Netlify. Update HISTORY.md, TODO.md and STATUS.md.
- Adversarial review before shipping non-trivial changes has caught real bugs every time; keep doing it.

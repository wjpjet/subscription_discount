# Walkaway — status and handoff (2026-09-27)

Read this first when picking the project up. Then **TODO.md** (what's next), **ARCHITECTURE.md** (how it works),
**HISTORY.md** (what happened and why), **LOGGING_TODO.md** (the next big piece). Agent rules are in **CLAUDE.md**.

## What it is

A Chrome extension plus one backend. It finds the subscriptions a person is signed into, walks each cancellation
flow **only as far as the retention ("loyalty") offer**, pauses there, and after the person picks offers and saves a
card, accepts them, verifies the new price on the billing page, and charges **15% of verified savings** (no
minimum; under 50¢ is waived). It can never finalize a cancellation.

## What is live

| Piece | Where | State |
|---|---|---|
| Backend + landing page | One Cloudflare Worker, https://walkaway.willem-jeffrey-prins.workers.dev (Workers Paid plan) | Deployed from main at `8981e5c` ("live-log fixes"). **One commit behind main** (see "Not shipped") |
| Extension | `landing/downloads/walkaway-extension.zip`, served by the Worker; load unpacked from `extension/.output/chrome-mv3` | Built from `8981e5c` |
| Test site "Streamly" | https://streamly-testbed.netlify.app (Netlify, rebuilds on every push to main) | Current |
| Payments | Stripe **test mode** (setup mode: card saved, charged after the run) | Test keys only |
| Model | Gemini 3.8 Flash for walk steps, 3.1 Flash-Lite for classify/discover; `AI_PROVIDER=gemini` pinned in `wrangler.jsonc` | GLM-5.3 and DeepSeek V4.1 were tested and rejected (HISTORY.md) |

## Not shipped yet

Main is ahead of production by the "second live run" commit: sparse-page waits, 404 recovery, price hops,
Twitch/Google One handling, the page **recording** for replay tests, `npm run flows`, and the 5-scenario paid suite.
To ship (from the main checkout):

```
npm run cf:deploy
npm run package:extension && git add landing/downloads && git commit -m "Repackage the extension" && git push origin main
npm run cf:deploy          # again, so the landing page serves the new zip
```

Then reload the extension at `chrome://extensions`.

## Where things stand

- **Two live test-mode scans done**, both read-only, on the owner's own browser (logs in the repo root,
  git-ignored, personal data: never commit or share them).
  - Run 1 (`walkaway-test-log-2026-09-27T00-21-25.json`): exposed 49 problems (page text full of script code,
    404s reported as "signed out", employer accounts counted, tokens in logs). All fixed, plus 27 more from a
    review of the fix.
  - Run 2 (`walkaway-test-log-2026-09-27T16-29-55.json`): 5 real paid plans found, nothing false under Paying, no
    secrets in the log. Remaining issues fixed in the unshipped commit.
- **No real walk run yet.** Next live run: test mode with **Also walk cancellation flows** on, and **Record each
  page for replay tests** on. Then `npm run review-log -- <log>` and `npm run flows -- <log>`.
- **Plan after that:** build realistic edge-case tests from the recorded real flows (the 100 synthetic Streamly
  scenarios were judged repetitive), then the logging/offer-database foundation (LOGGING_TODO.md).

## Owner actions still open

- Sign out of all Together AI sessions; sign out and back in at Best Buy and Walmart (run 1 captured live session
  tokens in page text before the fix).
- Move or delete `walkaway-test-log-2026-09-27T00-21-25.json` from the repo folder.
- Rotate the Gemini API key and revoke the Together key (both were pasted into a chat).
- Before real users: see "Before real users" in TODO.md (privacy policy, contact email, Web Store listing, live
  Stripe keys, lawyer review of terms).

## How a scan works now (short)

1. **Discover** — cookie domains (names and flags only) → never-touch sites withheld (banks, government, health,
   insurance, payroll, the user's Never-explore list) → ~30 known services matched from a built-in catalog
   (`shared/services.js`, not sent to the model) → the rest classified by Gemini in parallel chunks.
2. **Probe** — each account page opened in a background tab, read when it has actually rendered, classified
   (page kind first: plan page, sign-in, 404, loading, robot check, sales page…). Up to 2 recovery hops (404 →
   next URL → home page; the page's own Billing link; the catalog's price page). Statuses: paying, billed
   elsewhere, free plan, signed out, work account, needs a look, same account, sensitive.
3. **Find** — only confirmed paid personal plans are walked, 3 at a time, up to the offer, paused there.
4. **Accept** (after payment) — only in a tab that is provably ours, on the unchanged offer screen; otherwise re-walk.
   Then verify on the billing page and settle.

Safety layers: the model has no "finalize" action; deterministic guardrails on the server and again in the
extension (finalize/decline text, pause/downgrade/plan-switch/purchase buttons, cancel buttons on offer screens,
never-touch hosts); the live button text is re-read at click time; element ids are tied to the snapshot they came
from; everything is scrubbed (tokens, card data, addresses; emails masked in logs) before leaving the browser.

## Testing (what's free and what costs money)

| Command | What | Cost |
|---|---|---|
| `npm test` | All unit tests + the hunt/scan harnesses (never-touch lists, guardrails, scrubbing, reveal lines, page reader, walks, probes) | Free |
| `npm run e2e:extension` (`-- --find`, `-- --sensitive`) | The real extension in Chrome against local Streamly, mock brain | Free |
| `npm run suite:mock` | All 100 Streamly scenarios, mock brain (baseline: score 38, safety 100, achievable 49) | Free |
| `npm run flows -- <log or flows/run> --replay` | Replay recorded real flows, mock brain | Free |
| `npm run suite` | 5 representative scenarios, real Gemini | A few cents |
| `npm run e2e:extension -- --find --real` | One scan + walk on Streamly, real Gemini | About a cent |
| `npm run suite:full` | All 100, real Gemini (last real baseline: score 76, achievable 100, offer accuracy 98%) | About $1–2 |
| `npm run flows -- ... --replay --real --max=10` | Replay recorded flows on real Gemini, capped | Cents |

**The owner asked: do not run paid tests without asking first.** Verify with the free ones.

## Known gaps (not bugs so much as next steps)

- Emails are missing where the site shows the address only when its account menu is opened (Amazon, Claude,
  Netflix, Twitch); the probe never clicks, so those rows show the account's name.
- No price for plans whose page doesn't show one (LinkedIn); Claude's price only from matching invoice history.
- Employer domains are still sent to discovery by name unless listed in Never-explore (TODO: a "work domains"
  setting).
- Cookie-rule change (bare `user`/`secure` no longer count as session cookies) needs checking on the next log.
- Iframes are recorded but not read.
- The Anthropic provider path is broken with the installed SDK (zod v4 vs v3); Gemini is unaffected.

## Working on it with Claude Code (practical notes)

- Work in a git worktree for changes; commit there, then fast-forward main. In a worktree, symlink
  `node_modules` and `extension/node_modules` from the main checkout, and run `npx wxt prepare` in `extension/`
  once before `extension/node_modules/.bin/tsc --noEmit -p extension`.
- Secrets live in `.env` in the main checkout (never committed) and as Worker secrets (`wrangler secret put`).
  Real-model scripts read them with `node --env-file=<main>/.env ...`.
- Keep the docs current when shipping: HISTORY.md (what and why), TODO.md (what's next), ARCHITECTURE.md if the
  flow changes, and this file.

## History in one screen

- **Sep 13–15:** extension (WXT/React side panel), backend on Netlify Functions, Streamly testbed with 100
  scenarios, guardrails, Stripe; Chrome Web Store readiness review.
- **Sep 17–18:** model comparison (Gemini stays), moved the backend to one Cloudflare Worker, switched payment to
  "save the card, charge after" (no $1 hold), per-service picks, "find the offer during the scan, accept after
  payment".
- **Sep 23:** per-subscription display (who, what you pay, when the saving lands, trials), cookie discovery review,
  live-filling scan screen, landing copy pass; fee set to 15% with no minimum.
- **Sep 26:** test mode (log everything, never accept or charge) and the never-touch rules for banks and the like.
- **Sep 27:** two live read-only scans and three rounds of fixes (page reader, classifier with page kinds,
  statuses, recovery hops, scrubbing, tab ownership, never-click widening), each adversarially reviewed; page
  recording + flow replay; small paid test set; logging plan written.

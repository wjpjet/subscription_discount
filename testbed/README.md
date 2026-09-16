# Streamly — the Walkaway testbed

A fake streaming service with a realistic cancellation flow, for testing the extension end to end
without touching a real account. Static, client-side only (state in `localStorage`, session is a
plain cookie), so it hosts on Netlify for free.

**Flow:** Sign in → avatar menu → Settings → Subscription → *Cancel subscription* (small link at the
bottom) → Step 1 reason survey (Continue is disabled until you pick a reason) → **Step 2 retention
offer** ("50% off for 3 months" — *Accept offer* / *No thanks, continue cancelling*) → Step 3 *Are you
sure?* (*Keep my subscription* / **Confirm cancellation**) → Cancelled.

Accepting the offer changes the Subscription page to **$8.99/month for 3 months, then $17.99/month**
with a "Loyalty offer applied" badge — that's what the extension's verification step reads.

**Sign in:** any email, password `walkaway`, then the verification code `424242`. A real session cookie
(`streamly_session`) is set — that's what the extension's signed-in check sees — and signing out or
clearing cookies logs you out.

**Scenarios.** The flow is driven by a scenario config (`scenarios.js`, ~100 variations: where the
cancel link lives, survey types, pause/downgrade traps, offer styles incl. dark patterns, hidden/
delayed/modal offers, confirm-button labels, login walls, cookie banners, decoy Cancel buttons,
misleading text). Open `/scenarios` to pick one (or `/?scenario=S042`). The yellow bar shows the
current scenario, its expected outcome, and the live status; **Reset state** reruns it.

Run them all headlessly with a score: `npm run suite:mock` (no keys) or `npm run suite` (real brain).

If a run ever lands on `/cancel/done`, the agent pressed the final cancel — that's the failure the
guardrails exist to prevent, and the page says so loudly.

## Deploy (second Netlify site)
Netlify → **Add new site → Import from Git** → this repo → **Base directory: `testbed`**, build
command empty, publish `.` (from `testbed/netlify.toml`). You'll get e.g.
`https://streamly-testbed.netlify.app`. Or drag the `testbed` folder onto <https://app.netlify.com/drop>.

## Use with the extension
Open the Walkaway side panel → ⚙ Settings → **Test mode ON**, test domain = your testbed host
(e.g. `streamly-testbed.netlify.app`), account URL = `https://<host>/settings/subscription`.
Sign in to Streamly in that browser first. Then **Scan** → **Get these discounts**.

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

**Sign in:** any email, password `walkaway`.

**Testbed controls** (yellow bar at the bottom, visible when signed in):
- **Reset state** — removes an applied offer / un-cancels, so you can rerun.
- **Retention offer: ON/OFF** — OFF simulates a service that makes no offer (the flow goes straight
  from the survey to *Are you sure?*). Use it to check the agent backs out instead of cancelling.
- **Sign out.**

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

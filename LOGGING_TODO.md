# Walkaway — logging, offer database and learning (to do later)

High-level plan, written 2026-09-27. Nothing here is built yet. Research notes behind it (Cloudflare pricing,
privacy and chargeback rules, where the code hooks in) were gathered the same day; the key facts are below.

## What we want

1. A **global database of retention offers**: which services offer what, when, after which steps.
2. A way to **learn from cancellation flows**: which paths reach offers, fed back into the walker.
3. **Per-run records** of success and failure with step details: to investigate bugs, to defend against false
   claims ("you cancelled my subscription", chargebacks), and to verify how things actually ended.
4. All of it **cheap** and **safe**.

## The approach

Record on our own server, in the Cloudflare Worker we already run, into **D1** (SQL database) plus a private
**R2** bucket (files). Every walk step already passes through `/api/agent-step`, so the server can record what it
decided with no extra requests, written after the response goes out (`ctx.waitUntil`), so nothing gets slower.
A server-side record is also better evidence than anything the extension reports about itself.

Not Workers Logs / Logpush: 7-day retention, sampling, truncation, no schema. Debugging only; keep console lean.
Analytics Engine is optional for dashboards (sampled, 3-month retention), not a record store.

## Three tiers of data, three sets of rules

| Tier | What | Identity | Kept |
|---|---|---|---|
| **Offer database** | Service, offer terms (% off, months, new price, free months), the step path that reached it (screen types + button labels), month, outcome (found / accepted / verified) | None. No user id, email, IP; names scrubbed from offer text. Only use or show a figure once ≥ 5 distinct runs support it | Indefinitely (anonymous) |
| **Run records** | Per run: outcome, error kind, timings, model usage. Per service: the step list (screen type, action, button label, guardrail notes, whether it worked) | Random run id. Paid runs also get a keyed hash (HMAC) of the email, only to find a person's runs for support or deletion | Step detail 30–90 days; unpaid run summaries 90 days |
| **Dispute evidence** (paid runs only) | Offer screen + accept click + confirmation screen + billing page before/after (scrubbed, form fields as `[filled]`), the checkout consent record | Linked to the paid run | 24 months after the charge |

Why 24 months: card disputes can arrive up to 540 days after a charge in some cases (Visa/Mastercard), plus 2–3
months of process; Amex expects 24 months of transaction records in the US. Stripe accepts dispute evidence as
PDF/JPEG/PNG under 4.5 MB, so the useful artifact is a one-page receipt: these buttons were pressed, no final
cancel was pressed, the price went from $X to $Y.

## Tamper-evidence

- Evidence files are write-once (create-if-absent) under an R2 bucket lock for 24 months; each file's SHA-256 is
  stored in D1.
- The run's final evidence hash goes into the Stripe PaymentIntent metadata: an outside, timestamped witness.
- Keep personal data out of the locked prefix beyond what dispute defence needs (a lock also blocks erasure).

## Learning loop

- A nightly job (a Worker cron or Cloudflare Workflow) aggregates, per service, which normalized step path most
  often reached an offer.
- `/api/agent-step` passes that path to the model as `priorPath` when the extension sends none. `decide()` already
  supports it. The guardrails never see priorPath, so a learned path cannot get around them.
- Normalize paths before sharing them globally (they contain per-user labels and URLs).
- Pair with the local recorded flows (`npm run flows`) for replay tests.

## Safety rules

- Re-scrub everything on the server before storing (today the server never re-sanitizes; a modified client could
  send anything). Use `shared/scrub.js` `redactForLog` plus the form-field masking from `recordSnapshot`.
- Never store plain emails, cookies, passwords or card data. IPs only in short-lived operational logs, truncated.
- Private bucket, no r2.dev public URL. Choose the `eu` jurisdiction at creation if there will be EU users (can't
  be changed later).
- Admin page: a **separate** small Worker behind Cloudflare Access (free for up to 50 users). Worker-level Access
  on the main Worker would lock the extension out of `/api`.
- Fill the offer database only from decisions the server made, never from client reports, so it can't be
  poisoned cheaply.
- Chrome Web Store Limited Use: a person may not read an individual user's run data without that user's explicit
  consent (automated analysis and aggregates are fine; your own runs are fine). So: a "Send this run to support"
  button, and checkout wording like "we keep a record of this run for 24 months to show you or your card issuer
  what happened".
- Re-sending stored page data to Gemini for offline learning is only OK on the paid API tier.
- Service names linked to a person can be sensitive (therapy, dating). Keep per-user service lists short-lived.

## Things this forces us to change

- `landing/privacy.html` promises page text is "not stored beyond the run", still lists Netlify as the backend,
  lacks the Chrome "Limited Use" sentence, and has a placeholder contact address.
- The consent screen (`App.tsx`), `store/LISTING.md` ("not stored beyond the run"), and ARCHITECTURE.md ("no
  database") all say the same. Existing users must see the change and agree again.
- Add a retention schedule and a deletion path ("Delete my data" in the extension, plus email) to the policy.

## Gaps to close at the same time

- **Stable run ids.** The extension sends a new `runId` on every step today; nothing links probe, find, accept and
  payment. Create a scan id and a per-service walk id, carry them through agent-step, classify, checkout and settle.
- **Fee computed on the server.** `settle` charges 15% of whatever `verifiedSavingsUsd` the extension sends. The
  server should compute it from the verification it recorded.
- **The accept click.** The final in-place "accept offer" click has no server decision behind it. Record it on the
  server (intent + screen fingerprint) before the click.
- **Write endpoints need auth.** CORS is `*` and the client key is optional; a report endpoint would be writable by
  anyone. Issue a signed run token at scan start.

## Cost

Per run (~10 services probed, ~4 walked × ~10 steps): about 150 D1 rows written and 60 KB of evidence.

| Runs per month | Extra cost |
|---|---|
| 1,000 | $0 (inside the Workers Paid allowances) |
| 50,000 | about $0.25–$3.80 (R2 storage, D1 storage beyond 5 GB) |

For scale: the model costs about $0.06 per run, so logging stays well under 1%. At 50k runs/month D1 needs
tiering (summary rows kept, step rows pruned after 90 days, full JSON in R2) to stay under its 10 GB per-database cap.

## Order

1. **Foundation:** D1 + R2 bindings; stable run ids; step records from agent-step; one outcome report per service;
   payment linked to the run; evidence receipts with the hash in Stripe; server-side fee; daily deletion job;
   privacy / consent / listing updates.
2. **Learning:** the offer table and nightly aggregation; learned paths as priorPath; the admin page.
3. **Did it hold?** On the next scan, re-check that each accepted discount actually applied at renewal.

## Decisions needed first

- Where you and your users are based (EU storage must be chosen at creation).
- The retention periods above.
- A lawyer on: which country you operate from (GDPR), reading run data for chargeback defence without consent,
  and the checkout terms (Visa's stored-credential disclosure rules for charging a saved card later).

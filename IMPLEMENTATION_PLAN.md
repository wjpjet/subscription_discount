# Walkaway — Implementation Plan (v6)

> **Working name: "Walkaway"** (placeholder). *Every subscription has a walkaway price.* A Chrome
> extension (+ thin backend) — **one button**: it finds the subscription services you're signed into,
> reads what you pay, then walks each cancellation flow **just far enough to surface the loyalty
> discount, accepts it, and never actually cancels.** 10% of verified savings, $1 minimum, $0 otherwise.

_Last updated: 2026-09-09 · Scope: personal / a few users · Autonomy: hands-off · One workflow, no A/B_
_**v6:** checkout places a **temporary hold** (hotel model) and captures only verified savings — closes the bogus-card gap; Phase 2 build spec; open decisions. **v5:** no account required; Scan reveals the **services** and the **total** (not per-service amounts); checkout = card + email (password optional); summary + receipt emailed. v4: extension-only, "sites you're signed into", no history; email/bank deferred._

---

## 1. Context (what the research settled)

- **Models are good enough; authenticated flows are the hard part** (~30–65% unattended success;
  cloud agents fail login+2FA ~6/10). A browser extension using the user's **existing logged-in
  sessions** removes the auth problem entirely, costs nothing per run, and is the strongest legal
  posture (*Amazon v. Perplexity*, 9th Cir. Aug 2026). You never hold credentials.
- **"Don't click the final cancel" lives in deterministic code, not a prompt:** the action doesn't
  exist in the agent's toolset; every screen is classified; ambiguity → back out.
- **Save offers persist** but some services never offer (Netflix, Prime, Disney+), and MN bans in-flow
  offers. The agent must *know* which merchants make offers (playbooks) and skip the rest.
- **Competition:** Rocket Money "Rowan" (Aug 2026), Pine AI (10–30% tip), bill negotiators (35–60%).
  The cancel-to-harvest loop at 10% is open whitespace.

### The core reframe
**This product never wants to cancel anything.** It walks to the edge, grabs a discount if offered,
and retreats if not. "Confirm cancellation" is never a correct action.

---

## 2. Decisions locked in

| Decision | Choice | Notes |
|---|---|---|
| **Workflow** | **One:** install → Scan → *services + total* → Checkout → Hunt → emailed summary | No A/B. Email/bank intake = later features. |
| **Account** | **Not required.** Anonymous session by default; email collected at checkout; password optional | Supabase anonymous sign-in, upgradeable to a real account later. |
| **Reveal rule** | Before paying: show **which** services make offers and the **total** estimated savings — **never per-service amounts** | Per-service before/after appears only in the post-run summary. |
| **Detection** | **Cookies → account page** ("sites you're signed into") | No `history` permission (scary warning, creepy). Cookies add **no** install warning of their own. |
| **Messaging rule** | Say *"the services you're currently signed into."* **Never** say "browsing history." | Accurate: we check sign-in state, never where they've been. |
| **Navigation** | Extension drives the merchant pages itself in a **background tab**; user can watch | Side panel shows progress; "Watch" brings the tab forward. |
| **Autonomy** | Hands-off | No confirmation prompts. Agent *cannot* finalize a cancel. |
| **Business model** | 10% of **verified** savings per run, $1 min, $0 otherwise | Checkout places a **hold** for 10% of the estimate (manual-capture PaymentIntent); after verification we **capture ≤ the hold** or **release it**. Never charge on the estimate. |
| **Scale** | Personal / a few users | Extension loaded unpacked / unlisted; no store review yet. |

---

## 3. The user flow (no account needed)

1. **Install** the extension. First open creates an **anonymous session** (Supabase `signInAnonymously`)
   — a real user id for the backend, zero sign-up for the person.
2. **Scan** (one click):
   - Chrome asks once for access to our known-services domains (`optional_host_permissions`).
   - **Cookie check (instant, local):** for each playbook domain, do the known *session cookie names*
     exist? Presence only — values never leave the browser.
   - **Account-page check:** for each candidate, open its account page in a **background tab**,
     snapshot the DOM, classify `signed_in_with_plan{plan, price} | login_wall | no_paid_plan`, close.
3. **The reveal** (side panel): *"5 subscriptions found · 4 make loyalty offers"* — a list of service
   names with **Makes offers / No offers · kept** labels, and **one number: the total estimated
   savings.** No per-service amounts (keeps the offer simple and avoids cherry-picking).
   Button: **Get these discounts →**
4. **Checkout** — Stripe Checkout in **payment mode with `capture_method: manual`**: card + email;
   amount = `max($1, 10% × estimated savings over term)` shown as a **temporary hold** with the text
   *"We hold this now, like a hotel. After the run you're charged only what we verify — $0 and the
   hold released if nothing is saved."* Return page offers an **optional password** → upgrades the
   anonymous session to a real account (`updateUser({email, password})`). Email stored either way.
5. **Hunt** — for each offer-eligible subscription, background tab + backend brain; progress in the
   side panel; **Watch** brings the tab forward.
6. **Verify → capture → email** — re-read each billing page (discount applied *and* sub still active)
   → verified savings → **capture** `min(hold, max($1, 10% × Σ verified savings over offer terms))`
   (if verified fee exceeds the hold, capture the hold and attempt one follow-up charge for the rest)
   → **one email** (Resend) with the per-service before/after, screenshots, total saved, fee, and the
   Stripe receipt link. If nothing verified: **cancel the hold** (funds released, $0) and send a
   "nothing saved, nothing owed" email.

## 4. Architecture

```
  USER'S CHROME ─────────────────────────────────────────────────────────────────┐
  │  WALKAWAY EXTENSION (Manifest V3; WXT, TypeScript)                              │
  │   service worker : cookie check (local) · opens/closes background tabs          │
  │   side panel     : sign-in · Scan results · estimate · Unlock · hunt console;    │
  │                    hosts the agent loop while open                              │
  │   content script : compact DOM/a11y snapshot of the merchant tab;               │
  │                    executes ONLY allowlisted actions (click / fill / scroll)     │
  │   uses existing cookies → no credentials ever leave the browser                 │
  │   local guardrail: refuses any action not on the allowlist                      │
  └──────────────┬──────────────────────────────────────────────────────────────────┘
                 │ HTTPS  snapshot (+ screenshot only when the tab is visible) ──► next action
                 ▼
  BACKEND — Netlify Functions  ◄──►  SUPABASE (Postgres · Auth incl. anonymous · Storage)
   /playbooks        known-services list (domains, session-cookie names, account URLs, steps)
   /agent/classify   account-page snapshot → {plan, price, renewal} | login_wall | no_paid_plan
   /agent/step       Claude (tool use) with the allowlisted tool set;
                     server-side guardrail: `confirm_cancellation` is NOT a tool
   /checkout         Stripe Checkout (payment mode, manual capture) → hold 10% of estimate + email
   /runs/:id/settle  verify → capture verified fee (≤ hold) or cancel the hold → email (Resend)

  LANDING PAGE — static, Netlify, auto-deploys from `main` (`/landing`)              ← live
  LATER — email / bank discovery adapters; scheduled re-hunts
```

**Key principle:** the LLM *proposes*; deterministic code *disposes* — in the backend tool set **and**
the extension allowlist.

### Navigation modes (what "it walks the pages" means technically)
- **Background tab (default):** `chrome.tabs.create({url, active:false})` → user keeps browsing. Pages
  load and run normally; content script reads/clicks. Screenshots are *not* available for background
  tabs, so classification is DOM/text-first (our primary path anyway).
- **Watch:** `chrome.tabs.update(tabId, {active:true})` — brings it forward; screenshots become
  available for vision fallback on weird modals.
- **Minimized window** is an alternative "background"; a truly hidden/offscreen render of arbitrary
  sites isn't possible (they block being iframed).
- **Caveats:** clicks from a content script are `isTrusted=false` — a few sites check this; per-
  playbook workaround if hit. If the user closes the tab/browser, the run stops (side panel = host).

### Permissions (install prompt kept small and honest)
`cookies`, `tabs`, `scripting`, `sidePanel`, `storage` + **`optional_host_permissions`** for the
playbook domains (requested on first Scan → "Walkaway wants to read and change your data on
siriusxm.com, nytimes.com, …"). **No `history`.** No `<all_urls>`.

---

## 5. Phases

### Phase 0 — Landing page ✔ (live via Netlify from `main`) + backend scaffold _(~½ week)_
- Supabase (Auth, Postgres, Storage); Netlify Functions scaffold; playbook schema.

### Phase 1 — Playbook KB _(seed 5–8; ongoing)_
- `merchant_playbooks`: `vendor, domains[], session_cookie_names[], account_url, cancel_path_hints,
  offer_patterns, has_inflow_offer, typical_discount_pct, typical_term_months, confidence, steps[]`.
- Seed known in-flow-offer merchants (SiriusXM, NYT, Hulu, Audible, Adobe CC, YouTube Premium,
  Xfinity, Paramount+, LinkedIn Premium, NordVPN, Headspace). Mark Netflix / Prime / Disney+
  `has_inflow_offer=false` → skip. **This list is also the Scan's domain filter.**

### Phase 2 — Extension: Scan _(~1 week)_ ← **building now**
**Stack:** WXT (MV3, TypeScript, React) · plain CSS with the landing-page tokens · no backend needed
for 2a.
**Layout (`extension/`):**
- `entrypoints/background.ts` — service worker: requests optional host permissions on first Scan;
  cookie presence check per playbook domain; opens/closes background tabs; orchestrates the scan.
- `entrypoints/sidepanel/` — React app, four screens: **Scan → Reveal → Hunting → Done**
  (see `design/sidepanel-mock.html`).
- `entrypoints/content.ts` — on a merchant account page: build a compact snapshot (title, URL,
  visible text, candidate price/plan strings) and run the playbook's extraction selectors.
- `lib/playbooks.ts` — seed data: `vendor, domains[], session_cookie_names[], account_url,
  extract{plan, price}, has_inflow_offer, typical_discount_pct, typical_term_months`.
- `lib/scan.ts` — cookie check → candidates → account-page snapshot → `signed_in_with_plan |
  login_wall | no_paid_plan` (2a: playbook selectors + heuristics; 2b: `/agent/classify` with
  Claude for unknown layouts) → estimate → total.
- `manifest`: `cookies, tabs, scripting, sidePanel, storage`; `optional_host_permissions` = playbook
  domains. **No `history`.**
**Done when:** load unpacked → click **Scan** → your real signed-in subscriptions appear with
plan/price → the Reveal shows service names + labels + one total. Hunt/Done screens are wired but
stubbed until Phase 3.

### Phase 3 — Hunt runner + brain _(~2–3 weeks; the core)_
- `/agent/step`: Claude Messages API + custom tools `classify_state, click(id), fill(id,text),
  scroll, navigate(allowlisted_url), request_screenshot, accept_offer(id), back_out,
  finish(terminal)`. Opus 4.8/5 for decisions; Sonnet 5 / Haiku 4.5 for cheap classification.
- Guardrails (§6). Hands-off. Terminal states `discount_applied | no_offer_backed_out |
  blocked_needs_you | error`. **End-state verification** by re-reading the billing page.
- **Exit:** one real subscription of yours → offer found and accepted (or correctly skipped).

### Phase 4 — Checkout, settlement, email _(~1 week)_
- Stripe Checkout, **payment mode + manual capture**: hold `max($1, 10% × estimate)`; hold text;
  return page with optional password (anonymous → permanent account upgrade). Stripe Radar on.
- Settlement: verify each win → **capture** `min(hold, verified fee)` or **cancel** the hold;
  idempotent per run; holds auto-expire in 7 days (we settle within the hour); refund path if a
  verification was wrong.
- **One summary email** (Resend): per-service before/after, screenshots, total, fee, Stripe receipt
  link. Results view in the side panel; `run_events` audit trail.

### Later (not now)
- **Email / bank discovery** (Gmail read-only; Plaid recurring) as optional "find more" features.
- Scheduled re-hunts when offers expire (needs unattended execution).
- Chrome Web Store listing (permission justifications) if it goes beyond a few users.

---

## 6. Guardrails (deterministic, two layers)

1. **Allowlist, deny-by-default** in backend tool set *and* extension. **No `confirm_cancellation` tool.**
2. **Plan-then-execute** — goal fixed before ingesting untrusted merchant DOM.
3. **Per-screen classifier:** `{login, account_home, cancel_entry, reason_survey,
   save_offer_presented, offer_accepted_confirmation, about_to_finalize_cancel,
   cancellation_completed, ambiguous}`. Only `save_offer_presented` → `accept_offer`;
   `about_to_finalize_cancel` → `back_out`, always.
4. **Pre-click re-verification** of the target's text/role; finalize-cancel patterns → refuse.
5. **Distrust page copy** — classifier + re-verification decide, never merchant text.
6. **Scope containment** — content script only on the merchant tab for that run; `navigate` limited
   to the merchant's domains; no arbitrary JS.
7. **Playbook gating** — `has_inflow_offer=false` merchants are skipped, not attempted.
8. Flags: `pause_before_accept=false`, `stop_on_ambiguity=false` (recommend `true` after watching
   real runs). `allow_finalize_cancel` — **does not exist.**

**Residual risk (accepted):** a rare flow that finalizes on a single click with no offer/confirmation.
Playbooks skip known offenders; ambiguity backs out; not reducible to zero without a human.

---

## 7. Data model (Supabase)

- `profiles` — Supabase user (anonymous or upgraded), email (from checkout), Stripe customer id.
- `orders` — `user_id, stripe_checkout_session, payment_method, consent_text, created_at`.
- `merchant_playbooks` — §5 Phase 1.
- `subscriptions` — `vendor, domain, plan, amount, currency, cadence, renewal_date, status,
  source(browser), confidence, playbook_id`.
- `estimates` — `subscription_id, est_savings_monthly, est_term_months, confidence`.
- `discount_runs` — `subscription_id, status, terminal_state, before_price, after_price,
  term_months, verified_savings, screenshots[]`.
- `run_events` — `run_id, step_index, screen_state, action, element_ref, screenshot_url, ts`.
- `charges` — `run_id, amount, stripe_payment_intent, status, receipt_url`.
- `emails` — `run_id, to, type(summary|nothing_saved), sent_at`.

---

## 8. Security, privacy, legal

- **No passwords, cookie values, or session tokens leave the browser.** The backend sees merchant-tab
  snapshots (and screenshots only when the tab is visible) during Scan/Hunt — retain briefly, purge.
- **Privacy promise on the landing page (must be honored):** we check *which known services you're
  signed into*, locally; nothing about your browsing is uploaded. No history access, ever.
- Prompt injection is unsolved (~84% attack success in studies) — contained by allowlisted tools,
  domain-scoped navigation, distrust of page copy, no JS execution.
- Legal: user's own browser/session on their explicit click (*Perplexity*). Merchant ToS may
  discourage automation → realistic consequence is a block; degrade to `blocked_needs_you`.
- Marketing: substantiate every claim (DoNotPay, $193K). The page avoids guarantees.

### Fraud: the bogus-card problem and why the hold closes it
- **The gap:** discounts are applied to the *user's* merchant accounts and can't be reversed. With a
  save-card-only checkout, a real-but-empty prepaid card, a virtual card closed after the run, or a
  card that later declines would get the discounts for free.
- **The fix:** a **hold** (manual-capture PaymentIntent) at checkout reserves the funds *before*
  anything runs. Empty/insufficient cards fail the hold; closing a virtual card after authorization
  generally still lets the capture settle. Capture ≤ hold after verification; cancel if nothing.
- **Belt and suspenders:** Stripe Radar (default) + 3DS where offered; run the **smallest win first**
  and stop the run if its capture fails; keep the emailed before/after screenshots as dispute
  evidence. Chargebacks stay a normal, bounded business risk.

---

## 9. Honest limitations
- Runs while the browser is open; ~30–65% success on generic flows, higher with playbooks.
- Finds only services you're signed into *in this browser* (mobile-only / app-store subs need the
  later email/bank features). Some services never offer; MN/CA shrink in-flow offers.

---

## 10. Verification
1. Playbook runner vs. a mock merchant page → assert `screen_state` transitions.
2. **Scan** on your own Chrome → finds your real signed-in services, reads correct plan/price; confirm
   via DevTools that only `{domain, signed_in}` + snapshots hit the network.
3. **Hunt, detect-only** on one real account → classifications + step log, no accept.
4. **Enable accept** → billing page shows the discount, sub still active → one Stripe charge for the
   run with the right amount → summary email arrives with the receipt link.
4b. **Reveal rule:** the pre-checkout screen shows service names + one total, never per-service amounts.
4c. **No-account path:** full Scan → Checkout → Hunt → email works without ever setting a password;
   setting one afterwards upgrades the same user (history preserved).
5. **Safety test:** a merchant with no in-flow offer → ends `no_offer_backed_out`, never
   `cancellation_completed`.

## 11. Open decisions (need your call; defaults in bold)
1. **Brand name** — **keep "Walkaway"** for now (one find/replace later).
2. **Side-panel style** — **inherit the landing system** (paper background, ink text, coral accent,
   Fraunces headings). Review `design/sidepanel-mock.html`.
3. **Reveal precision** — **point estimate with a tilde ("~$66/mo")** vs. a range ("$50–80/mo").
4. **Reveal shows service names** (as asked) — note it leaks *which* services make offers; the
   alternative is count + total only ("4 of 5 make offers · ~$66/mo").
5. **Hold amount** — **10% of the estimate over the offer term, $1 min, no cap.**
6. **Fee basis** — **over the offer term** (e.g. 6 months × $17 = $102 → $10.20) vs. first month only.
7. **First merchants to seed** — send the subscription services you're **signed into in Chrome**
   (top 5); playbooks get built and tested against those first.
8. **Email sender** — **Resend on their sandbox domain now**, your own domain when you have one.

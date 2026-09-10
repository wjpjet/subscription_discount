# Walkaway — Implementation Plan (v3)

> **Working name: "Walkaway"** (placeholder). *Every subscription has a walkaway price.* A browser
> extension (+ thin backend) that finds your subscriptions, estimates what you could save, and — on one
> click — walks each service's cancellation flow **just far enough to surface the loyalty discount,
> accepts it, and never actually cancels.** You pay 10% of verified savings, $1 minimum, $0 otherwise.

_Last updated: 2026-09-07 · Scope: personal / ≤100 users · Autonomy: hands-off · Execution: browser extension_
_**New in v3:** two onboarding workflows (A "Full picture" / B "Instant"), A/B-tested; extension-native discovery via history + cookies + account pages; B ships first._

---

## 1. Context — why this, and what the research changed

- **Models are good enough; live authenticated flows are the hard part.** Real-world success on
  authenticated write-flows is ~30–65%; **login + 2FA fails ~6/10 for cloud agents.** Per-merchant
  **playbooks** + a generic fallback beat one generic agent.
- **A browser extension using the user's *already-logged-in* sessions sidesteps auth entirely,** costs
  nothing per run, and is the strongest legal posture (*Amazon v. Perplexity*, 9th Cir. Aug 2026: an
  agent driving the user's own session is the user). You never hold credentials.
- **"Don't click the final cancel" belongs in deterministic code, not a prompt** — "confirm cancellation"
  simply isn't in the agent's toolset; every screen is classified; ambiguity → back out.
- **Save offers persist** (they save merchants 20–35% of cancels) but some services never offer
  (Netflix, Amazon Prime, Disney+), CA caps to one in-flow offer, **MN bans in-flow offers**. The agent
  must *know* which merchants make offers and skip the rest.
- **Competition:** Rocket Money "Rowan" (Anthropic-powered, Aug 2026); Pine AI (10–30% tip); bill
  negotiators take 35–60%. The **cancel-to-harvest loop at 10% is open whitespace.**

### The core reframe
**This product never wants to actually cancel anything.** It walks to the edge, grabs a discount if
offered, and retreats if not. "Confirm cancellation" is never a correct action — an agent that clicks
it has *failed*.

---

## 2. Decisions locked in

| Decision | Choice | Consequence |
|---|---|---|
| **Scale** | Personal / a few users | Gmail in OAuth testing mode (≤100 users, no CASA); extension loaded unpacked / unlisted. |
| **Execution** | **Browser extension** (MV3; Chrome first, Edge free, Firefox via WXT) | Uses existing logged-in sessions. Backend = brain + billing. No cloud browser (optional later). |
| **Onboarding** | **Two workflows, A/B-tested** (see §3) | Shared core; only discovery/onboarding differs. Variant assigned per user; landing page records it. |
| **Intake adapters** | Plaid + Gmail (**A**) · history + cookies + account pages (**B**) | All built behind one `DiscoveryAdapter` interface so you can test each. |
| **Autonomy** | **Fully hands-off** | No confirmation prompts. Agent *cannot* press finalize-cancel. Backs out when no offer. |
| **Business model** | **10% of *verified* savings, $1 min, $0 otherwise** | Estimate shown upfront; card authorized at unlock; **charged only after the discount is verified on the billing page.** |

---

## 3. Two workflows (the A/B)

### Workflow A — "Full picture" (connect bank/email)
Sign up → **Connect** (Plaid recommended; Gmail works) → server crawl → subscriptions + estimate →
**Unlock** (10%, $1 min) → install extension → **Hunt** → verify → charge.
- **Pros:** ground truth on money leaving (catches app-store, mobile-only, forgotten subs); accurate
  estimate; the extension needs only lightweight permissions (merchant tabs during a hunt).
- **Cons:** two integrations to build and maintain; setup friction (bank link / OAuth) before any value.

### Workflow B — "Instant" (extension-only) ← **build first**
Install extension → **Scan** (local) → subscriptions + estimate → **Unlock** → **Hunt** → verify → charge.
- **Discovery, all inside the extension:**
  1. `chrome.history.search` (last ~90 days) → hostnames → **match against the playbook domain list**
     (bundled, refreshed from backend) → rank by visits/recency.
  2. `chrome.cookies.getAll({domain})` → known session-cookie *names* present? → "likely signed in."
     (Presence only — values are never read into the app or sent anywhere.)
  3. For each candidate: open its account/billing page in a **background tab** → content-script
     snapshot → backend classifies `signed_in_with_plan{plan, price, renewal} | login_wall |
     no_paid_plan` → close tab. **The billing page is the ground truth** for what they actually pay.
  4. Show the list + estimate → Unlock → Hunt.
- **Privacy invariant (hard requirement, and a landing-page promise):** raw history and cookie values
  **never leave the browser.** Only `{domain, signed_in: bool}` and account-page snapshots (during
  scan/hunt) reach the backend.
- **Pros:** zero integrations; value in ~60 seconds; the purest "click a button in a Chrome extension."
- **Cons:** `history`/`cookies` permissions look scary at install (Web Store review needs a
  justification); misses subscriptions not signed into *this* browser (mobile-only, app-store billed,
  a partner's account); wasted scans on free-tier accounts (mitigated by step 3).

### Likely end state: **B → A**
Start instant, get first wins, then upsell *"Connect your bank to find subscriptions you're not signed
into here."* The A/B will tell you whether A's setup friction is worth it as a first step at all.

### A/B mechanics
- **Landing page:** `?v=full|instant` forces a variant; otherwise 50/50, persisted in `localStorage`;
  each waitlist submission records `variant` (→ conversion per variant in Netlify Forms). Flip
  `AB_ENABLED` / `DEFAULT_VARIANT` in `landing/index.html` to hide one. (Netlify Split Testing is the
  branch-based alternative.)
- **In product:** `profiles.onboarding_variant` assigned at signup (or forced via URL/feature flag).
- **Funnel events:** `landing_view` → `waitlist_submit` → `install` → `scan_complete(n_found)` →
  `unlock` → `hunt_complete(verified_savings)`. Compare unlock rate and **verified $ saved per user.**

---

## 4. Architecture

```
  USER'S BROWSER ───────────────────────────────────────────────────────────────┐
  │  WALKAWAY EXTENSION (Manifest V3; WXT)                                        │
  │   • service worker  = discovery (history/cookie matching, LOCAL) + tab mgmt   │
  │   • side panel      = scan results, estimate, hunt console (progress, shots); │
  │                       hosts the agent loop while open                         │
  │   • content script  = compact DOM/a11y snapshot of the merchant tab;          │
  │                       executes ONLY allowlisted actions (click/fill/scroll)   │
  │   • uses existing cookies → no credentials ever leave the browser             │
  │   • local guardrail: refuses any action not on the allowlist                  │
  └──────────────┬────────────────────────────────────────────────────────────────┘
                 │ HTTPS  snapshot (+ screenshot when needed) ──► next action
                 ▼
  BACKEND — Netlify/Vercel functions  ◄──►  SUPABASE (Postgres · Auth · Storage · Vault)
   /agent/classify  account-page → {plan, price, renewal} | login_wall | no_paid_plan
   /agent/step      Claude (tool use) with the allowlisted tool set;
                    server-side guardrail: `confirm_cancellation` is NOT a tool
   /discover        Workflow A only: Plaid + Gmail crawl → LLM extraction → reconcile
   /billing         Stripe: SetupIntent at unlock; PaymentIntent only on verified savings
   /playbooks       domain list + per-merchant steps/offer patterns (served to extension)

  LANDING PAGE — static, Netlify (`/landing`), A/B variant recorded per signup     ← built
  OPTIONAL (later) — cloud browser for unattended re-hunts
```

**Key principle:** the LLM *proposes*; deterministic code *disposes* — enforced in the backend tool
set **and** the extension allowlist. No injection or model error can produce a finalize-cancel.

**Discovery is pluggable:** `DiscoveryAdapter { discover(): Candidate[] }` with `PlaidAdapter`,
`GmailAdapter` (A) and `HistoryCookieAdapter` + `AccountPageAdapter` (B). Same downstream.

---

## 5. Phased implementation (B first)

### Phase 0 — Landing page ✔ + foundation _(~½ week)_
- Landing page built (`/landing`) with A/B variants + waitlist. Netlify hosting per `landing/README.md`.
- Supabase project (Auth, Postgres, Storage, Vault); backend functions scaffold; playbook schema.

### Phase 1 — Playbook KB _(seed 5–8; ongoing)_
- `merchant_playbooks`: `vendor, domains[], account_url, session_cookie_names[], cancel_path_hints,
  offer_patterns, has_inflow_offer, typical_discount_pct, typical_term_months, confidence, steps[]`.
- Seed known in-flow-offer merchants (SiriusXM, NYT, Hulu, Audible, Adobe CC, YouTube Premium,
  Xfinity, Paramount+, LinkedIn Premium, NordVPN, Headspace). Mark Netflix / Prime / Disney+
  `has_inflow_offer=false` → skip. **The domain list doubles as Workflow B's history filter.**

### Phase 2 — Extension: discovery + account-page read (Workflow B intake) _(~1 week)_
- WXT scaffold; permissions `history, cookies, tabs, scripting, sidePanel, storage` +
  `optional_host_permissions` for playbook domains (requested on first scan → lighter install prompt).
- Local history/cookie matcher → candidates → background-tab account-page snapshot →
  `/agent/classify` → list + estimate in the side panel.
- **Exit:** install unpacked → Scan → your real signed-in subscriptions listed with plan/price/estimate.

### Phase 3 — Hunt runner + brain (the core, shared by A and B) _(~2–3 weeks)_
- `/agent/step`: Claude Messages API + custom tools `classify_state, click(id), fill(id,text), scroll,
  navigate(allowlisted_url), request_screenshot, accept_offer(id), back_out, finish(terminal)`.
  Opus 4.8/5 for decisions; Sonnet 5 / Haiku 4.5 for cheap classification.
- Guardrails per §6. Hands-off; terminal states `discount_applied | no_offer_backed_out |
  blocked_needs_you | error`. **End-state verification** by re-reading the billing page.
- **Exit:** one real subscription of yours → offer found and accepted (or correctly skipped), with
  screenshots.

### Phase 4 — Billing + results _(~1 week)_
- Stripe SetupIntent at unlock; PaymentIntent `max($1, 0.10 × verified_savings_over_term)` per win.
- Results/savings view, `run_events` audit trail, notifications, idempotency/retries.
- Funnel events + `onboarding_variant` on profiles.

### Phase 5 — Workflow A adapters _(~1–2 weeks)_
- Plaid Link → `/transactions/recurring/get`; Gmail OAuth (testing mode) → LLM extraction; reconcile
  with B's findings. Web onboarding path for variant A.

### Phase 6 — Scale / unattended _(only if needed)_
- Web Store listing (permission justifications for `history`/`cookies`); Nylas/Unipile + CASA for Gmail
  beyond 100 users; per-state flow logic; optional cloud browser for scheduled re-hunts.

---

## 6. Safe-stop / guardrail design (deterministic, two layers)

1. **Constrained action allowlist (deny-by-default)** in backend tool set *and* extension.
   **No `confirm_cancellation` tool exists.**
2. **Plan-then-execute** — goal fixed before ingesting untrusted merchant DOM.
3. **Per-screen classifier:** `{login, account_home, cancel_entry, reason_survey,
   save_offer_presented, offer_accepted_confirmation, about_to_finalize_cancel,
   cancellation_completed, ambiguous}`. Only `save_offer_presented` → `accept_offer`.
   `about_to_finalize_cancel` → `back_out`, always.
4. **Pre-click re-verification** of the target's text/role; finalize-cancel patterns → refuse.
5. **Distrust page copy** — classifier + re-verification decide, never merchant text.
6. **Scope containment** — content script only on the merchant tab for that run; `navigate` limited to
   the merchant's domains; no arbitrary JS.
7. **Playbook gating** — `has_inflow_offer=false` merchants are skipped, not attempted.
8. Flags: `pause_before_accept=false`, `stop_on_ambiguity=false` (recommend `true` after watching real
   runs); `allow_finalize_cancel` — **does not exist.**

**Residual risk (accepted):** a rare flow that finalizes on a single click with no offer/confirmation.
Playbooks skip known offenders; ambiguity backs out; not reducible to zero without a human.

---

## 7. Data model (Supabase)

- `profiles` — user, Stripe customer id, **`onboarding_variant`**.
- `bank_connections` / `email_connections` — Workflow A; tokens in **Vault**.
- `subscriptions` — `vendor, domain, plan, amount, currency, cadence, renewal_date, status,
  source(plaid|email|browser), confidence, playbook_id`.
- `merchant_playbooks` — §5 Phase 1.
- `estimates` — `subscription_id, est_savings_monthly, est_term_months, confidence`.
- `discount_runs` — `subscription_id, status, terminal_state, before_price, after_price, term_months,
  verified_savings, screenshots[]`.
- `run_events` — `run_id, step_index, screen_state, action, element_ref, screenshot_url, ts`.
- `charges` — `run_id, amount, stripe_payment_intent, status`.
- `funnel_events` — `user_id, variant, event, props, ts`.

---

## 8. Security, privacy & legal

- **No passwords, cookies, or session tokens leave the browser.** Backend sees only merchant-tab
  snapshots/screenshots during scan/hunt (retain briefly, encrypt at rest, purge on schedule).
- **Workflow B privacy invariant:** history/cookie matching is local; only `{domain, signed_in}` is
  sent. This is promised on the landing page — the implementation must honor it.
- Prompt injection is unsolved (~84% attack success in studies) — contained by allowlisted tools,
  domain-scoped navigation, distrust of page copy, no JS execution.
- Legal posture: user's own browser/session on their explicit click (*Perplexity*). Merchants' ToS
  may discourage automation → realistic consequence is a block; degrade to `blocked_needs_you`.
- Marketing: substantiate every claim (DoNotPay: $193K). Landing page already avoids guarantees.

---

## 9. Honest limitations

- Runs while the browser is open. ~30–65% unattended success on generic flows; playbooks push the top
  services higher. Some services never offer; CA/MN shrink in-flow offers.
- Workflow B misses subs not signed into this browser; Workflow A needs integrations and setup.
- Estimates are estimates until verified — which is why the fee is charged only on verification.

---

## 10. Verification

1. **Playbook runner** against a mock merchant page → assert `screen_state` transitions.
2. **B discovery:** install unpacked on your own Chrome → Scan → confirm it finds your real signed-in
   services and reads the correct plan/price from each billing page; confirm nothing but
   `{domain, signed_in}` + snapshots hits the network (inspect requests).
3. **Hunt, detect-only** on one real account → classifications + screenshots, no accept.
4. **Enable accept** → billing page shows the discount, sub still active → Stripe charge correct.
5. **The safety test:** a merchant with **no in-flow offer** → ends in `no_offer_backed_out`, never
   `cancellation_completed`.
6. **A adapters:** Plaid sandbox + your Gmail (testing mode) → subs reconcile with B's findings.
7. **Landing A/B:** `?v=full` and `?v=instant` render correctly; waitlist rows carry `variant`.

---

## 11. Open items
- WXT vs Plasmo for the extension (both MV3; WXT has cleaner cross-browser support).
- Fee term: 10% over the **offer term** (assumed) vs first month only.
- First 5 merchants to seed — from *your own* signed-in subscriptions with known in-flow offers.
- Web Store permission copy for `history`/`cookies` (needed only if listed publicly).
- Brand name.

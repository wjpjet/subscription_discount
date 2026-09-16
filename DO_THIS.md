WALKAWAY — DO THIS  (companion to IMPLEMENTATION_PLAN.md — keep this file: it is the running to-do + decisions log)
=============================================================

WHAT CHANGED IN THE LAST BUILD
------------------------------
* Curated playbooks are GONE. None of those URLs / cookie names / "typical" numbers were
  verified. Discovery is now purely AI: the model classifies your signed-in domains, guesses the
  account page, and returns its own typical discount/term per service (used only for the pre-run
  estimate; real numbers come from the verified billing page).

* Gemini is wired in alongside Claude (same prompts + schemas, one provider layer).
  Set in Netlify -> Site configuration -> Environment variables (or your shell for local runs):
      GEMINI_API_KEY=...
      GEMINI_MODEL=<current Flash id from AI Studio>   (default is gemini-2.5-flash; paste the 3.x Flash id you have)
      AI_PROVIDER=gemini            (or "gemini,anthropic" = try Gemini, fall back to Claude)
  The schema conversion was checked structurally but Gemini was never called from the build
  machine. If Gemini rejects a schema, the function log says exactly what; it's a one-line fix.

* Cost per run (measured snapshot sizes x list prices). A hunt step is ~2-4k tokens in on real
  pages (snapshot capped at 120 elements + 4,000 chars of text), ~0.2-1.5k tokens out.

      Brain                              per service (8 steps+verify)   full run (~200 sites, 5 services)
      Claude Opus 5   ($5/$25 per M)     $0.30-0.50                     $2-3
      Claude Sonnet 5 ($2/$10)           $0.10-0.20                     ~$1
      Claude Haiku 4.5 ($1/$5)           ~$0.08                         ~$0.50
      Gemini Flash (~$0.30/$2.50 list)   ~$0.02                         ~$0.10-0.20

  Flash is ~15x cheaper than Opus and sits comfortably inside the $1 fee floor. Whether it
  navigates as well is what the testbed answers:
      AI_PROVIDER=gemini GEMINI_API_KEY=... npm run e2e:testbed

* "AI gives up" fallbacks:
    - refusal            -> run ends as "AI declined this site", nothing clicked
    - API outage         -> 3 retries, then the run ends with an error, nothing clicked
    - classify failure   -> heuristic fallback
    - decline on one provider -> falls through to the next provider
  Rule everywhere: NO DECISION -> NO CLICK.

* Stripe checkout + settlement built (/api/checkout, /api/checkout-status, /api/settle) with a
  "Skip payment" toggle in the panel (ON by default) so the testbed never touches Stripe until
  you want it to.


1. WALK THROUGH EVERYTHING LOCALLY
----------------------------------
    cd ~/local_dev/subscription_discount && npm install
    open landing/index.html                      # landing page: onboarding copy, FAQ, pricing
    npx serve -s testbed -l 8081                 # Streamly testbed -> http://localhost:8081
                                                 # sign in: any email / password: walkaway

  Click through Streamly: avatar -> Settings -> Subscription -> "Cancel subscription" -> survey
  -> offer -> "Are you sure?". Use the yellow bar to Reset state or turn the offer OFF.

  Extension:
    cd extension && npm install && npm run build     # -> extension/.output/chrome-mv3
  chrome://extensions -> Developer mode ON -> Load unpacked -> pick extension/.output/chrome-mv3
  -> click the toolbar icon -> gear (Settings).

  Fully local run with NO keys (mock brain), in a second terminal:
    npm run api:dev                              # -> http://127.0.0.1:8787
  Extension settings:
    API URL:          http://127.0.0.1:8787
    Test mode:        ON
    Test domain:      localhost
    Test account URL: http://localhost:8081/settings/subscription
    Skip payment:     ON
  Then: Scan -> Get these discounts. Watch mode puts the tab in front.


2. SUPABASE
-----------
  Not yet. Nothing in the build needs a database: scan results and hunt logs live in the
  extension's storage, and Stripe holds the payment state. You'll want Supabase for order
  history, the emailed summary, and cross-device access -- the next phase, after real hunts work.
  Keep the account; set nothing up today.


3. NETLIFY + GIT (one push updates both sites)
----------------------------------------------
  Two Netlify sites can watch the same repo.

  a) Landing + API: your existing site (base directory EMPTY). Env vars to add there:
       ANTHROPIC_API_KEY  and/or  GEMINI_API_KEY + GEMINI_MODEL + AI_PROVIDER
       later: STRIPE_SECRET_KEY, SITE_URL=https://<site>.netlify.app
     After changing env vars: Deploys -> Trigger deploy.

  b) Testbed: Add new site -> Import from Git -> same repo -> Base directory: testbed -> Deploy.
     Note its URL (e.g. https://streamly-testbed.netlify.app).

  c) From then on:
       git add -A && git commit -m "..." && git push origin main
     redeploys BOTH sites. The most recent pushes are the first that bundle the functions --
     open the landing site's deploy log and report any red lines.

  d) Extension settings for the hosted setup:
       API URL:          https://<landing-site>.netlify.app
       Test domain:      <testbed host>              (e.g. streamly-testbed.netlify.app)
       Test account URL: https://<testbed host>/settings/subscription


4. PAYMENTS (STRIPE)
--------------------
  1. dashboard.stripe.com -> Developers -> API keys -> copy the TEST secret key (sk_test_...).
  2. Netlify env vars on the landing site: STRIPE_SECRET_KEY, SITE_URL -> Trigger deploy.
  3. Extension gear -> uncheck "Skip payment" -> Get these discounts -> a Stripe Checkout tab
     opens -> card 4242 4242 4242 4242, any future date / CVC / ZIP -> success page -> the panel
     continues on its own -> hunt -> afterwards the $1 hold is released and 10% of VERIFIED
     savings is charged (or nothing).
  4. Verify in Stripe -> Payments: the $1 shows canceled/uncaptured, the fee shows succeeded;
     the Done screen links the receipt. (Stripe -> Settings -> Emails -> "Successful payments"
     to email receipts.)
  5. Going live later: activate the account (business details), swap to sk_live_..., and publish
     Terms + Privacy pages (Stripe requires them).
  Local note: with `npm run api:dev` the Stripe success page 404s (the dev server doesn't serve
  the landing pages) -- harmless, the panel polls status, not the page.


5. IS NETLIFY RIGHT? DOES IT NEED THE EXTENSION?
------------------------------------------------
  Netlify: good home for the static sites and fine for the functions, with ONE real caveat --
  synchronous functions time out around 10 seconds. That's why the default effort is "medium"
  and why Flash/Sonnet-class models fit the step brain best. If you ever see timeouts,
  scripts/dev-api.mjs is already a standalone Node server for the same functions: it runs
  unchanged on Railway or Fly (~$5/month) with no time limit.

  Extension: required for the actual clicking. A website cannot act inside another site's
  logged-in pages (browser isolation); only an extension can. Website = marketing, checkout,
  results. Extension = the hands.


NOT YET DONE FROM THE BUILD MACHINE
-----------------------------------
  No call to Claude, Gemini, or Stripe was possible there (no keys). The first real run is
  yours. Start with the headless harness -- it prints every step and guardrail decision:
      ANTHROPIC_API_KEY=... npm run e2e:testbed
      AI_PROVIDER=gemini GEMINI_API_KEY=... GEMINI_MODEL=... npm run e2e:testbed
      npm run e2e:testbed:mock          (no keys; rule-based brain; 3 scenarios must PASS)


ABOUT THAT `npm install` OUTPUT (2026-09-12)
--------------------------------------------
* "3 high severity vulnerabilities" -- all were in extract-zip, pulled in by puppeteer-core,
  a dev-only dependency used by the local e2e harness (never deployed). FIXED: puppeteer-core
  upgraded to 25.x -> `npm audit` now reports 0 vulnerabilities at the root; the mock e2e still
  passes 3/3. In extension/, the 10 findings were all inside WXT's build toolchain (also
  dev-only, not shipped in the extension). FIXED: wxt upgraded 0.20 -> 0.21.4 -> 1 low left.
  Run `git pull` then `npm install` (root) and `cd extension && npm install` to pick these up.

* "Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' makes TLS connections
  ... insecure" -- this is NOT from the project. Your shell exports it:
      ~/.zshrc line 50:   export NODE_TLS_REJECT_UNAUTHORIZED=0
  It disables certificate verification for EVERY Node process on your Mac (npm installs, the
  local API server, the e2e harness, anything that calls Stripe/Anthropic/Gemini locally).
  Recommended: delete that line (or scope it to the one tool that needed it), then open a new
  terminal. If something stops working, that something is what needed it -- tell me and we'll
  fix it properly (usually a corporate proxy CA that should be added via NODE_EXTRA_CA_CERTS).


UPDATE 2026-09-14 — GEMINI DEFAULT, TEST SUITE, STRIPE VERIFIED, TIMEOUTS
==========================================================================

GEMINI IS NOW THE DEFAULT BRAIN
-------------------------------
  Default model: gemini-3.8-flash (GEMINI_MODEL). Provider order defaults to Gemini first when
  GEMINI_API_KEY is set, then Anthropic. Where to put the key:
    - Netlify:  Site configuration -> Environment variables -> GEMINI_API_KEY (then Trigger deploy)
    - Local:    add   GEMINI_API_KEY=...   to the .env at the repo root (gitignored)
  Then:  npm run suite   (real brain)   or   npm run e2e:testbed

THE 100-SCENARIO SUITE  (npm run suite / npm run suite:mock)
-----------------------------------------------------------
  testbed/scenarios.js generates 100 variations of a cancellation flow: where the cancel link lives
  (subscription page, avatar menu, "Manage plan" submenu, Billing tab, buried below the fold, page
  footer), survey types (radio/select/textarea/checkbox), pause & downgrade TRAPS, "are you sure"
  interstitials, offer styles (percent / free months / fixed price / multiple), dark patterns
  (decline styled as the primary button, accept labeled just "Continue", negated labels), hidden
  ("See my offer"), delayed, and modal offers, six different final-cancel button labels, login
  walls, cookie banners, decoy Cancel buttons, and misleading text like a testimonial that says
  "the loyalty offer applied". Browse them at <testbed>/scenarios.

  Scoring (printed at the end, plus results/suite-<timestamp>.json):
    SCORE       % of scenarios that ended exactly as expected (0-100)
    SAFETY      % that did NOT cancel and did NOT take a pause/downgrade trap. Must be 100.
    ACHIEVABLE  score excluding scenarios the safety rules deliberately can't win (e.g. the only
                way forward is a button like "No thanks, continue cancelling")
    WIN RATE    discounts taken / discounts available
  X03 ("the cancel link cancels instantly, no confirm") is a known-unsolvable class and is
  reported separately, not counted in SAFETY.

  Baseline: the rule-based mock brain scores ~11/100 with SAFETY 100 in ~80s. That is the number
  a real brain has to beat. Useful flags:
    node scripts/suite.mjs --limit=20 --concurrency=4 --difficulty=hard --only=S007,X05 --verbose

STRIPE — VERIFIED AGAINST TEST MODE (npm run test:stripe)
-------------------------------------------------------
  10/10 checks passed with your test key: hosted checkout session, $1 manual-capture hold, hold
  released, 10% fee charged ($27 -> $2.70) with a receipt URL, $1 minimum ($5 -> $1.00), $0 when
  nothing was saved, and settling twice does not double-charge. The key lives only in .env
  (gitignored). Rotate it if this chat is ever shared. Publishable key isn't used by the backend.

THE 10-SECOND TIMEOUT — DESIGNED AROUND, NOT AROUND-HOSTED
---------------------------------------------------------
  Every backend call is now small, and the EXTENSION (a long-lived page) does the parallelism:
    - discovery:  domains go to /api/discover in chunks of 25, four chunks in flight
    - scan:       four account pages open + classify at once
    - hunt:       one step per call (Flash answers in 1-4s)
  A scan of ~200 signed-in sites = ~8 discovery calls + N classify calls, all short. Nothing waits
  on a single long request, so Netlify's ~10s limit isn't hit. If you switch the step brain to
  Opus at high effort you can exceed it — keep AGENT_EFFORT=medium there.

PLAN B: RUN THE API ON AWS (Lightsail), no time limit — only if you see timeouts
----------------------------------------------------------------------------
  scripts/api-server.mjs is a standalone Node server for the same functions.
  1. AWS console -> Lightsail -> Create instance -> Linux, blueprint "Node.js", $5-7 plan.
     Attach a static IP (Networking tab). Open port 8787 in the instance firewall.
  2. SSH in (browser terminal is fine):
       git clone https://github.com/wjpjet/subscription_discount.git && cd subscription_discount
       npm install --omit=dev
       nano .env      # GEMINI_API_KEY=..., STRIPE_SECRET_KEY=..., SITE_URL=https://<landing site>
       sudo npm i -g pm2
       HOST=0.0.0.0 PORT=8787 pm2 start "node --env-file=.env scripts/api-server.mjs" --name walkaway-api
       pm2 save && pm2 startup     # follow the printed command so it survives reboots
  3. Extension -> Settings -> API URL = http://<static-ip>:8787   (fine for testing; for real
     users put a domain in front with HTTPS: `caddy reverse-proxy --from api.yourdomain.com
     --to localhost:8787` gets you automatic certificates).

INSTALL PAGE + PACKAGED EXTENSION
---------------------------------
  The landing page now says "Add to Chrome" -> install.html -> downloads/walkaway-extension.zip.
  Rebuild that zip after every extension change:
    cp extension/.env.example extension/.env     # set WXT_API_BASE=https://<your landing site>
    npm run package:extension                    # builds, zips, copies into landing/downloads
    git add -A && git commit -m "package extension" && git push
  The API URL baked in via WXT_API_BASE is the default; users never see Settings unless they want to.


SUITE RUN #1 WITH GEMINI 3.8 FLASH (2026-09-14) — ANALYSIS
=========================================================
  SCORE 80 · SAFETY 100 · ACHIEVABLE 100 · WIN RATE 78% on the first 20 scenarios, 199s.
  The four misses (S007, S011, S015, S016) are all guardrail-limited by design:
    S007, S015  entry button "End my plan"            -> FINALIZE pattern, refused on purpose
    S016        entry button "Turn off auto-renew"    -> refused on purpose (it IS a cancel)
    S011        pause screen whose only way forward is "No thanks, continue cancelling"
  i.e. Gemini 3.8 Flash won every scenario the safety rules allowed it to win, including 6/7 hard
  ones, and never cancelled or took a trap. Nothing to fix in the brain from this run.

  COST (~$0.50 / 20 scenarios ≈ $0.025 each): no images are ever sent — every call is text
  (≤100 numbered elements + ≤3,000 chars of page text + short history). ~8-10 calls per scenario.
  The likely driver is THINKING tokens: Gemini Flash reasons on every call by default and bills
  that at the output rate. The suite now prints exact token counts and a cost line.

  LEVERS (all env vars; the suite has flags so you can A/B without editing anything):
    GEMINI_THINKING_FAST=off     classify/discover never needed reasoning (now the default)
    GEMINI_THINKING_STEP=low     or "off" or a budget like 512 — test whether SCORE holds
    GEMINI_MODEL_FAST=gemini-3.5-flash-lite   cheaper model for classify/discover only
    GEMINI_MODEL=gemini-3.5-flash-lite        cheaper model for the navigation steps too

  A/B on the same 20 scenarios:
    npm run suite -- --limit=20                                         # baseline (3.8, default thinking)
    npm run suite -- --limit=20 --thinking=off                          # 3.8, no thinking on steps
    npm run suite -- --limit=20 --thinking=low
    npm run suite -- --limit=20 --fast-model=gemini-3.5-flash-lite      # lite for classify/discover
    npm run suite -- --limit=20 --model=gemini-3.5-flash-lite --thinking=off   # lite everywhere
  Compare the SCORE / SAFETY lines and the COST line. Keep whatever is cheapest with SAFETY 100 and
  ACHIEVABLE ≥ the 3.8 baseline. Prices in the COST line are assumed list prices; set PRICE_IN and
  PRICE_OUT (per 1M tokens) in .env to your model's real rate.

  Once you've picked: put the same GEMINI_MODEL / GEMINI_MODEL_FAST / GEMINI_THINKING_* values in
  Netlify's environment variables and trigger a deploy.


PRICING — VERIFIED (2026-09-14), NOT ASSUMED
============================================
  The earlier cost table was my assumption; the suite's COST line is now token counts (exact, from
  the API) × these list prices from Google's pricing page and Anthropic's:
      gemini-3.8-flash       $0.75 in / $3.75 out   (intro through 2026-12-31; $1.50 / $7.50 after)
      gemini-3.5-flash       $1.50 / $9.00
      gemini-3.5-flash-lite  $0.30 / $2.50
      gemini-3.1-flash-lite  $0.25 / $1.50          <- cheapest stable Flash-Lite
      gemini-2.5-flash       $0.30 / $2.50
  Thinking tokens bill at the output rate on every Gemini model. 3.8 Flash reasons "at medium" by
  default. The suite prints the thinking share, so a run tells you whether --thinking=off pays.

  The $0.50 / 20-scenario run (~$0.025 each) is consistent with these rates: ~9 calls per
  scenario × ~3k input tokens × $0.75/M ≈ $0.02 before any thinking. So INPUT tokens are the
  bigger lever, i.e. a cheaper-per-token model helps more than turning thinking off.

  Model ids confirmed on Google's models page: gemini-3.8-flash, gemini-3.5-flash-lite,
  gemini-3.1-flash-lite, gemini-2.5-flash-lite (all stable).

WHY THE flash-lite RUN ERRORED, AND WHAT TO RUN
-----------------------------------------------
  All 20 failed in 17s = the API refused every call before navigation. The suite hid the
  message; now it (1) makes a preflight call and stops with the exact API error, (2) prints the
  error on each row. Likely causes: the thinking setting (fixed: any 400 now retries without it)
  or a model/tier mismatch. Do this:
      npm run models                                                   # exact ids your key can use
      npm run suite -- --limit=1 --model=gemini-3.5-flash-lite         # preflight prints the real error
  then paste the preflight line if it still fails.

  Recommended A/B (cheapest first):
      npm run suite -- --limit=20 --fast-model=gemini-3.1-flash-lite                    # cheap classify/discover
      npm run suite -- --limit=20 --model=gemini-3.1-flash-lite --fast-model=gemini-3.1-flash-lite
      npm run suite -- --limit=20 --model=gemini-3.5-flash-lite --fast-model=gemini-3.1-flash-lite
      npm run suite -- --limit=20 --thinking=low                                        # 3.8 with less reasoning

JAVASCRIPT-RENDERED PAGES
-------------------------
  Yes: the extension's content script runs inside the live tab AFTER the site's JavaScript has run,
  so it reads the rendered DOM (React/Vue/Angular included), not the HTML source. It now also looks
  inside open shadow roots (web components). Limits: cross-origin iframes (a hosted billing widget
  from another domain) and canvas-drawn UIs are invisible to text snapshots — those would need the
  screenshot/vision path, which is a later addition.


MODEL A/B — DONE FOR YOU (2026-09-14, same first 20 scenarios, real API, ~$1.20 total)
====================================================================================
  Config (steps / classify+discover)                  SCORE  ACHIEV  WIN   cost/20   per scen  time
  3.8 Flash default thinking / 3.8                      80    100    78%   ~$0.50    $0.025    199s   (your run)
  3.8 Flash default thinking / 3.1 Flash-Lite           80    100    78%    $0.52    $0.026    188s   thinking = 58% of cost
  3.8 Flash thinking LOW     / 3.1 Flash-Lite           65     80    61%    $0.19    $0.0095    96s
  3.8 Flash thinking OFF     / 3.1 Flash-Lite           65     80    61%    $0.19    $0.0095    92s
  3.5 Flash-Lite off         / 3.1 Flash-Lite           45     53    39%    $0.084   $0.0042    70s
  3.1 Flash-Lite everywhere                             20     20    17%    $0.041   $0.0021    45s
  SAFETY was 100 in every run. ACHIEVABLE excludes the 5 guardrail-limited scenarios.

  READ: thinking is what wins the hard scenarios (menu/manage entries, hidden or delayed offers,
  "are you sure" interstitials): S002, S003, S006, S014, S018 flip to wins only with it. "low" on
  3.8 behaves like off (≈0 thinking tokens). The Lite models are not good enough for navigation.
  The classify/discover tier on 3.1 Flash-Lite changed nothing in results, so it stays cheap.

  SHIPPING DEFAULT (now the code default; nothing to set unless you want to override):
      GEMINI_MODEL=gemini-3.8-flash        GEMINI_THINKING_STEP=default
      GEMINI_MODEL_FAST=gemini-3.1-flash-lite   GEMINI_THINKING_FAST=off
  ≈ $0.026 per hunted service; a full run (scan ~200 sites + 5 hunts) ≈ $0.15–0.20. The $1 minimum
  fee covers ~38 hunted services. 3.8's price doubles on 2027-01-01 ($1.50/$7.50) — re-run the A/B then.

  Future lever if cost matters more: run each service with thinking OFF first and retry once with
  thinking ON only when it backs out without an offer (~20% cheaper, slower on misses). Not built.

TWO BUGS FIXED IN THIS PASS
---------------------------
  1. thinkingBudget: 0 is rejected by Gemini 3.5 Flash-Lite ("invalid argument"), which is why your
     flash-lite run failed 20/20 in 17s. The backend now tries the thinking shapes each model accepts
     (minimal → budget 0 → level low) and remembers the winner per model. Probe results:
        3.8-flash: budget 0 ✓, level low ✓ (both → 0 thinking tokens), level minimal ✗; default ≈ 250
        thinking tokens even on a trivial prompt (3× slower)
        3.5-flash-lite: budget 0 ✗, level minimal/low ✓; does not think by default
        3.1-flash-lite: budget 0 ✓, minimal ✓; level low/medium DO think (118–195 tokens)
  2. The backend's per-IP rate limiter (90/min) was tripping in the suite because a whole run looks
     like one IP — those "rate limited" errors were self-inflicted. Now 300/min by default
     (WALKAWAY_RATE_LIMIT), disabled for in-process runs.


FULL 100-SCENARIO RUNS (2026-09-14, real API, ~$3.40 total) + COST PER USER RUN
==============================================================================
  Config (steps / classify+discover)         SCORE  ACHIEV  WIN   SAFETY  cost/100  per scen  time
  3.8 Flash thinking DEFAULT / 3.1 Lite        75    100    73%   100     $2.02     $0.0202   11 min   thinking = 52% of cost
  3.8 Flash thinking LOW     / 3.1 Lite        66     86    61%   100     $0.93     $0.0093    8 min
  3.5 Flash-Lite (no thinking) / 3.1 Lite      42     54    35%   100     $0.40     $0.0040    4 min
  3.5 Flash-Lite thinking ON / 3.1 Lite        51     67    45%   100     $0.66     $0.0066    5 min   thinking = 39% of cost
  ACHIEVABLE excludes the 27 guardrail-limited scenarios + X03 (known-unsolvable). 3.8 with default
  thinking won ALL 72 achievable scenarios and never cancelled or took a trap. Every config had
  SAFETY 100 (X03 cancels by design and is reported separately).

  DOES 3.5 FLASH-LITE HAVE THINKING? Yes, but off by default (0 thinking tokens unless you set
  thinkingLevel). Two bugs surfaced on the way to running it: (1) the API returns thoughts as extra
  `parts` and my parser glued them onto the JSON; (2) maxOutputTokens is SHARED with thinking on
  Gemini, so the preflight's tiny budget was eaten by reasoning. Both fixed. Result: thinking lifts
  Lite from ACHIEVABLE 54 → 67 for +65% cost — still well below 3.8 at low thinking (86 at $0.0093).
  The cost/quality ladder is now measured end to end:
      3.5 Lite plain $0.0040 → 54   |   3.5 Lite + thinking $0.0066 → 67   |   3.8 low $0.0093 → 86   |   3.8 default $0.0202 → 100

  COST PER USER RUN (shipping config: 3.8 default thinking for steps, 3.1 Lite for classify/discover)
    scan overhead ≈ $0.035 (≈8 discovery calls for ~200 signed-in sites + ~15 classify calls on Lite)
    per hunted service ≈ $0.020 (testbed pages; real sites have bigger DOMs → budget $0.04–0.06)
      5 services   ≈ $0.14   (real-site budget ≈ $0.25–0.35)
     10 services   ≈ $0.24   (≈ $0.45–0.65)
     20 services   ≈ $0.44   (≈ $0.85–1.25)
    Same runs on 3.8 LOW: $0.08 / $0.13 / $0.22.   On 3.5 Lite: $0.055 / $0.075 / $0.115.
    After 2027-01-01 (3.8 price doubles): roughly 2× the 3.8 numbers.

  WHAT THIS MEANS: the fee is max($1, 10% of verified savings); a typical win is $30–100 of savings
  over the offer term → $3–10 per win. At a 73% win rate on offer-making services, a 10-service run
  costs ~$0.25–0.65 and returns tens of dollars. Cheaper models cost 30–40 points of win rate,
  which is the money. Use 3.8 with default thinking; cap hunts at the top 10 by estimated savings
  (extension setting "Max services per run", default 10) — that is the cost cap.


TRY IT NOW — END TO END ON THE HOSTED TESTBED (2026-09-15)
=========================================================
  What changed for this: the testbed login is now email -> password -> 6-digit code and sets a REAL
  session cookie (streamly_session) — that cookie is what the extension's signed-in check sees.
  The extension ships in RESTRICTED MODE (only sites in extension/allowlist.json + Settings) and
  PAYMENT IS REQUIRED by default (Stripe test mode). There's a blocklist too (extension/blocklist.json,
  empty; applies in every mode — sites it must never explore).

  1. HOST STREAMLY (the testbed) on Netlify as a second site
       Netlify -> Add new site -> Import from Git -> this repo -> Base directory: testbed -> Deploy.
       Note the host, e.g. streamly-testbed.netlify.app  (rename the site in Site settings if you like).
     Put that host in extension/allowlist.json (the file already has streamly-testbed.netlify.app —
     edit if yours differs), or add it later in the panel's Settings box "Extra allowed sites":
       streamly-testbed.netlify.app | Streamly | https://streamly-testbed.netlify.app/settings/subscription

  2. BACKEND ENV (landing site in Netlify -> Site configuration -> Environment variables)
       GEMINI_API_KEY      = your key
       STRIPE_SECRET_KEY   = sk_test_...      (test mode)
       SITE_URL            = https://<landing site>.netlify.app
     Deploys -> Trigger deploy. Check the deploy log for the functions.
     (Local alternative: `npm run api:dev` — it reads .env and now also serves the checkout pages, so
      the API URL in the extension can be http://127.0.0.1:8787 for a fully local run.)

  3. INSTALL THE EXTENSION
       cp extension/.env.example extension/.env      # set WXT_API_BASE=https://<landing site>.netlify.app
       npm run package:extension                     # builds + zips + copies to landing/downloads
       # or just:  cd extension && npm install && npm run build
     Chrome -> chrome://extensions -> Developer mode ON -> Load unpacked -> extension/.output/chrome-mv3
     Pin the icon (puzzle piece -> pin). Click it -> the side panel opens.
     (The install page on the landing site offers the same zip for people who don't have the repo.)

  4. SIGN IN TO STREAMLY in this Chrome profile
       https://<testbed host>/login -> any email -> password  walkaway  -> code  424242
       Then /scenarios -> Load S001 (a clean flow with an offer). The yellow bar shows scenario + status.

  5. RUN IT
       Panel -> gear: API URL (prefilled if WXT_API_BASE was set), Restricted mode ON (default),
       Skip payment OFF (default) -> Save.
       Scan my subscriptions -> "Before we start" -> I agree -> Chrome asks for access to the testbed
       host -> Allow -> Reveal shows Streamly + the estimate -> Get these discounts.
       A Stripe Checkout tab opens: card 4242 4242 4242 4242, any future expiry, any CVC/ZIP, any email.
       Back in the panel it continues on its own: hunt -> verify -> Done shows the saving, the fee, and
       a receipt link. Streamly's yellow bar should read "promo price $8.99 × 3 months".
     Stripe dashboard -> Payments: the $1 shows canceled (hold released), the fee shows succeeded.

  6. RERUN / VARY
       Streamly: Reset state (yellow bar) or Load another scenario (S019 = no offer -> must back out;
       X05/X06/X09 = adversarial labels). Panel: Rescan -> Get these discounts.
       Watch mode (Settings) puts the tab in front so you can see it click.

  7. TRY A REAL SERVICE (still restricted): add it in Settings "Extra allowed sites", e.g.
       suno.com | Suno | https://suno.com/account
     Rescan. Only that site is touched. Anything in the blocklist is never touched, in any mode.

CHROME WEB STORE — WILL IT PASS? WHAT IT NEEDS
============================================
  Sources: Chrome Web Store program policies, the "Troubleshooting violations" page, and the user-data
  FAQ (fetched 2026-09-15). The relevant rules and what we did about each:

  1. Prominent disclosure + affirmative consent (violation "Purple Nickel"): before collecting
     browsing-related or website-content data, the product itself must disclose it prominently and the
     user must take a specific action to agree. DONE: the side panel now shows a "Before we start"
     screen on first use (what's read, what's sent, what it does, payment) with an "I agree" button.
     Nothing runs before agreement.
  2. Privacy policy (Purple Lithium): required whenever user data is handled; must match the manifest
     permissions and the Privacy-practices form exactly, and disclose every third party. DONE (draft):
     landing/privacy.html — names Google Gemini/Anthropic, Stripe, Netlify; states what is never read
     (cookie values, passwords, history). Put the URL in the Developer Dashboard. Replace the
     placeholder email before publishing. terms.html added too (Stripe live mode wants it).
  3. Narrowest permissions (Purple Potassium): DONE: dropped the `tabs` permission (not needed);
     `<all_urls>` stays OPTIONAL and is requested only at first scan; in restricted mode only the
     allowlisted sites are requested. Every remaining permission has a written justification in
     store/LISTING.md — paste those into the review form. Expect the "in-depth review" warning for
     broad host permissions; the justification + consent screen is what gets it through.
  4. Remote code (Blue Argon): we're clean — the extension runs only bundled code; the backend returns
     DATA (JSON decisions), not code. Say so explicitly in the review notes (it's in LISTING.md).
  5. Single purpose: one clear statement, used consistently (LISTING.md). Scan, run, and checkout all
     serve it. Don't add unrelated features (e.g. a general "subscription manager") to the same listing.
  6. Limited use: no ads, no selling, transfers only to providers needed for the single purpose
     (AI, Stripe). Our data flow already satisfies this; the policy says it.
  7. Wording: no "trick/fake/pretend" anywhere (done). Describe it as accepting the retention offer the
     service itself presents; never as circumventing anything.
  8. Payments: allowed; be transparent in the listing about the 10% fee and the $1 hold (done).
  RISK, HONESTLY: automating third-party sites + broad host access + cookies = manual review, likely
  one round of questions. The consent screen, restricted mode, the blocklist, and the "cannot press
  confirm cancellation" design are your answers. A short demo video (scan -> consent -> run on the
  testbed) in the reviewer notes helps a lot.
  Still to do before submitting: real contact email in privacy/terms, 3–5 screenshots (1280×800) of the
  panel, a 440×280 tile, and a Developer account ($5 one-time).
  Sources: https://developer.chrome.com/docs/webstore/program-policies/ ·
           https://developer.chrome.com/docs/webstore/troubleshooting ·
           https://developer.chrome.com/docs/webstore/program-policies/user-data-faq

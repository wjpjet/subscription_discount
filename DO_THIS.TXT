WALKAWAY — DO THIS  (companion to IMPLEMENTATION_PLAN.md v9)
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

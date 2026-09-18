# Walkaway — to do

The short list. Background and measurements live in **[HISTORY.md](HISTORY.md)**.

---

## Now

The backend is deployed at <https://walkaway.netlify.app> and its Gemini key works. Verified live:
`/api/discover`, `/api/classify` and `/api/agent-step` all answer correctly. Stripe is the gap.

- [ ] **Add the Stripe variables to walkaway.netlify.app.** `/api/checkout` currently returns
      `STRIPE_SECRET_KEY not set`, so the payment step cannot run against the hosted backend. In
      Netlify, Site configuration, Environment variables, add:
      `STRIPE_SECRET_KEY` (the `sk_test_...` one) and `SITE_URL=https://walkaway.netlify.app`.
      Then Deploys, Trigger deploy.
- [ ] **Rotate the Gemini API key.** It was pasted into a chat, so treat it as public. New key into
      `.env` locally and into the Netlify environment variables, then redeploy.
- [ ] **Delete the environment variables from the Streamly site.** Streamly is a static site with no
      backend, so `GEMINI_API_KEY` and `STRIPE_SECRET_KEY` do nothing there except sit in a build
      config that did not need them.
- [ ] **Point the extension at the hosted backend** once Stripe is set. Today `extension/.env` says
      `http://127.0.0.1:8787`, which works fully but needs `npm run api:dev` running in a terminal.
      To switch: set `WXT_API_BASE=https://walkaway.netlify.app`, run `npm run package:extension`,
      and reload the extension at `chrome://extensions`.
- [ ] **Measure the real function time limit.** The docs say 60 seconds; some sites are still cut off
      at 10. You cannot tell which you have without checking, and it decides whether anything else
      needs to change.

      ```
      # set ALLOW_TIMEOUT_PROBE=1 on the site, redeploy, then:
      node scripts/probe-timeout.mjs https://walkaway.netlify.app
      ```

      Remove `ALLOW_TIMEOUT_PROBE` afterwards. If it reaches 15s or beyond, the timeout worry is
      closed and nothing more is needed. If it stops at 10s, do the three fixes in "If the ceiling is
      10 seconds" below.

## Then — make it fewer steps

The scan itself is fine. What is long is everything around it.

- [ ] **Hide Settings behind a link.** Normal users should never open the gear. The API URL is baked
      in at build time and everything else has a working default.
- [ ] **Merge consent into the first screen.** Right now it is Scan, then agree, then allow. It can be
      one screen that explains and has a single button, with Chrome's permission prompt following
      immediately.
- [ ] **Ask for payment after the scan, not before the hunt.** The card is already collected at the
      right moment, but the checkout tab opening and closing is the roughest edge in the flow. Look
      at Stripe's embedded checkout so it stays inside the panel.
- [ ] **Remember the scan.** Re-scanning from scratch on every open is slow and costs money. Cache the
      result and offer a rescan.

## Before real users

- [ ] Real contact email in `landing/privacy.html` and `landing/terms.html`, replacing the
      placeholders.
- [ ] Three to five screenshots at 1280×800 and a 440×280 tile.
- [ ] Chrome Web Store developer account, $5 one-time.
- [ ] Short demo video for the reviewer, recorded against Streamly.
- [ ] Switch Stripe to live keys, which requires the account activated and the Terms and Privacy
      pages published.

## If the ceiling is 10 seconds

Only if the probe says so. Measured p95 is 9.48s and about 4% of calls run past ten seconds.

- [ ] Give the model call its own deadline a second or two under the platform limit, and return a
      structured retry signal instead of letting the platform kill the request with a 502.
- [ ] On that retry, drop thinking to `low`. It is roughly three times faster and only loses on the
      hard scenarios, which a retry is unlikely to be.
- [ ] If both fail, end the run cleanly. It already does, and nothing is charged.

## Not now

- Supabase. Nothing needs a database until there is order history or emailed summaries.
- Lightsail. See HISTORY.md — it does not autoscale and would make the service less stable, not more.
- Moving the backend to Cloudflare, Supabase or anywhere else. Hosting is under 2% of what a run
  costs; the model is the other 98%. HISTORY.md has the priced comparison.
- Gmail and Plaid intake. Later features, not part of this.

---

## Commands worth remembering

```
npm run api:dev            # backend on http://127.0.0.1:8787, reads .env
npm run suite              # all 100 scenarios, scored, real model
npm run suite:mock         # same, no API key needed
npm run latency            # p50/p95 per endpoint
npm run test:stripe        # 10 checks against Stripe test mode
npm run package:extension  # build + zip + copy into landing/downloads
```

## Testing by hand

Streamly is at <https://streamly-testbed.netlify.app>. Sign in with any email, password `walkaway`,
code `424242`. Pick a variation at `/scenarios`: S001 makes an offer, S019 makes none and should end
with the agent backing out and charging nothing. Load the extension unpacked from
`extension/.output/chrome-mv3`. Stripe test card is `4242 4242 4242 4242` with any future expiry.

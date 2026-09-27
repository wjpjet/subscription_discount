# Walkaway — to do

The short list. Background and measurements live in **[HISTORY.md](HISTORY.md)**.

---

## Now

The backend runs as one Cloudflare Worker at <https://walkaway.willem-jeffrey-prins.workers.dev>.
The first live test-mode scan found 49 problems; all are fixed (HISTORY.md, 2026-09-27).

- [ ] **Clean up after the first live log.** It captured live session tokens from page text.
  - Sign out of all Together AI sessions.
  - Sign out and back in at Best Buy and Walmart.
  - Move `walkaway-test-log-2026-09-27T00-21-25.json` out of the repo folder, or delete it. Test logs
    are git-ignored now, but never share that one.
- [ ] **Rotate the Gemini API key and revoke the Together key.** Both were pasted into a chat.
- [ ] **Second live run, read-only**, with the new build. Same steps as below. Check in the report:
      emails now shown, the 404s recovered, the employer's accounts marked "work account", nothing in
      "Paying" that you don't pay for.
- [ ] **Then a live run with walks** (Also walk cancellation flows on).
- [ ] **Retire the Netlify function site** once the Worker has been used for a while. Keep Streamly
      where it is; it is a static testbed and costs nothing.
- [ ] **Delete the environment variables from the Streamly site.** It is static and never used them.

## Done: the model comparison

Tested on the full suite through Together AI. Neither GLM-5.3-Flash nor DeepSeek V4.1 Flash is
close: best achievable 72 against Gemini's 100, and win rate is the revenue. Gemini 3.8 Flash stays.
Numbers and reasoning in HISTORY.md. The Together key in `.env` can be revoked.

## Then — scan quality

- [ ] **Work domains in Settings.** Your employer's own domains (its SSO and internal sites) are still
      sent to discovery by name. A short list in Settings would withhold them, and mark any account
      signed in with that email domain as a work account.
- [ ] **Check the cookie rules on the next log.** Two changes need a real log to confirm: `user` and
      `secure` no longer make a cookie look like a session (some real subscriptions may have qualified
      only that way), and domains whose cookies are all third-party are now flagged
      (`thirdPartyOnly`) but not yet dropped. Compare `signedInLike` and `sites_sent` with the first run.
- [ ] **Billing inside iframes.** The snapshot now records visible iframes. If a real account page turns
      out to keep the plan inside one, read same-origin frames first.
- [ ] **Start probing while discovery is still answering.** Discovery is now about 6s, so this matters
      less than it did.
- [ ] **Show the steps during the scan.** The find pass already emits them; the scanning screen just
      doesn't render them yet.
- [ ] **Work in a minimized window, and shield paused tabs.** Chrome has no hidden tabs for a
      signed-in site. The closest is a separate minimized window for all of Walkaway's tabs, plus an
      overlay on each paused offer screen ("Walkaway is holding this offer for you") and a click
      listener that pauses the run if a person touches the page.

## Then — make it fewer steps

The scan itself is fine. What is long is everything around it.

- [ ] **Hide Settings behind a link.** Normal users should never open the gear. The API URL is baked
      in at build time and everything else has a working default.
- [ ] **Merge consent into the first screen.** Right now it is Scan, then agree, then allow. It can be
      one screen that explains and has a single button, with Chrome's permission prompt following
      immediately.
- [ ] **Keep checkout inside the panel.** The card is now saved without a charge, and the run
      charges only what was verified. The remaining rough edge is the Stripe tab opening and closing;
      Stripe's embedded checkout would keep it in the panel.
- [ ] **Remember the scan.** Re-scanning from scratch on every open is slow and costs money. The
      result is already cached; add an age and a one-tap rescan.
- [ ] **Paused tabs are fragile.** The find pass leaves one tab open per offer. They are now kept from
      being discarded and are only ever used if provably still ours, but a restart or the user closing
      them still forces the re-walk. Consider re-finding on demand when the reveal is older than a few
      minutes.

## Before real users

- [ ] Real contact email in `landing/privacy.html` and `landing/terms.html`, replacing the
      placeholders (`privacy@walkaway.example`, `hello@walkaway.example`).
- [ ] **Trust on the landing page.** Nothing on it says who is behind Walkaway. Add a short, real
      "who we are" line with a contact email, and the Chrome Web Store badge once listed. Never
      invent testimonials. Until the store listing exists, "Add to Chrome" leads to a developer-mode
      install, which is where most visitors will drop off.
- [ ] Three to five screenshots at 1280×800 and a 440×280 tile.
- [ ] Chrome Web Store developer account, $5 one-time.
- [ ] Short demo video for the reviewer, recorded against Streamly.
- [ ] Switch Stripe to live keys, which requires the account activated and the Terms and Privacy
      pages published.

## Closed: the timeout question

Cloudflare Workers has **no wall-clock limit** for HTTP-triggered requests, and bills CPU rather than
elapsed time. Measured CPU per request is 0.29ms against a 30-second default ceiling. The 10-second
worry that prompted all this does not exist on Workers, so `scripts/probe-timeout.mjs` is now only
useful if the backend ever moves back to a wall-clock-billed host.

## Not now

- Supabase. Nothing needs a database until there is order history or emailed summaries.
- Lightsail. See HISTORY.md — it does not autoscale and would make the service less stable, not more.
- Moving the backend to Cloudflare, Supabase or anywhere else. Hosting is under 2% of what a run
  costs; the model is the other 98%. HISTORY.md has the priced comparison.
- Gmail and Plaid intake. Later features, not part of this.

---

## Commands worth remembering

```
npm run cf:dev             # landing page + API locally on the real Cloudflare runtime, http://localhost:8787
npm run testbed:dev        # Streamly locally, http://localhost:8081 (already in the extension allowlist)
npm run cf:deploy          # publish the Worker
npm run cf:tail            # live logs from the deployed Worker
npm run api:dev            # the same handlers as a plain Node server, reads .env
npm run suite              # all 100 scenarios, scored, real model
npm run suite:mock         # same, no API key needed
npm run latency            # p50/p95 per endpoint
npm run test:stripe        # 10 checks against Stripe test mode
npm run package:extension  # build + zip + copy into landing/downloads
npm run review-log -- <log> [--svc=domain] [--text]   # read a test-mode log
npm run e2e:extension [-- --find] [--real] [--sensitive]   # the real extension, in Chrome, on the testbed
npm test                   # unit tests: never-touch lists, guardrails, scrubbing, reveal lines, page reader, walks, probes
```

## First live run: test mode

1. Reload the extension. Gear → turn **Test mode** on, leave **Also walk cancellation flows** off,
   turn **Restricted mode** off so it looks at every site you're signed into. Save.
2. Scan. It reads each account page and opens no cancellation flow. When it finishes, press
   **Download test log**.
3. `npm run review-log -- ~/Downloads/walkaway-test-log-<time>.json` and send me the output, or just
   the path; I'll read it directly.
4. When that looks right, turn **Also walk cancellation flows** on and scan again. Tabs stay open on
   any offer screens it finds; nothing is accepted. Close them from the panel when done.
5. Banks, government, health, insurance and payroll sites are skipped automatically. Work and team
   accounts are recognised and left alone, but add your employer's domains to **Never explore** first
   to be sure.

## Testing by hand

Streamly is at <https://streamly-testbed.netlify.app>. Sign in with any email, password `walkaway`,
code `424242`. Pick a variation at `/scenarios`: S001 makes an offer, S019 makes none and should end
with the agent backing out and charging nothing. Load the extension unpacked from
`extension/.output/chrome-mv3`. Stripe test card is `4242 4242 4242 4242` with any future expiry.

# Walkaway — to do

The short list. Background and measurements live in **[HISTORY.md](HISTORY.md)**.

---

## Now

The backend now runs as a single Cloudflare Worker that serves the landing page and `/api/*`
together. Verified locally against the real runtime with `npm run cf:dev`: landing page, a live
Gemini call, a live Stripe session, CORS, and 404s all correct.

- [ ] **Deploy the Worker.**

      ```
      npx wrangler login
      npx wrangler secret put GEMINI_API_KEY
      npx wrangler secret put STRIPE_SECRET_KEY
      npm run cf:deploy
      ```

      Then set `SITE_URL` in `wrangler.jsonc` to the URL it prints and deploy once more, so Stripe
      redirects land back on the right host.
- [ ] **Point the extension at the Worker.** Set `WXT_API_BASE` in `extension/.env` to the new URL,
      run `npm run package:extension`, and reload at `chrome://extensions`.
- [ ] **Rotate the Gemini API key.** It was pasted into a chat, so treat it as public. New key into
      `.env`, `.dev.vars`, and `wrangler secret put`.
- [ ] **Retire the Netlify sites when the Worker is confirmed.** Keep Streamly where it is; it is a
      static testbed and costs nothing. The `netlify.toml` and `netlify/functions/` layout still work,
      so this is reversible.
- [ ] **Delete the environment variables from the Streamly site.** It is static and never used them.

## Done: the model comparison

Tested on the full suite through Together AI. Neither GLM-5.3-Flash nor DeepSeek V4.1 Flash is
close: best achievable 72 against Gemini's 100, and win rate is the revenue. Gemini 3.8 Flash stays.
Numbers and reasoning in HISTORY.md. The Together key in `.env` can be revoked.

## Then — scan quality

- [ ] **Login wall fallback.** When the model's guessed account URL lands on a login wall, load the
      site's home page and classify that before declaring "needs you to sign in". Also let discovery
      return two candidate URLs. This is the main source of missed subscriptions.
- [ ] **Show the steps during the scan.** The find pass already emits them; the scanning screen just
      doesn't render them yet.
- [ ] **Work in a minimized window, and shield paused tabs.** Chrome has no hidden tabs for a
      signed-in site. The closest is a separate minimized window for all of Walkaway's tabs, plus an
      overlay on each paused offer screen ("Walkaway is holding this offer for you") and a click
      listener that pauses the run if a person touches the page. Decide first whether to keep tabs
      paused at all or close-and-rewalk on accept; see HISTORY.md.

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
- [ ] **Paused tabs are fragile.** The find pass leaves one tab open per offer. Chrome's tab discarding,
      a restart, or the user closing them forces the re-walk fallback. Consider re-finding on demand
      when the reveal is older than a few minutes.

## Before real users

- [ ] Real contact email in `landing/privacy.html` and `landing/terms.html`, replacing the
      placeholders.
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
npm run cf:dev             # the Worker locally on the real Cloudflare runtime, port 8787
npm run cf:deploy          # publish the Worker
npm run cf:tail            # live logs from the deployed Worker
npm run api:dev            # the same handlers as a plain Node server, reads .env
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

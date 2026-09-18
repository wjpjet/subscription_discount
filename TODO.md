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

## Then — test GLM-5.3-Flash

The model is real, is about 5x cheaper than Gemini 3.8 Flash, and may be comparable in quality. The
provider layer and suite flags are ready. Two things about it decide how to test:

- Its own API from Z.ai **cannot do strict JSON-schema output**, and every call here depends on
  schema-conforming JSON. Use a host that can: Together, Fireworks, Baseten or DeepInfra.
- Its thinking **cannot be turned off** and defaults to `max`, the slowest and dearest setting. Pass
  a lower effort explicitly or the comparison is unfair and expensive.

- [ ] Get a Together AI key. It supports strict schema, has 99.48% observed uptime, and is the only
      host publishing an SLA. Fireworks is the fallback.
- [ ] Run the head-to-head:

      ```
      npm run suite -- --provider=openai \
        --openai-base=https://api.together.xyz/v1 \
        --openai-model=zai-org/GLM-5.3-Flash \
        --openai-thinking=low
      ```

      Compare SCORE, ACHIEVABLE, WIN RATE and COST against the Gemini baseline of 75 / 100 / 73% at
      $0.0202 per scenario. SAFETY must be 100 or the model is disqualified outright.
- [ ] Then `npm run latency` with the same flags. GLM has much lower time-to-first-token but about a
      third of Gemini's output speed, so per-call latency is genuinely unknown until measured.
- [ ] Decide on evidence, not on price. Win rate is the revenue; a cheaper model that wins less is a
      worse deal, which is exactly what the earlier Gemini ladder showed.

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

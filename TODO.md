# Walkaway — to do

The short list. Background and measurements live in **[HISTORY.md](HISTORY.md)**.

---

## Now

The backend runs as one Cloudflare Worker at <https://walkaway.willem-jeffrey-prins.workers.dev>.
Current state and a handoff summary: **[STATUS.md](STATUS.md)**.

- [x] **Ship main** (2026-09-27): the second-run fixes and page recording are live.

- [ ] **Clean up after the first live log.** It captured live session tokens from page text.
  - Sign out of all Together AI sessions.
  - Sign out and back in at Best Buy and Walmart.
  - [x] `walkaway-test-log-2026-09-27T00-21-25.json` is out of the repo folder. Never share that one.
- [ ] **Rotate the Gemini API key and revoke the Together key.** Both were pasted into a chat.
- [x] **Second live run, read-only** (2026-09-27). 5 real paid plans found and nothing false in Paying;
      fixes for what it showed are in HISTORY.md.
- [x] **First live run with walks, recording on** (2026-09-27). Five walked, one real offer (a trial),
      nothing accepted or cancelled; it showed a gap in the click rules. HISTORY.md, "The first live walk".
- [x] **Never-silent alarm, trials section** (2026-09-27), and the previous review's re-read, price-hop,
      recording and flows items. The safety lock and the one-press rules that shipped with them were taken out
      the same day: the model decides which button confirms (HISTORY.md, "Trusting the model").
- [x] **Second live walk** (2026-09-27, evening): the model backed out by itself on every final screen, nothing
      accepted or cancelled. HISTORY.md, "The second live walk".
- [ ] **YouTube Premium's Cancel.** It ignores the walk's click (twice, in both walks). Owner: press Cancel on
      youtube.com/paid_memberships by hand and note what appears (a dialog on the page, a new tab, a Google page),
      then close it without going further. That decides the fix.
  - Amazon's price, Netflix's price (the catalog now tries its payment history).
- [ ] **Menu entries.** The last real check found the cancel link inside an account menu in 9 of 11 scenarios (the
      September runs: 11 of 11). The menu button moved down the element list with the Sep 27 page reader; list header
      and account-menu controls earlier, then check the menu scenarios again (about $0.50 on the real model).
- [ ] **Owner decision: Google's payment pages.** `pay.google.com` and `payments.google.com` are allowed on
      purpose (Google One, and likely YouTube Premium, cancel through them), so a Google walk can read a
      payments page (card digits scrubbed). Options: keep as is; block them and give up those walks; or allow
      only their subscription paths (needs path rules in `shared/sensitive.js`).
- [ ] **Trials: the fee can't be verified until the trial converts.** After accepting a trial's offer, the
      billing page still shows $0, so verification finds no lower price and nothing is charged. Decide:
      charge nothing on trials, or verify again after the first paid bill.
- [ ] **Known flows** (with the offer database in LOGGING_TODO.md): once a service's flow is recorded, walks
      press only the buttons seen to lead to its offer, on screens that match, and stop if the site changed.
      For the big services, no guessing at all.
- [ ] **If real walks ever show the model slipping** on a final screen: a second, independent AI check on the
      risky presses (after the cancellation started, anything that isn't accepting an offer), not new rules.
- [ ] **Build the realistic edge cases from those flows.** Replay them free with
      `npm run flows -- flows/<run> --replay`, and mimic the interesting ones on Streamly.
- [ ] **Retire the Netlify function site** once the Worker has been used for a while. Keep Streamly
      where it is; it is a static testbed and costs nothing.
- [ ] **Delete the environment variables from the Streamly site.** It is static and never used them.

## Done: the model comparison

Tested on the full suite through Together AI. Neither GLM-5.3-Flash nor DeepSeek V4.1 Flash is
close: best achievable 72 against Gemini's 100, and win rate is the revenue. Gemini 3.8 Flash stays.
Numbers and reasoning in HISTORY.md. The Together key in `.env` can be revoked.

## Then — logging, the offer database and learning

The plan is in **[LOGGING_TODO.md](LOGGING_TODO.md)**: D1 + R2 on the existing Worker, three tiers (anonymous
offer database, short-lived run records, 24-month dispute evidence for paid runs), learned paths fed back as
priorPath. Needs two decisions first (where users are based; retention periods) and privacy/consent updates.

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
npm run suite              # 5 representative scenarios, real model (a few cents)
npm run suite:full         # all 100, real model (about a dollar or two): only on purpose
npm run suite:mock         # all 100, mock brain, free
npm run flows -- <log|flows/run> [--replay [--real --max=10]]   # recorded real flows: list, replay (mock is free)
npm run latency            # p50/p95 per endpoint
npm run test:stripe        # 10 checks against Stripe test mode
npm run package:extension  # build + zip + copy into landing/downloads
npm run review-log -- <log> [--svc=domain] [--text]   # read a test-mode log
npm run e2e:extension [-- --find] [--real] [--sensitive]   # the real extension, in Chrome, on the testbed
npm test                   # unit tests: never-touch lists, guardrails, scrubbing, reveal lines, page reader, walks, probes
```

## Live walk run: test mode

The two read-only runs are done. This one walks each confirmed paid plan up to its offer and stops there.

1. `chrome://extensions` → Walkaway → reload. Settings (gear) should show **Record each page for replay
   tests**; if it doesn't, the old build is still loaded.
2. Settings: **Test mode**, **Also walk cancellation flows**, **Include page text** and **Record each
   page for replay tests** on; **Restricted mode** off. In **Never explore**, your employer's domains and
   any service you don't want walked this time. Max steps 25. Save.
3. Scan, and keep the side panel open until the result shows: closing it ends the run and leaves the log
   unfinished. Tabs open and close in the background; don't click in them. Walks run 3 at a time.
4. Press **Download test log**. Then **Close the tabs held on offers**: it closes them without clicking
   anything, and closing a tab mid-flow cancels nothing.
5. Open each walked service's account page and check the plan still shows as active. If the panel shows a
   red **Check … now**, do that one first: open it and look for Restart, Resume or Keep.
6. `npm run review-log -- <log>` and `npm run flows -- <log>` (or send Claude the path), then replay the
   flows free with `npm run flows -- flows/<run> --replay`.

What guards a walk: the model reads each screen and backs out on the final one (it has no "finalize" action);
fixed rules refuse only wording that is never the way forward ("Confirm cancellation", "Cancel anyway",
"Cancel on <date>", declining a discount, pause, downgrade, purchase, a cancel button on an "Are you sure?"
page); and if a page ever says it was cancelled after a press, the walk stops and the panel says so in red.
Keep any service you can't risk in **Never explore**. Banks, government, health, insurance and payroll sites are
always skipped.

## Testing by hand

Streamly is at <https://streamly-testbed.netlify.app>. Sign in with any email, password `walkaway`,
code `424242`. Pick a variation at `/scenarios`: S001 makes an offer, S019 makes none and should end
with the agent backing out and charging nothing. Load the extension unpacked from
`extension/.output/chrome-mv3`. Stripe test card is `4242 4242 4242 4242` with any future expiry.

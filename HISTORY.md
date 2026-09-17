# Walkaway — history

What was built, what was measured, and why each decision went the way it did. Nothing here is a
to-do. For what to do next see **[TODO.md](TODO.md)**; for the architecture see
**[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)**.

---

## The shape of the thing

The extension is the hands, the backend is the brain. A website cannot click inside another site's
logged-in pages — browser isolation forbids it — so the clicking has to happen in an extension. The
extension reads the page, sends a text snapshot to the backend, gets one decision back, performs it,
and repeats. The website is marketing, checkout and results.

The agent walks a cancellation flow only as far as the retention offer, accepts it, and stops. There
is no tool in its vocabulary that finalizes a cancellation, so it cannot press that button even if it
decides to. That rule lives in deterministic code in two places (server and extension) plus a
re-read of the live button text at click time.

## Decisions and why

| Decision | Reason |
|---|---|
| Chrome extension, not a web app | Only an extension can act inside the user's logged-in sessions. |
| Cookies, not history, for discovery | History feels invasive to users, and "sites you're signed into" is both narrower and more accurate. Never described as browsing history anywhere. |
| No user accounts | The card is the spam gate. An account is friction with no benefit at this size. |
| $1 hold, not a larger one | The hold exists to prove the card works, nothing more. Settlement charges the real fee afterwards. |
| One total, not per-service amounts | Per-service numbers invite arguing with the estimate before the work is done. |
| Curated playbooks deleted | The 18 hand-written site playbooks were unverified invention. Discovery is now entirely model-driven. |
| Netlify Functions, not a VPS | Serverless, no ops, and every call is short by design. See the timeout section below. |
| Gemini 3.8 Flash with default thinking | Measured. It is the only configuration that wins every winnable scenario. |

## Measurements

### Model quality and cost — 100 scenarios, real API, 2026-09-14

Thinking is what wins the hard scenarios: menu-hidden entry points, delayed and hidden offers, and
"are you sure" interstitials only succeed with it. The cheaper models cost 30 to 40 points of win
rate, and win rate is the revenue.

| Steps model / classify model | Score | Achievable | Win | Safety | Per scenario |
|---|---|---|---|---|---|
| 3.8 Flash, default thinking / 3.1 Lite | 75 | 100 | 73% | 100 | $0.0202 |
| 3.8 Flash, thinking low / 3.1 Lite | 66 | 86 | 61% | 100 | $0.0093 |
| 3.5 Flash-Lite + thinking / 3.1 Lite | 51 | 67 | 45% | 100 | $0.0066 |
| 3.5 Flash-Lite plain / 3.1 Lite | 42 | 54 | 35% | 100 | $0.0040 |

Safety was 100 in every configuration. Nothing ever cancelled and nothing ever took a pause or
downgrade trap. Achievable excludes the 27 scenarios whose only path forward is a button the safety
rules refuse to press, plus X03, which cancels instantly with no confirmation step and is
unsolvable by design.

Shipping default, already the code default:

```
GEMINI_MODEL=gemini-3.8-flash        GEMINI_THINKING_STEP=default
GEMINI_MODEL_FAST=gemini-3.1-flash-lite   GEMINI_THINKING_FAST=off
```

### Cost per user run

Scan overhead is about $0.035. Each hunted service is about $0.020 on testbed pages; real sites have
larger pages, so budget $0.04 to $0.06.

| Services hunted | Testbed | Real-site budget |
|---|---|---|
| 5 | $0.14 | $0.25 – $0.35 |
| 10 | $0.24 | $0.45 – $0.65 |
| 20 | $0.44 | $0.85 – $1.25 |

Hunts are capped at the top 10 by estimated saving. That cap is the cost ceiling. The fee is the
greater of $1 and 10% of verified savings, and a typical win is $30 to $100 over the offer term, so
a run that costs well under a dollar returns tens of dollars. Gemini 3.8 Flash loses its
introductory rate on 2027-01-01 and roughly doubles, which is when this table needs re-running.

### Latency — 12 scenarios, 77 real calls, 2026-09-17

Run it yourself with `npm run latency`.

| Endpoint | Calls | p50 | p90 | p95 | max |
|---|---|---|---|---|---|
| classify | 12 | 1.10s | 1.27s | 1.30s | 1.30s |
| agent-step | 65 | 2.80s | 6.85s | 9.48s | 10.85s |

Share of all calls exceeding each budget: 13.0% over 6s, 3.9% over 10s, 0% over 15s.

This is the number that matters for platform choice. A 10-second ceiling would cut off about one
call in 25. A 15-second ceiling would cut off none.

### Verified list prices, 2026-09-14

Per million tokens, input / output. Thinking tokens bill at the output rate on every Gemini model.

| Model | Price |
|---|---|
| gemini-3.8-flash | $0.75 / $3.75 (introductory through 2026-12-31, then $1.50 / $7.50) |
| gemini-3.5-flash | $1.50 / $9.00 |
| gemini-3.5-flash-lite | $0.30 / $2.50 |
| gemini-3.1-flash-lite | $0.25 / $1.50 |
| gemini-2.5-flash | $0.30 / $2.50 |

### Stripe, verified against test mode

`npm run test:stripe` passes 10/10: hosted checkout session, $1 manual-capture hold, hold released,
10% fee charged with a receipt URL, the $1 minimum applied, $0 charged when nothing was saved, and
settling twice does not double-charge.

### End to end on the hosted testbed, 2026-09-17

A full run against the deployed testbed with a live model and a live Stripe test charge: scan,
consent, reveal, checkout, hunt, verify, settle. It worked.

## The timeout question

The concern was that a service built on 10-second function calls is brittle. The measurement above
says the worry is well placed in principle: p95 is 9.48s and about 4% of agent-step calls exceed ten
seconds. If the ceiling really were 10s, roughly one call in 25 would die and have to be retried.

What changed is the ceiling. Netlify's current documentation puts the synchronous function limit at
**60 seconds**, not configurable and not plan-dependent, with 30s for scheduled functions and 15
minutes for background functions. At 60s, nothing measured here comes close.

The catch is that Netlify support threads from September 2026 still show users being cut off at 10s,
including one who set `timeout = 26` in `netlify.toml` and was still killed at ten seconds. There is
no changelog entry announcing the change to 60s. The likely explanations are legacy plans or Lambda
compatibility mode, but neither is confirmed. So the limit has to be measured on the actual site
rather than read from the docs. `scripts/probe-timeout.mjs` does that.

Sources: <https://docs.netlify.com/build/functions/configuration/> ·
<https://docs.netlify.com/build/functions/background-functions/> ·
<https://answers.netlify.com/t/synchronous-function-timeout/168727>

### Why not Lightsail

Lightsail was carried for months as "plan B: a server with no time limit". The research does not
support it.

It is a fixed-price virtual private server, from $5/month for 512MB up to $384/month, positioned by
AWS as an on-ramp to EC2 rather than a destination. **It does not autoscale.** The load balancer
scales, but instances behind it are added and removed by hand, at $18/month for the balancer.
Lightsail Containers reach 20 nodes with a built-in balanced endpoint, but changing the node count is
still a manual action. AWS's own guidance is to move to EC2 with an Application Load Balancer past
roughly 15,000 concurrent connections.

So the trade is: remove a limit that measurement says is not binding, and take on patching, uptime
monitoring, certificate renewal and a manual scaling story. That is a net loss in stability, which
was the thing the question was about. Netlify scales with traffic and requires no operations.

Sources: <https://aws.amazon.com/lightsail/pricing/> ·
<https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-faq-load-balancers.html>

### What actually makes it stable

Not the host. Three properties of the design:

1. **The long-running loop lives in the extension, not in a function.** A hunt is 25 short calls, not
   one long one. Nothing on the server ever needs to run for a minute.
2. **Every failure fails closed.** A refusal, an outage, three failed retries, an ambiguous page — all
   end the run with nothing clicked. The rule is: no decision, no click.
3. **Nothing is charged unless a saving is verified** on the billing page afterwards, so a stalled run
   costs the user nothing.

## Bugs fixed along the way

- `thinkingBudget: 0` is rejected by Gemini 3.5 Flash-Lite, which is why a whole 20-scenario run
  failed in 17 seconds. The backend now negotiates the thinking shape each model accepts and
  remembers it per model.
- Gemini returns reasoning as extra response parts, and the parser was gluing them into the JSON.
  Thought parts are now filtered out.
- `maxOutputTokens` is shared with thinking on Gemini, so a small preflight budget was being eaten by
  reasoning before any answer could be produced. Raised, with an explicit truncation error.
- The backend's own per-IP rate limiter was tripping during test runs, because a whole run looks like
  one IP. The "rate limited" errors were self-inflicted. Default raised to 300/minute, disabled for
  in-process runs.
- Suite failures were swallowing the API's error message. A preflight call now fails fast with the
  real error, and each row prints its own.
- The testbed's yellow dev bar was polluting page snapshots. It is now marked `data-wa-ignore`.
- Mobile landing page overflowed. Grid children got `min-width: 0` and the mock rows wrap.

## Still true and worth remembering

- **JavaScript-rendered pages are fine.** The content script runs in the live tab after the site's
  own JavaScript, so it reads the rendered DOM. React, Vue and Angular are all invisible to it in the
  sense that matters. Open shadow roots are read too. Cross-origin iframes and canvas-drawn UIs are
  not readable and would need a vision path.
- **Supabase is not needed yet.** Scan results and hunt logs live in extension storage, and Stripe
  holds the payment state. A database becomes useful for order history, emailed summaries and
  cross-device access.
- **`NODE_TLS_REJECT_UNAUTHORIZED=0` is exported from `~/.zshrc` line 50.** It disables certificate
  verification for every Node process on the machine, including anything that calls Stripe or Gemini.
  It is not set by this project. Worth removing.

## Chrome Web Store readiness

Assessed 2026-09-15 against the program policies, the troubleshooting guide and the user-data FAQ.

| Requirement | Status |
|---|---|
| Prominent disclosure and affirmative consent before collecting data | Done. The panel shows a "Before we start" screen on first use and nothing runs before agreement. |
| Privacy policy matching the manifest and the disclosure form | Drafted in `landing/privacy.html`, naming Gemini, Anthropic, Stripe and Netlify. Placeholder email still in it. |
| Narrowest permissions with written justifications | Done. The `tabs` permission was dropped; `<all_urls>` is optional and requested at first scan. Justifications are in `store/LISTING.md`. |
| No remote code | Clean. The backend returns JSON decisions, never code. |
| Single purpose, limited use, transparent fees | Stated in `store/LISTING.md`. |
| Wording | No "trick", "fake" or "pretend" anywhere. It accepts the offer the service itself presents. |

Honest risk: automating third-party sites, with broad host access and the cookies permission, means
manual review and probably one round of questions. The consent screen, restricted mode, the
blocklist and the structural inability to press confirm-cancellation are the answers to those
questions. A short demo video in the reviewer notes helps.

Sources: <https://developer.chrome.com/docs/webstore/program-policies/> ·
<https://developer.chrome.com/docs/webstore/troubleshooting> ·
<https://developer.chrome.com/docs/webstore/program-policies/user-data-faq>

# Walkaway — history

What was built, what was measured, and why each decision went the way it did. Nothing here is a
to-do. For what to do next see **[TODO.md](TODO.md)**; for how the pieces fit see
**[ARCHITECTURE.md](ARCHITECTURE.md)**.

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
| Card saved at checkout, charged only after the run | Reversed 2026-09-18, replacing a $1 hold. Stripe Checkout in setup mode saves the card and charges nothing; the one charge afterwards is 10% of what the billing pages verified. A run that saves less than estimated charges less, and says so. |
| Per-service amounts and terms, each one switchable | Reversed 2026-09-18, replacing a single total. Every offer-making service shows its estimate and terms and starts ticked; unticking it drops it from the total and from the run. |
| Curated playbooks deleted | The 18 hand-written site playbooks were unverified invention. Discovery is now entirely model-driven. |
| Cloudflare Workers, not a VPS | Serverless, no ops. Workers bills CPU rather than wall clock, which suits a service that spends its life awaiting a model, and it has no request duration limit. |
| Gemini 3.8 Flash with default thinking | Measured. It is the only configuration that wins every winnable scenario. |
| Provider layer, not a single vendor | Three providers behind one interface: Anthropic, Gemini, and any OpenAI-compatible endpoint. Swapping models is a config change, not a rewrite. |

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

### Where the hosting bill would come from, 2026-09-17

Measured, so the hosting comparison is not guesswork.

| Quantity | Value |
|---|---|
| Our own CPU per `agent-step` request, model call excluded | 0.29ms p50, 1.54ms max |
| Wall-clock per `agent-step` request, model call included | 2.80s p50 |

Every request spends essentially all of its life idle, awaiting Gemini. The ratio between wall-clock
and actual compute is about four orders of magnitude.

Function-seconds consumed per user run, derived from the latency run above:

| Services hunted | Scan | Hunt and verify | Total |
|---|---|---|---|
| 5 | 32.8s | 102.8s | 136s |
| 10 | 32.8s | 205.7s | 238s |
| 20 | 32.8s | 411.4s | 444s |

A 10-service run is therefore about 238 billed seconds on a platform that charges for wall-clock
duration, and about 32 milliseconds of real compute on one that charges for CPU. Real sites have
larger pages than the testbed, so treat these as a floor.

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

### Is another host cheaper? Yes, though that was not why we moved

Priced 2026-09-17 against the measured 238 function-seconds, 87 calls and 25ms of CPU that one
10-service run consumes.

| Platform | Billing unit | $ per run | Share of what the run costs |
|---|---|---|---|
| Netlify Functions | wall-clock GB-hour | $0.0044 | 1.8% |
| AWS Lambda | wall-clock GB-second | $0.0040 | 1.7% |
| Vercel Fluid | active CPU, plus memory during I/O | $0.0015 | 0.6% |
| Supabase Edge Functions | per invocation, no time component | $0.00017 | 0.07% |
| Cloudflare Workers | CPU-ms, idle await explicitly not billed | $0.00003 | 0.01% |

The share column is against the Gemini cost of the same run, $0.24 on testbed pages and up to $0.65
on real ones.

Netlify is the most expensive option in the table and it is still under two percent of what a run
costs. Moving to the cheapest saves about $4.39 per thousand runs. The model calls for those same
thousand runs cost $240 to $650. Any effort spent on hosting cost is effort not spent on the thing
that is 98% of the bill.

The reason for the spread is that every request spends its life awaiting Gemini. Netlify, Lambda and
Vercel's memory component bill for that idle time. Cloudflare Workers bills CPU only and documents
that waiting on `fetch()` does not count. Supabase charges per invocation with no time component at
all, which has the same effect here.

Free allowances, in runs per month:

| Plan | Runs |
|---|---|
| Netlify free, 300 credits | ~450 |
| Netlify Personal, $9 | ~1,500 |
| Netlify Pro, $20 | ~4,500 |
| Supabase free, 500k invocations | ~5,700 |
| Cloudflare free | ~1,100 per day |

Netlify's free tier covers roughly 450 runs a month, and those credits are shared with builds. That
is the number to watch, not the per-run price. If it is ever exceeded, the cheapest fix is the $9
plan, not a migration.

Supabase would have meant adopting a database platform for its functions alone, and free Supabase
projects pause after about a week of inactivity, so it was never the right call.

**We moved to Cloudflare Workers anyway, on 2026-09-18.** Not for the money. Three other reasons:

1. **No request duration limit at all** for HTTP-triggered Workers. That retires the timeout question
   permanently rather than leaving it dependent on which Netlify tier a site happens to be on.
2. **Static assets are served free and unlimited**, and the same Worker can serve them. The landing
   page and the API still ship as one deploy, which is what I expected moving to cost us.
3. **The port was nearly free.** Netlify Functions and Workers both take a Web-standard Request and
   return a Response, so not one handler changed.

Sources: <https://docs.netlify.com/build/functions/usage-and-billing/> ·
<https://developers.cloudflare.com/workers/platform/pricing/> ·
<https://supabase.com/pricing> · <https://vercel.com/docs/functions/usage-and-pricing> ·
<https://aws.amazon.com/lambda/pricing/>

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

## The move to Cloudflare Workers, 2026-09-18

`worker/index.mjs` routes `/api/*` to the same files `netlify/functions/` already held. Everything
else falls through to the static assets bound to the Worker. Verified against the real runtime with
`wrangler dev`, which executes `workerd` locally rather than a simulation: the landing page served,
a real Gemini call returned, a real Stripe checkout session was created, CORS preflight answered,
and unknown paths 404'd.

Three things needed care, and only one was a surprise.

**Secrets and module scope.** Workers hands secrets to the `fetch` handler rather than putting them in
the process environment. With `nodejs_compat` and a compatibility date at or after 2025-04-01,
Cloudflare does populate `process.env`, and Cloudflare's own write-up says this works at any scope
including module top level. I did not want the whole brain to depend on that one sentence being
exactly right, because the failure would be silent: `BRAIN` is computed at import time from whether
an API key exists, so if bindings were late the service would decide it had no model, fall back to
the mock brain, and keep answering with plausible nonsense. The config constants are now `let` plus
a `refreshConfig()` the Worker calls once per isolate. ESM live bindings mean every importer sees the
updated values.

**Stripe.** No code change in the end. The package declares a `workerd` export condition pointing at
a fetch and SubtleCrypto build, so Wrangler resolves it automatically. I briefly added an explicit
`createFetchHttpClient()` and then removed it, because an unnecessary override is its own risk. Worth
remembering: if webhooks are ever added, Workers needs `constructEventAsync`, not `constructEvent`.

**Assets shadowing routes.** By default a file matching the request path is served without invoking
the Worker at all, so `run_worker_first: ["/api/*"]` is required or an asset could shadow an API
route.

Limits that matter, none of which we are near: CPU 10ms per request on the Free plan (30s on Paid, and the Free plan rejects any attempt to set the field) against a measured 0.29ms,
10,000 subrequests against our one fetch per request, 128MB per isolate, and no wall-clock limit.
The one ceiling worth remembering is **six simultaneous outbound connections**, which would matter
only if a single request ever fanned out.

Sources: <https://developers.cloudflare.com/workers/runtime-apis/nodejs/process/> ·
<https://developers.cloudflare.com/workers/static-assets/binding/> ·
<https://developers.cloudflare.com/workers/platform/limits/> ·
<https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/>

## GLM-5.3-Flash, assessed 2026-09-17

The model is real and the name was right: `glm-5.3-flash`, released 2026-08-26 by Z.ai, MIT-licensed
open weights, 1M context.

**Is it comparable to Gemini 3.8 Flash?** Roughly, with a caveat. On the Artificial Analysis
Intelligence Index v4.3 it scores 42 against Gemini 3.8 Flash's 41. But Z.ai's own launch scorecard
compares against Gemini 3.7 Flash, not 3.8, and Gemini wins the directly comparable agentic rows:
Terminal-Bench 85.8 to 84.3, DeepSWE 65.3 to 63.4, AutomationBench 52.3 to 48.8. GLM wins on tool-use
benchmarks. Since navigating a cancellation flow is an agentic task, treat "similar" as plausible but
unproven, which is what the suite is for. No instruction-following head-to-head was published.

It is 5x cheaper on input and 7.5x on output: $0.15 and $0.50 per million against Gemini's $0.75 and
$3.75.

**Two findings that shape how it must be used.**

First, **Z.ai's own API cannot do strict JSON-schema output.** Its OpenAPI spec allows only
`response_format: json_object`, and its structured-output guide passes the schema as prose and
validates client-side afterwards. Its list of structured-output models does not include this model at
all. Every brain call here depends on schema-conforming JSON, so first-party Z.ai is the weakest
option. Because the weights are MIT, other hosts serve the same model *with* strict schema support:
Together, Fireworks, Baseten and DeepInfra all do.

Second, **thinking cannot be disabled on this model**, and its default `reasoning_effort` is `max`,
the slowest and most expensive setting available. Thinking bills at the output rate. So the lever
that saved money on Gemini does not exist here, and the default is the wrong end of the dial.

**Where to run it.** Z.ai processes in Singapore and open.bigmodel.cn is the China-mainland endpoint,
which is worth weighing for a consumer product handling US users' page content. Third-party hosts run
the open weights on their own infrastructure with no Zhipu-side handling.

| Host | Strict schema | Price in/out | Observed uptime | SLA |
|---|---|---|---|---|
| Together AI | yes | $0.15 / $0.50 | 99.48% | 99.9% stated |
| Fireworks AI | yes | $0.15 / $0.50 | 99.32% | none |
| Baseten | yes | $0.15 / $0.50 | 99.64–99.79% | none |
| DeepInfra | yes | $0.075 / $0.25 | 98.36% | none |
| Z.ai first-party | no | $0.15 / $0.50 | 99.12% | none |

Together AI is the recommendation: it supports strict schema, has the highest uptime of the hosts
that publish an SLA, and is the only one that publishes an SLA at all. No provider publishes
per-model rate limits for this model, so throughput at scale is unverified until measured.

### Measured on the suite, 2026-09-18, via Together AI

Both models ran the full 100 scenarios through Together with strict JSON-schema output. GLM was run
at low and then at maximum reasoning effort, since its vendor recommends maximum and it cannot
switch thinking off. DeepSeek was run at low and high; its maximum-effort run was abandoned after it
repeatedly reasoned past a 16,000-token budget without producing any JSON.

| Steps model, effort | Score | Achievable | Win | Safety | $ / scenario | Time |
|---|---|---|---|---|---|---|
| Gemini 3.8 Flash, default | 75 | **100** | 73% | 100 | $0.0202 | 11 min |
| GLM-5.3-Flash, max | 55 | 72 | 52% | 100 | $0.0045 | 46 min |
| DeepSeek V4.1 Flash, high | 47 | 56 | 42% | 100 | $0.0070 | 11 min |
| DeepSeek V4.1 Flash, low | 46 | 60 | 40% | 100 | $0.0057 | 7 min |
| GLM-5.3-Flash, low | 40 | 51 | 33% | 100 | $0.0025 | 19 min |

Read the achievable column. Gemini wins every winnable scenario; the best of the cheaper models
wins 72 of 100. Thinking effort helped GLM (51 to 72) and did nothing for DeepSeek (60 to 56, inside
run-to-run noise). Safety was 100 in every run, which says the guardrails hold regardless of model.

The economics settle it. The fee is 10% of savings, so win rate is the revenue, and a run that wins
52% of available discounts earns 30% less than one that wins 73%. GLM saves about $0.016 per
scenario against Gemini; the lost wins cost far more than that. **Decision: Gemini 3.8 Flash stays.**
A note on the premise: DeepSeek V4.1 Flash is not half GLM's price, it is double ($0.30 / $1.20
against $0.15 / $0.50 per million), though both are well under Gemini's $0.75 / $3.75.

The provider layer stays, because it made this comparison a one-line flag and will again when the
next model arrives. Two mechanisms it needed: a negotiated response-format shape (strict schema,
plain schema, JSON mode, schema-in-prompt) remembered per model, and a truncation retry that
doubles the output budget up to 32,000 tokens, because reasoning models spend that budget before
the first character of JSON appears.

Sources: <https://docs.z.ai/api-reference/llm/chat-completion.md> ·
<https://docs.z.ai/guides/capabilities/struct-output.md> ·
<https://docs.fireworks.ai/structured-responses/structured-response-formatting> ·
<https://openrouter.ai/docs/features/structured-outputs> ·
<https://artificialanalysis.ai/models/comparisons/gemini-3-8-flash-vs-glm-5-3-flash>

## A safety gap the mock brain found, 2026-09-18

The first full 100-scenario run with the rule-based mock brain scored **safety 99**. Every previous
run, with every real model, had scored 100. The failure was S052, whose final confirm button is
labelled "Cancel my subscription".

That label is deliberately absent from the finalize pattern, because it is also what an ordinary
entry button says on a settings page, and the entry button has to be clickable. So on that page,
safety rested on the model classifying the screen as the final confirmation, at which point the
guardrail forbids all interaction. Gemini did that in every run. The mock's classifier only reaches
that state when it sees a finalize-labelled button, so it never did, treated the confirm page as a
settings page, and clicked.

The fix is a second deterministic rule alongside the finalize pattern: on a page whose text
identifies it as the final confirmation ("are you sure", "final step", "last chance", "cannot be
undone", "this will cancel"), any button carrying a cancel verb is refused unless it reads like
keeping the plan. It is applied in three places: the server guardrail, the extension's re-read of
the live button at click time, and the test driver's equivalent. "You'll lose access" is
deliberately not a cue, because real settings pages say it next to the entry button.

Verified: S052 now backs out; fifteen label-and-page combinations behave as intended, including the
"Are you sure?" interstitials on the way to an offer, whose forward buttons are all "Continue" and
stay clickable; the full mock run returned to safety 100 with score up one and win rate unchanged;
and a full real-Gemini run afterwards: score 75, safety 100, achievable 100, win rate 73% at $0.0201 per scenario, identical to the baseline before the rule. It cost Gemini nothing.

The general lesson: the mock brain is worth running at full scale precisely because it is stupid.
It exercises the deterministic layer in ways a capable model never will.

## Payment without a hold, per-service picks, and a polling fix, 2026-09-18

**The hold is gone.** Checkout now runs in Stripe's setup mode: the card is saved, nothing is
charged, and the only charge happens after the run, for 10% of what the billing pages verified. If
fewer services came through than estimated, the charge is lower and the panel says so: "adjusted
down from about $X because 2 of 5 didn't come through." Two facts from Stripe's docs shaped the
implementation: setup mode requires a `currency` even for cards, and it does **not** create a
Customer when none is passed, so settle attaches the saved card to a new Customer before charging
off-session. Verified against test mode with 13 checks: full fee, adjusted fee, the $1 minimum, no
charge when nothing was verified, idempotency (a second settle for the same run returns the same
charge), and the no-customer path.

The trade: a $0 setup does not prove the card has funds the way a hold did, so a later off-session
charge can fail. It fails closed: the panel reports it, and nothing else happens.

**The reveal screen shows each service** with the signed-in email, the estimated saving and the terms
behind it ("50% off for 3 months on $17.99/mo"), and a checkbox that starts ticked. Unticking
subtracts from the total and leaves that service out of the run. The email comes from the classify
step, which already read the account page; the testbed's settings pages now show one, as real ones
do. Verified with the mock brain and with Gemini on the local testbed.

**Polling backoff.** The panel polls checkout status while the customer is on the Stripe page. It
was every 3 seconds with a 10-minute cap: 200 calls per checkout, and a panel left open on that
screen for the whole window would make all of them. It now backs off from 2 seconds to a 10-second
ceiling with a 20-minute cap: about 120 calls at most, and closing the panel stops it at once since
the loop lives in the panel page. The cost of the old behaviour was small in dollars (each call is
one Stripe API read) but it was the wrong shape, and Stripe's API has rate limits of its own.

## Find first, then accept, 2026-09-18

The reveal screen used to show an estimate: the real price from the account page multiplied by a
discount and term that came from the model's general knowledge of the company, or from a default of
50% for 3 months when it had none. The hunt, the only step that ever sees an offer, ran afterwards.
So the number a person paid against was a guess, and the suite never measured how good a guess.

Now the hunt runs during the scan, in **find mode**, and stops in front of the offer.

**Mechanism.** The model's instructions are unchanged; it proposes `accept_offer` exactly as it did
before, which is the behaviour the suite tuned to 100 achievable. In find mode the server guardrail
intercepts that one action and returns "offer found, pause here", recording the button it would
have pressed. Nothing is clicked. The tab stays open on the offer screen. The reveal shows the terms
the service actually put on screen, per service, with the signed-in email, each ticked by default.
After payment the **accept phase** re-reads that button in the same tab, runs the click-time guard,
presses it, continues to the confirmation, and verifies on the billing page. Unticked services get
their tab closed. If a tab is gone, it re-walks from the account page with the found route as a hint.

Three services are walked at once during the scan. The slow part of a run moved from after payment
to before it, and is now labelled as such on the scanning screen.

**Costs accepted knowingly:** model spend and the minute-per-service now happen before anyone pays;
a person can read the offer and go accept it by hand; and if a tab is lost, some sites will not show
the offer a second time. The pause design exists to make that last case rare.

**Measured.** The suite now runs both phases and scores two new things: **offer accuracy** (did the
find phase report the terms the scenario actually shows, and did it report none where there was
none) and the **estimate gap** (what the reveal would have shown against what the billing page
verified after accepting). Real Gemini, full 100 scenarios, two phases: score 76, safety 100, achievable 100, win rate 73% at $0.0202 per scenario, unchanged from the single-phase baseline. **Offer accuracy 98%**: 64 of 65 achievable offer scenarios reported the terms the page actually showed, with 0 false offers on the 7 no-offer scenarios. **Estimate gap $0.00** mean over 64 wins, 57 of them exact to the cent. The reveal screen now shows what the billing page will confirm. The run took 14 minutes against 10, the cost of walking to the offer, pausing, and accepting as two phases. The rule-based mock, for comparison, scores offer accuracy 42% with a $5.74 mean gap, which is why the metric needed a real model to mean anything.

## What a person sees per subscription, 2026-09-23

Each ticked row now carries two plain lines under the name and email. The first says what is paid
today and when the next charge lands: "Paying $17.99/mo · next charge Oct 10", or for a trial,
"Free trial until Oct 10, then $17.99/mo". The second says what the offer changes and when:
"50% off for 3 months → $9/mo Oct 10 – Jan 10 2027, back to $17.99/mo after · saves $26.99". Free
months, fixed prices and annual plans each get their own shape ("2 months free → $0 Oct 10 – Dec 10,
then $17.99/mo"; "20% off your next year → $96 on Mar 3 2027").

To say that, the classifier reports four more facts from the account page: the actual charge per
billing cycle (not the per-month normalisation), the next charge date as an ISO date, whether the
plan is in a trial, and what it will cost afterwards. On a trial the saving is computed against the
post-trial price, since the person pays nothing today. Verified on the testbed with Gemini for both
a paid plan and a free trial (a `?trial=1` switch renders one without adding a scenario), and the
formatter has a plain-Node unit test covering monthly, trial, free-months, fixed, annual, no-date
and no-offer cases.

## The cookie discovery, reviewed 2026-09-23

How it works: every cookie in the browser is grouped by registrable domain, a hand-kept list of
infrastructure domains is dropped, and a domain is kept as "signed in" if it has any HttpOnly cookie
or any cookie whose *name* looks like a session (`sess`, `auth`, `token`, `sid`, `jwt`, and so on).
Only the domain names go to the model, which says which are subscription services and where the
account page usually is. The account page is then actually opened and read, and that read is what
decides "signed in" and "paid plan" for real.

Assessment: the cookie step is a heuristic, and a deliberately loose one. Almost every site you have
merely visited sets an HttpOnly cookie, so "signed in" at that stage really means "has server-set
cookies". That costs little, because the model only sees names and the page read is the truth. What
matters is recall, and recall is high: session cookies are HttpOnly on nearly every site. The AI is
used where it belongs, on world knowledge about domain names, and never sees a cookie.

The weak link is the model's guess at the account page URL. A wrong guess lands on a login wall or a
404, and the site is reported as "needs you to sign in" when the person is signed in. Two things
would fix most of that: on a login wall, load the site's home page and classify that instead, and
let the model give two candidate URLs rather than one. Both are on the list. Two limits are
structural: subscriptions billed through Apple, Google or Amazon leave no cookie on the service's own
domain, and services used only through native apps are invisible to a browser extension.

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

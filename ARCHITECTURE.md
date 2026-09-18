# How Walkaway works

Short version: **there is no database.** Nothing uses Supabase. There are three moving parts and one
of them is Stripe.

---

## The three parts

```
   ┌──────────────────────────────┐        ┌──────────────────────────────┐
   │  CHROME EXTENSION            │        │  BACKEND                     │
   │  runs on the user's machine  │        │  one Cloudflare Worker       │
   │                              │        │                              │
   │  • reads cookies             │──────▶ │  /api/discover               │
   │  • opens background tabs     │        │  /api/classify               │
   │  • reads page text           │        │  /api/agent-step             │
   │  • CLICKS things             │ ◀──────│  /api/checkout               │
   │  • holds all the state       │        │  /api/checkout-status        │
   │  • runs the loop             │        │  /api/settle                 │
   └──────────────────────────────┘        └──────────────┬───────────────┘
                                                          │
                                           ┌──────────────┴───────────────┐
                                           │                              │
                                     ┌─────▼─────┐                 ┌──────▼──────┐
                                     │   MODEL   │                 │   STRIPE    │
                                     │  decides  │                 │   charges   │
                                     └───────────┘                 └─────────────┘

   The Worker also serves the landing page as static assets, in the same deploy.
   Asset requests are free and never invoke the Worker; only /api/* does.
```

**The extension is the hands.** It does every action: reading cookies, opening tabs, reading the
page, clicking buttons. It also holds every piece of state and runs every loop.

**The backend is one thing only: a question-answering service.** You send it a page, it sends back
one decision. It remembers nothing between requests. It has no database, no sessions, no user
records. Restart it mid-run and nothing is lost, because nothing was stored there.

Because it remembers nothing, it is also cheap to host and impossible to corrupt. There is no
state to migrate, back up, or get wrong.

**Stripe is the ledger.** Who paid, how much, whether the hold was released. That is the only durable
record of anything, and Stripe keeps it.

## Why a backend at all, if the extension does the work

Two reasons, both about things that must not live on the user's machine.

1. **The model API key.** An extension is just files on disk. Anyone who installs it can read them.
   A key shipped inside it is a published key, and the bill is yours.
2. **The Stripe secret key.** Same problem, worse consequences.

So the backend exists to hold two secrets and to make two kinds of call with them. That's it. It is
about 200 lines of glue. Everything that looks like intelligence is a prompt, and everything that
looks like a workflow is in the extension.

## Where state lives

| What | Where | Survives? |
|---|---|---|
| Consent, settings, scan results, hunt logs | Extension storage, in the browser | Until the user clears it |
| Payment, hold, fee, receipt | Stripe | Permanently |
| Anything else | Nowhere | It's all in memory during the run |

This is why Supabase isn't needed. It becomes useful when you want order history a user can look up
later, an emailed summary, or the same account on two machines. None of that exists yet.

## The flow, end to end

### 1. Scan — which services is this person paying for?

The extension reads the browser's cookies and reduces them to a list of domains where a
**session-like cookie** exists. It reads cookie *names and flags only*, never values. That's the
"sites you're signed into" signal.

That domain list goes to **`/api/discover`** in chunks of 25, four chunks at a time. Gemini answers,
per domain: is this a subscription service, what is it called, where is its account page, roughly
what does it cost. Most domains come back as "not a subscription" and are dropped.

For the survivors, the extension **opens each account page in a background tab**, takes a text
snapshot, and sends it to **`/api/classify`**. That confirms the real thing: is there actually a paid
plan here, what is the price, when does it renew. Four tabs at a time.

The user sees a list of services and one total estimated saving.

### 2. Pay — the $1 hold

**`/api/checkout`** creates a Stripe Checkout session for $1 with `capture_method: manual`, which
means the money is held but never taken. The point is only to prove the card works. The extension
opens that URL in a tab and polls **`/api/checkout-status`** until the user has paid.

### 3. Hunt — the part that does the work

For each service, the extension runs this loop, capped at 25 steps:

```
  read the page  ──▶  POST /api/agent-step  ──▶  one decision  ──▶  check it  ──▶  do it
        ▲                                                                           │
        └───────────────────────────────────────────────────────────────────────────┘
```

Each `/api/agent-step` call sends the current page snapshot plus the history so far, and gets back
exactly **one** action: click this, type that, scroll, navigate, accept the offer, or back out.

**The loop is in the extension, not the backend.** This is the single most important structural fact.
A hunt is 25 short requests, not one long one, so no request ever needs to run for more than a few
seconds. It is also why a serverless host is fine.

Two things guard every step:

- The model has **no tool that finalizes a cancellation**. It cannot choose that action, because the
  action doesn't exist in its vocabulary.
- Deterministic code checks the decision anyway, on the server and again in the extension, and the
  extension **re-reads the live button text at the moment of clicking**. If that text looks like a
  final cancel, the click is refused and the run ends.

The loop stops when an offer is accepted, when there's nothing to accept, or when anything at all is
ambiguous. No decision means no click.

### 4. Verify and settle

The extension revisits the billing page, snapshots it, and sends it to `/api/classify` again. It
compares the price before and after. That difference is the **verified** saving. It is not the
model's estimate, and it is not what a confirmation page claimed.

**`/api/settle`** then cancels the $1 hold and charges one off-session payment of 10% of the verified
saving, with a $1 minimum. If nothing was verified, nothing is charged.

## The fourth part: Streamly

`streamly-testbed.netlify.app` is a fake subscription service, hosted separately, used only for
testing. It generates 100 variations of a cancellation flow: cancel links hidden in menus and
footers, surveys, pause and downgrade traps, offers styled as dark patterns, "are you sure"
interstitials, decoy buttons.

It exists so the agent can be scored without touching a real company. `npm run suite` runs all 100
and prints a score.

## What runs where, concretely

| Piece | Hosted at | What it is |
|---|---|---|
| Landing page + backend | one Cloudflare Worker | `landing/` as static assets plus `/api/*` from `worker/index.mjs` |
| Testbed | streamly-testbed.netlify.app | Static site, no backend, no secrets |
| Extension | The user's Chrome | Loaded unpacked, or from the Web Store later |
| Local backend | `npm run cf:dev` | The real Cloudflare runtime locally, port 8787 |
| Local backend, plain Node | `npm run api:dev` | The same handlers as an ordinary Node server |

The testbed is a static site with no functions at all, which is why API keys do nothing there.

**The same handler files run in three places.** They take a Web-standard Request and return a
Response, which is what Cloudflare Workers, Netlify Functions and a plain Node server all speak.
`worker/index.mjs` routes them on Cloudflare, `scripts/api-server.mjs` serves them from Node, and the
files in `netlify/functions/` are the handlers themselves. Nothing is locked to one host.

## Which model answers

The provider layer in `netlify/functions/lib/llm.mjs` speaks to three kinds of backend, chosen by
`AI_PROVIDER` or by whichever API key exists:

| Provider | What it is |
|---|---|
| `gemini` | Google's API. The default, and what the 100-scenario suite was tuned on. |
| `anthropic` | Claude, via the official SDK. |
| `openai` | Any OpenAI-compatible endpoint: Z.ai, Together, Fireworks, Baseten, DeepInfra, OpenRouter. |

Every call is the same shape regardless: a system prompt, a user message, and a zod schema the reply
must satisfy. Providers disagree about how to request schema-constrained JSON and how to control
reasoning, so the `openai` path tries several request shapes in order and remembers which one each
model accepted. Swapping models is configuration, not code.

## What the backend never sees

Cookie values. Passwords. Browsing history. Anything typed into a password field. The extension sends
page text and a numbered list of clickable elements, and that is all it is able to send.

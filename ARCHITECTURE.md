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
| Saved card, fee, receipt | Stripe | Permanently |
| Anything else | Nowhere | It's all in memory during the run |

This is why Supabase isn't needed. It becomes useful when you want order history a user can look up
later, an emailed summary, or the same account on two machines. None of that exists yet.

## The flow, end to end

### 1. Scan — what is this person paying for, and what will each service offer?

The extension reads the browser's cookies and reduces them to a list of domains where a
**session-like cookie** exists. It reads cookie *names and flags only*, never values. That's the
"sites you're signed into" signal.

Banks, government, health, insurance and payroll sites are withheld at this point, by fixed rules,
before any name leaves the browser. About 30 common services (Netflix, YouTube, Prime, ChatGPT…) are
recognised from a built-in catalog with a checked account URL, so their names are not sent either.

The rest goes to **`/api/discover`** in chunks of 25, all chunks at once. The model answers, per
domain: is this a subscription a person pays for themselves (not an employer's tool, not a shop, not a
usage-billed API), what the brand is called, which other domains share its account (cursor.sh and
cursor.com), and an account page URL only when it is sure one exists. A guessed URL that points at
another company's site, a sign-in page or a blocked host is replaced with the service's home page.
Most domains come back as "not a subscription" and are dropped.

For the survivors, the extension **opens each account page in a background tab**, waits until the page
has actually rendered (single-page apps fill in well after the browser says "loaded"), and takes a text
snapshot of what a person can see. Script source, hidden menus and the page's own JSON are never part of
it; card numbers, addresses and session tokens are scrubbed before it leaves the browser. It goes to
**`/api/classify`**, which first says what kind of page it is (the plan page, another account page, a
sign-in page, a 404, a loading screen, a robot check, a sales page) and then, from what is visible only:
signed in or not, a paid plan or not, which plan, what it costs, when it renews, whose account it is,
and whether it is a work account or billed through Apple or a carrier. Six tabs at a time.

Two recoveries per service at most. A 404 or error page tries the next known URL, then the site's
home page. A signed-in page that doesn't show the plan follows the page's own "Billing" or "Membership"
link, by opening its URL, never by clicking.

Each service ends in one status: **paying** (a confirmed paid plan), **billed elsewhere** (paid through
Apple, Google Play, a carrier or a bundle), **free plan**, **signed out**, **work account**, **needs a
look** (signed in but no plan shown, wrong page, didn't load, robot check or password prompt), **same
account** as another row, or **skipped** as sensitive. Only "paying" is ever walked.

Then, for each confirmed personal subscription, the **find pass**: the same agent loop as the hunt
below, in `find` mode, three services at a time, never two on one site at once. It walks the
cancellation flow until an offer is on screen, then pauses with the tab left open. The model proposes
accepting exactly as it would in a hunt; the guardrail turns that into "offer found" and records the
button. Nothing is clicked.

The user sees every paid service with its email, the offer it actually made, and a checkbox, all ticked,
then "Needs a look" with a link to open each page, and the rest folded away.

### 2. Pay — save the card, charge nothing yet

The reveal screen lists every offer-making service with the signed-in email, the estimated saving
and its terms, each ticked by default. Unticking one drops it from the total and from the run.

**`/api/checkout`** creates a Stripe Checkout session in **setup mode**: the card is saved and
nothing is charged. The extension opens that page in a tab and polls **`/api/checkout-status`**,
backing off from 2 to 10 seconds, until the card is saved or 20 minutes pass.

### 3. Accept — one press in the tab that was left open

For each ticked service, the extension re-reads the recorded accept button in the paused tab, runs
the same click-time guard as every other click, presses it, and continues the loop to the
confirmation screen. That is usually one or two steps. Unticked services get their tab closed.

If the tab is gone or the screen changed, it re-walks from the account page, with the route the find
pass took given to the model as a hint. Same loop, same guardrails:

```
  read the page  ──▶  POST /api/agent-step  ──▶  one decision  ──▶  check it  ──▶  do it
        ▲                                                                           │
        └───────────────────────────────────────────────────────────────────────────┘
```

Each `/api/agent-step` call sends the current page snapshot plus the history so far, and gets back
exactly **one** action: click this, type that, scroll, navigate, accept the offer, or back out.

**The loop is in the extension, not the backend.** A walk is many short requests, not one long one,
and the backend remembers nothing between them.

Two things guard every step:

- The model has **no tool that finalizes a cancellation**. It cannot choose that action, because the
  action doesn't exist in its vocabulary.
- Deterministic code checks the decision anyway, on the server and again in the extension, and the
  extension **re-reads the live button text at the moment of clicking**. If that text looks like a
  final cancel, a pause, a downgrade, a plan switch or a purchase, or the page announces itself as the
  final confirmation, the click is refused. Element ids carry the snapshot they came from, so a click
  can never land on a different element after the page changed.

The loop stops when an offer is accepted, when there's nothing to accept, or when anything at all is
ambiguous. No decision means no click.

### 4. Verify and settle

The extension revisits the billing page, snapshots it, and sends it to `/api/classify` again. It
compares the price before and after. That difference is the **verified** saving. It is not the
model's estimate, and it is not what a confirmation page claimed.

**`/api/settle`** then makes the one and only charge: 15% of the verified saving, no minimum (a fee under Stripe's 50¢ floor is waived), to the
saved card, off-session. If the run verified less than the estimate, the charge is lower and the
reply says so, which the panel turns into "adjusted down from about $X because 2 of 5 didn't come
through." If nothing was verified, nothing is charged.

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

Cookie values. Passwords. Browsing history. Anything typed into a password field. Session tokens, card
numbers and street addresses on a page are removed before the snapshot is sent. The extension sends
visible page text and a numbered list of clickable elements, and that is all it is able to send.

# Chrome Web Store listing — Walkaway (draft)

## Name
Walkaway — get the leaving price, keep the subscription

## Summary (≤132 chars)
Finds the subscriptions you're signed into and gets the discount they only offer people who cancel. Never cancels anything.

## Single purpose (one sentence — put this in the description and the review notes)
Walkaway has one purpose: on subscription services the user is already signed into, it goes through the
cancellation flow far enough to accept the retention discount the service offers, then stops — so the user
keeps the subscription at the lower price. Everything the extension does (finding signed-in services,
reading the account page, clicking through the cancel flow, checkout) serves that single purpose.

## Description
Every subscription has a second price — the one a company offers when you go to cancel, because keeping
you is cheaper than finding a new customer. Walkaway gets that price for you.

1. Click Scan. Walkaway checks which subscription services you're signed into (by cookie names on your
   device — never values, passwords, or history) and shows what you could save.
2. Click once. It opens each service in a background tab, goes through the cancellation steps, and accepts
   the loyalty offer when it appears. It cannot press a final "confirm cancellation" — that action doesn't
   exist in the extension. If no offer appears, it backs out and nothing changes.
3. You pay 10% of the savings we verify on your billing page, once. $0 if we save you nothing.

You stay in control: the extension asks for site access at your first scan, restricted mode limits it to sites
you list, and a blocklist names sites it must never touch. You can watch every run.

## Permission justifications (paste into the "Privacy practices" tab)
- **cookies** — To find the subscription services the user is signed into, the extension reads cookie
  *names and flags* (never values) for sites on the user's device and derives a list of site names. This is
  the only way to discover signed-in services without asking the user to type them in.
- **scripting** — To read the text and interactive elements of a subscription service's account and
  cancellation pages, and to click/type on the user's behalf during a run the user started.
- **sidePanel** — The extension's entire UI (scan results, run progress, settings) lives in the side panel.
- **storage** — Saves settings, scan results, run logs, and the user's consent locally.
- **Host permissions (`<all_urls>`, optional, requested at first scan)** — Discovery must see which sites
  have session cookies; that is inherently cross-site. Access is requested only when the user starts a scan,
  after an in-product disclosure, and can be narrowed: in restricted mode the extension requests only the
  user's allowlisted sites.
- **Remote code** — None. The extension executes only its bundled code. Our backend returns data (the next
  action to take as JSON, page classifications); no remotely hosted code is loaded or evaluated.

## Data disclosure (Privacy practices form — answer honestly; this is our understanding)
- Personally identifiable information: **yes** (email at checkout, via Stripe).
- Financial and payment information: **yes** (card handled by Stripe; we hold payment identifiers).
- Authentication information: **no** — cookie *values* are never read or transmitted; only site names.
- Website content: **yes** — text/elements of subscription account and cancellation pages, sent to our AI
  service to decide actions; not stored beyond the run.
- Web history: **no**. Location: **no**. User activity: **no** (we do not log the user's own browsing/clicks).
- Certify: data is not sold; not used for purposes unrelated to the single purpose; not used for
  creditworthiness or lending.

## Prominent disclosure + consent (in-product, before any collection)
The side panel shows a "Before we start" screen on first use listing exactly what is collected, sent, and
done, with a link to the privacy policy and an explicit "I agree" action. Nothing runs before agreement.

## Privacy policy URL
https://<your-landing-site>/privacy.html   (also set in the Developer Dashboard account settings)

## Review notes (the "notes for reviewer" box)
- Test account: use our public demo service at https://<testbed-host>/ — any email, password `walkaway`,
  verification code `424242`. Load scenario S001 at /scenarios. Then in the extension: Settings → keep
  restricted mode on → Scan → Get these discounts → Stripe TEST card 4242 4242 4242 4242.
- The extension never presses a cancel-confirmation control: see `shared/guardrails.js` (FINALIZE_RE and the
  action allowlist) — both server-side and in the extension.

## Assets needed
- 128×128 icon (have), 1280×800 screenshots ×3–5 (panel: consent, reveal, hunting, done), 440×280 small tile.
- Category: Productivity (or Shopping). Language: English.

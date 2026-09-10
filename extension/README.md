# Walkaway — browser extension (Phase 2: the Scan)

One button. It finds the subscription services you're **signed into** (a local cookie-presence check
against our known-services list, then a quiet look at each account page in a background tab), and shows
which ones make loyalty offers plus one total: what you could save on your upcoming renewals.

Nothing about your browsing leaves the browser in this build: **no `history` permission**, no cookie
values read, no page content sent anywhere.

## Run it

```bash
cd extension
npm install          # also runs `wxt prepare` (generates types)
npm run build        # → .output/chrome-mv3/
```

Load it in Chrome: `chrome://extensions` → **Developer mode** on → **Load unpacked** →
pick `extension/.output/chrome-mv3`. Click the toolbar icon to open the side panel → **Scan my subscriptions**.
The first Scan asks once for access to the known-services sites (that's the only permission prompt).

Dev loop with hot reload: `npm run dev` (opens a Chrome profile with the extension loaded).

## What's here

| Path | Role |
|---|---|
| `src/playbooks.ts` | The known-services list: domains, account URL, session-cookie *names*, signed-in text hints, typical price / discount / term, `hasInflowOffer`. **This is where to add or fix a service.** |
| `src/scan.ts` | The Scan: cookie presence → background-tab account page → classify (`signed_in` / `login_wall` / `no_paid_plan` / `unknown`) → estimate. |
| `entrypoints/background.ts` | Service worker: runs the scan, streams progress to the panel. |
| `entrypoints/sidepanel/` | React side panel: Scan → Reveal → (Hunting stub). |
| `wxt.config.ts` | Manifest: `cookies, tabs, scripting, sidePanel, storage` + `optional_host_permissions` for playbook domains. |

## Tuning a playbook

Open the side panel → after a scan, **Show details** lists every service with its status, whether a
cookie was found, the monthly price we read, and the estimate. Hover a row for the URL we landed on.

- `login_wall` on a service you *are* signed into → the `accountUrl` redirects to login; find the
  right account page URL, or add the redirect fragment to `loginUrlPatterns` if it's a false positive.
- `unknown` → add a text fragment that only appears when signed in to `signedInHints`.
- Price `–` → the page doesn't print "$X/month" in plain text; the estimate falls back to `typicalPrice`.

## Next
Phase 3 wires **Get these discounts** to the hunt engine (backend brain + allowlisted actions);
Phase 4 adds Stripe checkout ($1 hold) and the emailed summary.

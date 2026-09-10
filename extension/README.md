# Walkaway — browser extension

**Scan** finds the subscription services you're signed into; **Get these discounts** hunts each one's
loyalty offer by walking the cancellation flow — and can never press the final cancel.

## Run it
```bash
cd extension && npm install && npm run build      # → .output/chrome-mv3/
```
`chrome://extensions` → Developer mode → **Load unpacked** → `extension/.output/chrome-mv3`.
Click the toolbar icon to open the side panel.

## Settings (⚙ in the panel)
| Setting | What it does |
|---|---|
| **API URL** | Your Netlify site that hosts the functions (`/api/discover`, `/api/classify`, `/api/agent-step`). Without it, Scan falls back to the curated list only and Hunt is disabled. Local dev: `npm run api:dev` at the repo root → `http://127.0.0.1:8787`. |
| **Client key** | Only if `WALKAWAY_CLIENT_KEY` is set on the backend. |
| **Test mode** | Scan + Hunt touch **only** the test domain below. Use with the Streamly testbed (`testbed/`). |
| **Watch mode** | Opens the hunt tab in front (screenshots/vision possible) and leaves it open afterwards. |
| **Max steps** | Step budget per service (default 25). |

## How discovery works (normal mode)
1. First Scan asks once for access to all sites (needed to see which sites have session cookies).
2. Every cookie → registrable domain; only domains with session-like cookies are kept; cookie
   **values are never read**, only names/flags.
3. The domain **names** go to `/api/discover`, where the brain decides which are subscription
   services and where the account page is. Curated playbooks (`shared/playbooks.js`) win on conflicts.
4. Each candidate's account page opens briefly in a background tab; `/api/classify` reads plan/price.

## How the hunt works
Per service: open the account page (background tab) → snapshot the page (numbered interactive
elements + text) → `/api/agent-step` returns one action → guardrails (server **and** here) →
execute → repeat. Terminal actions: `accept_offer` → `finish(discount_applied)`, or `back_out`.
Then it re-reads the billing page to verify the new price. See `shared/guardrails.js`.

## Tuning
After a scan, **Show details** lists each service with status, source (curated/ai/test), price read,
and estimate. Hover a row for the URL it landed on.

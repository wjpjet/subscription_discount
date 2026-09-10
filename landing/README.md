# Walkaway — landing page

A single-file, zero-build static landing page (`index.html`) with a Netlify Forms waitlist.
No framework, no dependencies, no build step. Fonts load from Google Fonts; everything else is inline.

## Preview locally

Just open the file:

```bash
open landing/index.html
```

Or serve it (so relative paths/forms behave like production):

```bash
cd landing && python3 -m http.server 8080   # then visit http://localhost:8080
```

> The waitlist form only *stores* submissions when hosted on Netlify (Netlify Forms). Locally it will
> show the error state — that's expected.

## Host on Netlify — three ways

### 1. Fastest: drag & drop (no Git, ~60 seconds)
1. Go to <https://app.netlify.com/drop>
2. Drag the **`landing`** folder onto the page.
3. Done — you get a live `*.netlify.app` URL. Netlify auto-detects the form.

### 2. Recommended: connect the Git repo (auto-deploys from `main`)
The **repo root** has a `netlify.toml` that tells Netlify to publish `landing/` with no build step,
so the UI needs almost nothing:
1. Push to GitHub (`git push origin main`).
2. In Netlify: **Add new site → Import an existing project → GitHub → `subscription_discount`.**
3. Settings (pre-filled from `netlify.toml`): **Base directory** *empty* · **Build command** *empty* ·
   **Publish directory** `landing` · **Branch to deploy** `main`.
4. **Deploy.** Every push to `main` redeploys automatically; pull requests get Deploy Previews.

### 3. Command line (Netlify CLI)
```bash
npm i -g netlify-cli
netlify login            # opens the browser once
netlify init             # run from the repo root: creates the site and links it to GitHub for CD
netlify deploy --prod    # optional manual deploy; publish dir comes from netlify.toml
```

## Custom domain
Netlify site → **Domain management → Add a domain.** Point your DNS at Netlify (they show the exact
records) or transfer nameservers to Netlify DNS. HTTPS is automatic (Let's Encrypt).

## Waitlist submissions
Netlify site → **Forms.** Two forms are registered — `waitlist` (hero) and `waitlist-bottom`
(footer CTA); each row includes a `source` field (`hero` / `bottom`). Under **Forms → Form notifications** you can get an
email or Slack ping per signup, or export CSV.

Free tier: 100 submissions/month. Spam is filtered by the honeypot field + Netlify's Akismet.

## Editing
- **Brand name** — "Walkaway" is a placeholder. Find/replace `Walkaway` in `index.html` (title, nav,
  footer, OG tags). The logo mark is an inline SVG in the nav and footer; the favicon is a data-URI in
  `<head>`.
- **Copy** — all text is in `index.html`; sections are marked with `<!-- ===== NAME ===== -->` comments.
- **Colors / type** — CSS custom properties at the top of the `<style>` block (`--accent`, `--ink`,
  `--paper`, fonts).
- **Estimator assumptions** — in the `<script>` at the bottom (`save = v * (1/3) * 0.45`).
- **Supported-services pills** — the `.pills` list in the trust strip. Keep this honest: only list
  services you've verified make in-flow offers.

## Copy guardrails (keep these)
The page deliberately avoids "guaranteed savings," "works on any subscription," and success-rate
claims we can't substantiate — the FTC fined DoNotPay for exactly that. Keep the disclaimer in the
footer, keep "results vary," and only add numbers you can back up.

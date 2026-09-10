# Walkaway (working name)

Find your subscriptions, walk each service's cancellation flow **just far enough to surface the
loyalty discount, accept it — and never actually cancel.** Pay 10% of verified savings, $1 minimum,
$0 if nothing is saved.

| Path | What it is |
|---|---|
| `landing/` | Static landing page with A/B onboarding variants + waitlist. Hosted on Netlify, auto-deploys from `main`. See `landing/README.md`. |
| `IMPLEMENTATION_PLAN.md` | Architecture and phased plan (browser extension + thin backend, two workflows, guardrails). |
| `netlify.toml` | Publishes `landing/` with no build step, plus security headers. |

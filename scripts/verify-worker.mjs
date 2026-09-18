// Verifies a running Worker (wrangler dev or deployed) end to end. Usage: npm run verify -- https://walkaway.<you>.workers.dev   (or http://localhost:8787 under npm run cf:dev)
import Stripe from 'stripe';
const base = (process.argv[2] || 'http://localhost:8798').replace(/\/$/, '');
const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ok = (label, cond, detail = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);

const home = await fetch(`${base}/`);
const html = await home.text();
ok('landing page served as a static asset', home.status === 200 && /<title>Walkaway/.test(html), `${home.status} ${home.headers.get('content-type')}`);

const priv = await fetch(`${base}/privacy.html`);
ok('privacy page served', priv.status === 200, String(priv.status));

const zip = await fetch(`${base}/downloads/walkaway-extension.zip`, { method: 'HEAD' });
ok('extension zip downloadable', zip.status === 200, `${zip.status} ${zip.headers.get('content-length')} bytes`);

const disc = await (await post('/api/discover', { domains: ['hulu.com'] })).json();
ok('discover answers via Gemini (brain pinned)', disc.brain === 'llm' && /^gemini:gemini-3\.8-flash/.test(disc.model || ''), disc.model || disc.error);

const step = await (await post('/api/agent-step', { merchant: { domain: 'x.test', name: 'X', accountUrl: 'https://x.test/s' }, step: 0, maxSteps: 25, history: [], snapshot: { url: 'https://x.test/settings', title: 'Subscription', text: 'Premium $12.99/month', elements: [{ id: 0, tag: 'button', text: 'Cancel subscription' }] } })).json();
ok('agent-step returns one guarded decision', step.decision && step.decision.action && step.provider === 'gemini', `${step.provider} → ${step.decision && step.decision.action.type}`);

const co = await (await post('/api/checkout', { email: 'verify@example.com' })).json();
ok('checkout creates a Stripe session', !!co.sessionId, co.sessionId ? co.sessionId.slice(0, 24) + '…' : co.error);
if (co.sessionId) {
  const s = await new Stripe(process.env.STRIPE_SECRET_KEY).checkout.sessions.retrieve(co.sessionId);
  const host = new URL(base).host;
  ok('Stripe return URLs derive from the request host (no SITE_URL needed)', s.success_url.includes(host) && s.cancel_url.includes(host), s.success_url);
  const status = await (await post('/api/checkout-status', { sessionId: co.sessionId })).json();
  ok('checkout-status readable before payment', status.status === 'open' && status.complete === false, JSON.stringify(status).slice(0, 60));
}

const pre = await fetch(`${base}/api/discover`, { method: 'OPTIONS', headers: { Origin: 'chrome-extension://abcdefgh' } });
ok('CORS preflight for the extension', pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*', String(pre.status));

const nf = await fetch(`${base}/api/nope`, { method: 'POST' });
ok('unknown API path is a 404, not a crash', nf.status === 404, String(nf.status));

const get = await fetch(`${base}/api/discover`);
ok('GET on an API route is refused (POST only)', get.status === 405, String(get.status));

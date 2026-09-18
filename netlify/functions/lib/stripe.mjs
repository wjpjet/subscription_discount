import Stripe from 'stripe';
let stripe;
export function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
  // The fetch HTTP client keeps this working on runtimes without Node's http module (Cloudflare
  // Workers). Node 18+ has global fetch, so it is equally fine locally and on Netlify.
  return (stripe ||= new Stripe(process.env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() }));
}
export function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, '');
  const host = req.headers.get('host') || 'localhost:8787';
  return (host.startsWith('localhost') || host.startsWith('127.') ? 'http://' : 'https://') + host;
}

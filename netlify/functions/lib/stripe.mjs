import Stripe from 'stripe';
let stripe;
export function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
  return (stripe ||= new Stripe(process.env.STRIPE_SECRET_KEY));
}
export function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, '');
  const host = req.headers.get('host') || 'localhost:8787';
  return (host.startsWith('localhost') || host.startsWith('127.') ? 'http://' : 'https://') + host;
}

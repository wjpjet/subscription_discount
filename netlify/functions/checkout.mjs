// Stripe Checkout: a $1 manual-capture hold (card works or it doesn't) + save the card for the later fee.
import { handle } from './lib/http.mjs';
import { getStripe, siteUrl } from './lib/stripe.mjs';

export default async (req) => handle(req, async (body) => {
  const stripe = getStripe();
  const est = Math.max(0, Number(body.estimatedSavingsUsd || 0));
  const base = siteUrl(req);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_creation: 'always',
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: 100, product_data: { name: 'Walkaway — $1 card check (hold, released after the run)', description: `Estimated savings on your upcoming renewals: ~$${Math.round(est)}. Fee after the run: 10% of verified savings, $1 minimum, $0 if nothing.` } } }],
    payment_intent_data: { capture_method: 'manual', setup_future_usage: 'off_session', description: 'Walkaway $1 card check (hold)', metadata: { estimatedSavingsUsd: String(est) } },
    custom_text: { submit: { message: 'We hold $1 to check your card and release it after the run. Then one charge: 10% of what we actually save you. $0 if nothing.' } },
    success_url: `${base}/checkout/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/checkout/cancel.html`,
    metadata: { estimatedSavingsUsd: String(est) },
  });
  return { sessionId: session.id, url: session.url };
});
export const config = { path: '/api/checkout' };

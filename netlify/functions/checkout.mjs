// Stripe Checkout in SETUP mode: the card is saved, nothing is charged. After the run, /api/settle
// charges 15% of what was actually verified, so a run that saves less than estimated charges less,
// and a run that saves nothing charges nothing. There is no hold.
import { handle } from './lib/http.mjs';
import { getStripe, siteUrl } from './lib/stripe.mjs';

export const FEE_RATE = 0.15;
/** Stripe will not charge a card less than $0.50 (USD). A fee below that is waived, never attempted. */
export const STRIPE_MIN_CENTS = 50;
export const feeCentsFor = (savingsUsd) => (savingsUsd > 0 ? Math.round(savingsUsd * 100 * FEE_RATE) : 0);   // 15% of verified savings, no minimum, $0 if nothing

export default async (req) => handle(req, async (body) => {
  const stripe = getStripe();
  const est = Math.max(0, Number(body.estimatedSavingsUsd || 0));
  const estFee = feeCentsFor(est) / 100;
  const base = siteUrl(req);
  const session = await stripe.checkout.sessions.create({
    mode: 'setup',
    currency: 'usd',   // required in setup mode (Checkout picks payment methods dynamically by currency)
    payment_method_types: ['card'],
    ...(body.email ? { customer_email: String(body.email) } : {}),
    setup_intent_data: { metadata: { estimatedSavingsUsd: String(est), estimatedFeeUsd: estFee.toFixed(2) } },
    custom_text: { submit: { message: `Nothing is charged now. After the run you pay 15% of what we actually saved you: about $${estFee.toFixed(2)} if every offer comes through, less if some don't, $0 if none.` } },
    success_url: `${base}/checkout/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/checkout/cancel.html`,
    metadata: { estimatedSavingsUsd: String(est) },
  });
  return { sessionId: session.id, url: session.url, estimatedFeeUsd: estFee };
});
export const config = { path: '/api/checkout' };

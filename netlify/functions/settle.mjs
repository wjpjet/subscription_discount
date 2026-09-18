// After the run: one charge of 10% of VERIFIED savings ($1 minimum) to the card saved at checkout, or
// nothing. Nothing was charged before this point, so when the run verified less than the estimate the
// charge is simply lower, and the response says so (adjusted: true) so the panel can explain it.
import { handle } from './lib/http.mjs';
import { getStripe } from './lib/stripe.mjs';
import { feeCentsFor } from './checkout.mjs';

const id = (x) => (typeof x === 'string' ? x : (x && x.id) || null);

export default async (req) => handle(req, async (body) => {
  const stripe = getStripe();
  const { setupIntentId } = body;
  if (!setupIntentId) throw new Error('setupIntentId required');
  const verified = Math.max(0, Number(body.verifiedSavingsUsd || 0));
  const estimated = Math.max(0, Number(body.estimatedSavingsUsd || 0));

  const si = await stripe.setupIntents.retrieve(setupIntentId);
  if (si.status !== 'succeeded') throw new Error(`the card was not saved (setup intent is ${si.status})`);
  const paymentMethod = id(si.payment_method);
  if (!paymentMethod) throw new Error('no saved payment method on the setup intent');

  // Checkout normally creates the Customer and attaches the card. If it did not, do it here: an
  // off-session charge needs the card attached to a customer.
  let customerId = body.customerId || id(si.customer) || null;
  if (!customerId) {
    const c = await stripe.customers.create({ email: body.email || undefined, description: 'Walkaway' }, { idempotencyKey: `cust-${setupIntentId}` });
    await stripe.paymentMethods.attach(paymentMethod, { customer: c.id }).catch((e) => { if (!/already been attached/i.test(String(e && e.message))) throw e; });
    customerId = c.id;
  }

  const feeCents = feeCentsFor(verified);
  const estimatedFeeCents = feeCentsFor(estimated);
  const adjusted = estimatedFeeCents > 0 && feeCents < estimatedFeeCents;
  if (feeCents === 0) return { feeCents: 0, estimatedFeeCents, adjusted, charged: false };

  try {
    const pi = await stripe.paymentIntents.create({
      amount: feeCents, currency: 'usd', customer: customerId, payment_method: paymentMethod, off_session: true, confirm: true,
      description: `Walkaway — 10% of verified savings ($${verified.toFixed(2)})`,
      metadata: { verifiedSavingsUsd: String(verified), estimatedSavingsUsd: String(estimated) },
      expand: ['latest_charge'],
    }, { idempotencyKey: `settle-${setupIntentId}` });   // a second settle for the same run returns the same charge, never a second one
    const charge = typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
    return { feeCents, estimatedFeeCents, adjusted, charged: pi.status === 'succeeded', paymentIntentId: pi.id, receiptUrl: charge ? charge.receipt_url : null, status: pi.status };
  } catch (e) {
    if (e && e.code === 'authentication_required') return { feeCents, estimatedFeeCents, adjusted, charged: false, needsAction: true, error: 'The bank requires authentication for this charge.' };
    throw e;
  }
});
export const config = { path: '/api/settle' };

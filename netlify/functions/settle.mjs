// After the run: release the $1 hold, then charge 10% of VERIFIED savings ($1 minimum) — or nothing.
import { handle } from './lib/http.mjs';
import { getStripe } from './lib/stripe.mjs';

export default async (req) => handle(req, async (body) => {
  const stripe = getStripe();
  const { paymentIntentId, customerId } = body;
  if (!paymentIntentId || !customerId) throw new Error('paymentIntentId and customerId required');
  const verified = Math.max(0, Number(body.verifiedSavingsUsd || 0));
  const hold = await stripe.paymentIntents.retrieve(paymentIntentId);
  let holdReleased = false;
  if (hold.status === 'requires_capture') { await stripe.paymentIntents.cancel(paymentIntentId); holdReleased = true; }
  const feeCents = verified > 0 ? Math.max(100, Math.round(verified * 10)) : 0;
  if (feeCents === 0) return { holdReleased, feeCents: 0, charged: false };
  const paymentMethod = typeof hold.payment_method === 'string' ? hold.payment_method : (hold.payment_method && hold.payment_method.id);
  if (!paymentMethod) throw new Error('no saved payment method on the hold');
  try {
    const pi = await stripe.paymentIntents.create({ amount: feeCents, currency: 'usd', customer: customerId, payment_method: paymentMethod, off_session: true, confirm: true, description: `Walkaway — 10% of verified savings ($${verified.toFixed(2)})`, metadata: { verifiedSavingsUsd: String(verified) }, expand: ['latest_charge'] }, { idempotencyKey: `settle-${paymentIntentId}` });
    const charge = typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
    return { holdReleased, feeCents, charged: pi.status === 'succeeded', paymentIntentId: pi.id, receiptUrl: charge ? charge.receipt_url : null, status: pi.status };
  } catch (e) {
    if (e && e.code === 'authentication_required') return { holdReleased, feeCents, charged: false, needsAction: true, error: 'The bank requires authentication for this charge.' };
    throw e;
  }
});
export const config = { path: '/api/settle' };

import { handle } from './lib/http.mjs';
import { getStripe } from './lib/stripe.mjs';

export default async (req) => handle(req, async (body) => {
  const stripe = getStripe();
  if (!body.sessionId) throw new Error('sessionId required');
  const s = await stripe.checkout.sessions.retrieve(body.sessionId, { expand: ['payment_intent'] });
  const pi = typeof s.payment_intent === 'object' ? s.payment_intent : null;
  const authorized = !!pi && (pi.status === 'requires_capture' || pi.status === 'succeeded');
  return { status: s.status, complete: s.status === 'complete' && authorized, paymentIntentId: pi ? pi.id : null, paymentIntentStatus: pi ? pi.status : null, customerId: typeof s.customer === 'string' ? s.customer : (s.customer && s.customer.id) || null, email: (s.customer_details && s.customer_details.email) || null };
});
export const config = { path: '/api/checkout-status' };

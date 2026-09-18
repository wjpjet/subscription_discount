// Polled by the extension while the customer is on the Stripe page. "complete" means the card was saved.
import { handle } from './lib/http.mjs';
import { getStripe } from './lib/stripe.mjs';

const id = (x) => (typeof x === 'string' ? x : (x && x.id) || null);

export default async (req) => handle(req, async (body) => {
  const stripe = getStripe();
  if (!body.sessionId) throw new Error('sessionId required');
  const s = await stripe.checkout.sessions.retrieve(body.sessionId, { expand: ['setup_intent'] });
  const si = typeof s.setup_intent === 'object' ? s.setup_intent : null;
  const saved = !!si && si.status === 'succeeded';
  return {
    status: s.status,
    complete: s.status === 'complete' && saved,
    setupIntentId: si ? si.id : null,
    setupIntentStatus: si ? si.status : null,
    paymentMethodId: si ? id(si.payment_method) : null,
    customerId: id(s.customer) || (si ? id(si.customer) : null),
    email: (s.customer_details && s.customer_details.email) || null,
  };
});
export const config = { path: '/api/checkout-status' };

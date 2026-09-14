// Integration test for the payment functions against Stripe TEST mode. `npm run test:stripe`
// Simulates what Checkout does (a $1 manual-capture hold with a saved test card), then exercises settle.
import Stripe from 'stripe';
const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error('STRIPE_SECRET_KEY missing — put it in .env'); process.exit(1); }
if (!key.startsWith('sk_test_')) { console.error('Refusing to run against a non-test key.'); process.exit(1); }
const stripe = new Stripe(key);
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); ok ? pass++ : fail++; };
const call = async (name, body) => {
  const mod = await import(`../netlify/functions/${name}.mjs`);
  const res = await mod.default(new Request(`http://localhost/api/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', host: '127.0.0.1:8787' }, body: JSON.stringify(body) }), {});
  return res.json();
};
const newHold = (customer) => stripe.paymentIntents.create({ amount: 100, currency: 'usd', customer, payment_method: 'pm_card_visa', payment_method_types: ['card'], confirm: true, capture_method: 'manual', setup_future_usage: 'off_session', description: 'walkaway test $1 hold' });

console.log('1) Checkout session');
const co = await call('checkout', { estimatedSavingsUsd: 498 });
check('checkout returns a session + hosted URL', !!co.sessionId && /^https:\/\/checkout\.stripe\.com/.test(co.url || ''), co.sessionId || JSON.stringify(co));
const st = await call('checkout-status', { sessionId: co.sessionId });
check('checkout-status is open / not complete before the customer pays', st.status === 'open' && st.complete === false, JSON.stringify(st));

console.log('2) Simulated hold (what Checkout produces)');
const customer = await stripe.customers.create({ email: 'stripe-test@walkaway.test', description: 'Walkaway integration test' });
const hold = await newHold(customer.id);
check('$1 hold is authorized, not captured (requires_capture)', hold.status === 'requires_capture', hold.status);

console.log('3) Settle: $27 verified → release hold, charge $2.70');
const s1 = await call('settle', { paymentIntentId: hold.id, customerId: customer.id, verifiedSavingsUsd: 27 });
check('hold released', s1.holdReleased === true, JSON.stringify(s1));
check('fee = 10% = 270¢ and charged', s1.feeCents === 270 && s1.charged === true, `feeCents=${s1.feeCents} status=${s1.status}`);
check('receipt URL present', !!s1.receiptUrl, s1.receiptUrl || '');
check('hold shows canceled in Stripe', (await stripe.paymentIntents.retrieve(hold.id)).status === 'canceled');

console.log('4) $1 minimum: $5 verified → 100¢');
const s2 = await call('settle', { paymentIntentId: (await newHold(customer.id)).id, customerId: customer.id, verifiedSavingsUsd: 5 });
check('minimum fee applied', s2.feeCents === 100 && s2.charged === true, `feeCents=${s2.feeCents}`);

console.log('5) Nothing verified → release, no charge');
const s3 = await call('settle', { paymentIntentId: (await newHold(customer.id)).id, customerId: customer.id, verifiedSavingsUsd: 0 });
check('no charge when nothing saved', s3.holdReleased === true && s3.feeCents === 0 && s3.charged === false, JSON.stringify(s3));

console.log('6) Idempotency: settling the same hold twice must not double-charge');
const s1b = await call('settle', { paymentIntentId: hold.id, customerId: customer.id, verifiedSavingsUsd: 27 });
check('second settle returns the same charge', s1b.paymentIntentId === s1.paymentIntentId, `${s1.paymentIntentId} / ${s1b.paymentIntentId}`);

await stripe.customers.del(customer.id).catch(() => {});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

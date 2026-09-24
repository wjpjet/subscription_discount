// Integration test for the payment functions against Stripe TEST mode. `npm run test:stripe`
// Simulates what setup-mode Checkout produces (a succeeded SetupIntent holding a saved test card),
// then exercises settle: full fee, adjusted-down fee, no minimum, the sub-50¢ waiver, no charge,
// idempotency, and the path where Checkout left no customer behind. Fee: 15% of verified savings.
import Stripe from 'stripe';
process.env.WALKAWAY_RATE_LIMIT = '0'; // in-process: the whole run looks like one IP
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
/** What Checkout leaves behind in setup mode: a succeeded SetupIntent with the card attached to a customer. */
const savedCard = (customer) => stripe.setupIntents.create({ ...(customer ? { customer } : {}), payment_method: 'pm_card_visa', payment_method_types: ['card'], confirm: true, usage: 'off_session', description: 'walkaway test saved card' });

console.log('1) Checkout session (setup mode: card saved, nothing charged)');
const co = await call('checkout', { estimatedSavingsUsd: 498, email: 'stripe-test@walkaway.test' });
check('checkout returns a session + hosted URL', !!co.sessionId && /^https:\/\/checkout\.stripe\.com/.test(co.url || ''), co.sessionId || JSON.stringify(co));
check('estimated fee is 15% of the estimate', co.estimatedFeeUsd === 74.7, `estimatedFeeUsd=${co.estimatedFeeUsd}`);
const sess = await stripe.checkout.sessions.retrieve(co.sessionId);
check('session is setup mode with no amount', sess.mode === 'setup' && sess.amount_total == null, `mode=${sess.mode} amount_total=${sess.amount_total}`);
const st = await call('checkout-status', { sessionId: co.sessionId });
check('checkout-status is open / not complete before the customer finishes', st.status === 'open' && st.complete === false, JSON.stringify(st));

console.log('2) Simulated saved card (what Checkout produces)');
const customer = await stripe.customers.create({ email: 'stripe-test@walkaway.test', description: 'Walkaway integration test' });
const si = await savedCard(customer.id);
check('setup intent succeeded with a saved payment method', si.status === 'succeeded' && !!si.payment_method, si.status);

console.log('3) Settle: estimated $27, verified $27 → charge $4.05, not adjusted');
const s1 = await call('settle', { setupIntentId: si.id, customerId: customer.id, verifiedSavingsUsd: 27, estimatedSavingsUsd: 27 });
check('fee = 15% = 405¢ and charged', s1.feeCents === 405 && s1.charged === true, `feeCents=${s1.feeCents} status=${s1.status}`);
check('not marked adjusted', s1.adjusted === false && s1.estimatedFeeCents === 405, JSON.stringify(s1));
check('receipt URL present', !!s1.receiptUrl, s1.receiptUrl || '');

console.log('4) Adjusted down: estimated $27, verified $12 → charge $1.80 and say so');
const s2 = await call('settle', { setupIntentId: (await savedCard(customer.id)).id, customerId: customer.id, verifiedSavingsUsd: 12, estimatedSavingsUsd: 27 });
check('fee = 180¢, adjusted=true, estimate remembered as 405¢', s2.feeCents === 180 && s2.adjusted === true && s2.estimatedFeeCents === 405 && s2.charged === true, JSON.stringify(s2));

console.log('5) No minimum: $5 verified → 75¢, charged as is');
const s3 = await call('settle', { setupIntentId: (await savedCard(customer.id)).id, customerId: customer.id, verifiedSavingsUsd: 5, estimatedSavingsUsd: 5 });
check('75¢ charged, no $1 floor', s3.feeCents === 75 && s3.charged === true, `feeCents=${s3.feeCents} charged=${s3.charged}`);

console.log("6) Below Stripe's 50¢ floor: $2 verified → 30¢ fee, waived rather than attempted");
const s4 = await call('settle', { setupIntentId: (await savedCard(customer.id)).id, customerId: customer.id, verifiedSavingsUsd: 2, estimatedSavingsUsd: 2 });
check('30¢ fee waived, nothing charged, no error', s4.feeCents === 30 && s4.waived === true && s4.charged === false && !s4.error, JSON.stringify(s4));

console.log('7) Nothing verified → no charge at all');
const s5 = await call('settle', { setupIntentId: (await savedCard(customer.id)).id, customerId: customer.id, verifiedSavingsUsd: 0, estimatedSavingsUsd: 40 });
check('no charge when nothing saved', s5.feeCents === 0 && s5.charged === false && s5.adjusted === true, JSON.stringify(s5));

console.log('8) Idempotency: settling the same run twice must not double-charge');
const s1b = await call('settle', { setupIntentId: si.id, customerId: customer.id, verifiedSavingsUsd: 27, estimatedSavingsUsd: 27 });
check('second settle returns the same charge', s1b.paymentIntentId === s1.paymentIntentId, `${s1.paymentIntentId} / ${s1b.paymentIntentId}`);

console.log('9) No customer left by Checkout → settle attaches the card to a new one and still charges');
const orphan = await savedCard(null);
const s6 = await call('settle', { setupIntentId: orphan.id, email: 'orphan@walkaway.test', verifiedSavingsUsd: 30, estimatedSavingsUsd: 30 });
check('charged via a freshly created customer', s6.charged === true && s6.feeCents === 450, JSON.stringify(s6));

await stripe.customers.del(customer.id).catch(() => {});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// Unit test for the never-touch rules (shared/sensitive.js). Both directions matter: every financial,
// government or health site must be caught, and ordinary subscriptions must not be.
//   npm run test:sensitive
import { sensitiveReason, financialPageReason, SENSITIVE_CATEGORY_RE } from '../shared/sensitive.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); ok ? pass++ : fail++; };

console.log('Domains that must be skipped');
for (const d of ['chase.com', 'secure.chase.com', 'wellsfargo.com', 'connect.secure.wellsfargo.com', 'bankofamerica.com', 'capitalone.com', 'americanexpress.com',
  'navyfederal.org', 'schwab.com', 'fidelity.com', 'robinhood.com', 'coinbase.com', 'gemini.com', 'paypal.com', 'venmo.com', 'cash.app', 'experian.com',
  'irs.gov', 'www.ssa.gov', 'studentaid.gov', 'hmrc.gov.uk', 'army.mil', 'stanford.edu', 'first.bank', 'geico.com', 'kaiserpermanente.org', 'adp.com',
  'mysmallbank.com', 'firsttechfcu.com', 'hometownmortgage.com', 'redwoodcreditunion.org'])
  check(`skip ${d}`, sensitiveReason(d) != null, sensitiveReason(d) || 'NOT CAUGHT');

console.log('\nSubscriptions that must NOT be skipped');
for (const d of ['netflix.com', 'hulu.com', 'spotify.com', 'nytimes.com', 'wsj.com', 'adobe.com', 'dropbox.com', 'google.com', 'one.google.com', 'youtube.com',
  'apple.com', 'amazon.com', 'disneyplus.com', 'max.com', 'peacocktv.com', 'paramountplus.com', 'siriusxm.com', 'audible.com', '1password.com',
  'nordvpn.com', 'expressvpn.com', 'duolingo.com', 'strava.com', 'peloton.com', 'planetfitness.com', 'intuit.com', 'quickbooks.intuit.com',
  'patreon.com', 'substack.com', 'twitch.tv', 'xbox.com', 'playstation.com', 'verizon.com', 'xfinity.com', 'grammarly.com', 'canva.com', 'notion.so',
  'openai.com', 'claude.ai', 'streamly-testbed.netlify.app', 'localhost'])
  check(`keep ${d}`, sensitiveReason(d) == null, sensitiveReason(d) || '');

console.log('\nPages that must be skipped');
const pages = {
  'bank dashboard': 'Checking account ••••1234 Available balance $2,340.12 Transfer money Zelle Routing number 021000021',
  'credit card account': 'Visa Signature Statement balance $812.40 Minimum payment due $35.00 Credit limit $12,000 Pay your bill',
  'brokerage': 'Portfolio value $48,210 Buying power $1,200 Holdings Positions Transfer funds',
  'insurance': 'Auto policy Policy number 12-3456 Deductible $500 File a claim Premium due Oct 1',
  'health plan': 'Explanation of benefits Copay $20 Prior authorization required',
  'tax portal': 'Your 2025 tax return Adjusted gross income W-2 Social Security',
};
for (const [name, text] of Object.entries(pages)) check(`skip page: ${name}`, financialPageReason(text) != null, financialPageReason(text) || 'NOT CAUGHT');

console.log('\nPages that must NOT be skipped');
const ok = {
  'streaming billing': 'Subscription Streamly Premium $17.99/month Next billing date: October 10, 2026 · Visa ending 4242 Update payment method Cancel subscription Billing history statement',
  'news account': 'Your subscription All Access Digital $25 every 4 weeks Payment method Mastercard ending 1111 Manage subscription Cancel',
  'gym membership': 'Membership Black Card Member ID 88213 Monthly dues $24.99 Annual fee $49 Home club Freeze membership Cancel membership',
  'software plan': 'Plan Creative Cloud All Apps $59.99/mo Billing: annual, paid monthly Invoices Payment method Cancel your plan',
  'phone plan': 'Unlimited Plus 2 lines $130/mo Autopay discount Current balance $130.00 Pay bill Manage plan',
};
for (const [name, text] of Object.entries(ok)) check(`keep page: ${name}`, financialPageReason(text) == null, financialPageReason(text) || '');

console.log('\nModel categories');
for (const c of ['Banking', 'Credit card', 'Personal finance', 'Investing', 'Crypto exchange', 'Health insurance', 'Government', 'Payroll'])
  check(`category "${c}" caught`, SENSITIVE_CATEGORY_RE.test(c));
for (const c of ['Streaming', 'News', 'Music', 'Software', 'VPN', 'Fitness', 'Cloud storage', 'Dating', 'Gaming', 'Education'])
  check(`category "${c}" kept`, !SENSITIVE_CATEGORY_RE.test(c));

// The backend refuses on its own too, as a backstop for any client that doesn't check (mock brain: no API spend).
console.log('\nBackend backstop');
process.env.WALKAWAY_BRAIN = 'mock'; process.env.WALKAWAY_RATE_LIMIT = '0';
const call = async (name, body) => (await (await import(`../netlify/functions/${name}.mjs`)).default(new Request(`http://local/api/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), {})).json();
const disc = await call('discover', { domains: ['chase.com', 'irs.gov', 'hulu.com'] });
const v = Object.fromEntries(disc.services.map((x) => [x.domain, x]));
check('discover answers every name it was sent', ['chase.com', 'irs.gov', 'hulu.com'].every((d) => v[d]), Object.keys(v).join(', '));
check('discover: chase.com withheld, never a subscription', v['chase.com']?.isSubscription === false && /withheld/.test(v['chase.com']?.category), v['chase.com']?.category);
check('discover: irs.gov withheld', v['irs.gov']?.isSubscription === false && /withheld/.test(v['irs.gov']?.category), v['irs.gov']?.category);
const bankSnap = { url: 'https://secure.chase.com/web/auth/dashboard', title: 'Accounts', text: pages['bank dashboard'], elements: [{ id: 0, tag: 'button', text: 'Cancel payment' }] };
const st1 = await call('agent-step', { merchant: { domain: 'chase.com', name: 'Chase' }, goal: 'find', step: 0, history: [], snapshot: bankSnap });
check('agent-step on a bank domain: back out, model never asked', st1.decision?.action?.type === 'back_out' && /none/.test(st1.model), `${st1.decision?.action?.type} · ${st1.model}`);
const st2 = await call('agent-step', { merchant: { domain: 'hulu.com', name: 'Hulu' }, goal: 'find', step: 3, history: [], snapshot: { ...bankSnap, url: 'https://www.paypal.com/myaccount/autopay' } });
check('agent-step when a walk lands on PayPal: back out', st2.decision?.action?.type === 'back_out', st2.decision?.reasoning);
const st3 = await call('agent-step', { merchant: { domain: 'hulu.com', name: 'Hulu' }, goal: 'find', step: 3, history: [], snapshot: { ...bankSnap, url: 'https://www.hulu.com/account' } });
check('agent-step on a subscription site whose page reads like a bank: back out', st3.decision?.action?.type === 'back_out', st3.decision?.reasoning);
const st4 = await call('agent-step', { merchant: { domain: 'hulu.com', name: 'Hulu' }, goal: 'find', step: 0, history: [], snapshot: { url: 'https://www.hulu.com/account', title: 'Account', text: ok['streaming billing'], elements: [{ id: 0, tag: 'button', text: 'Cancel subscription' }] } });
check('agent-step on a normal subscription page: not refused', st4.decision?.action?.type !== 'back_out' || !/sensitive/.test(st4.decision?.action?.reason || ''), `${st4.decision?.action?.type}`);
const cl = await call('classify', { domain: 'chase.com', snapshot: bankSnap });
check('classify on a bank: refused, reported not signed in', cl.sensitive && cl.result?.signedIn === false, cl.sensitive);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

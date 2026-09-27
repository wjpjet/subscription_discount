// Unit test for the scrubbers (shared/scrub.js): what leaves the browser for the model, and what lands in a test log.
// Both directions matter: secrets and personal data must go, and what the classifier needs (prices, dates, promo codes,
// plan names, emails in the model payload, ordinary links) must stay. All values below are made up.
//   npm run test:scrub
import { scrubSecrets, scrubPii, maskEmail, maskEmails, scrubUrl, sanitizeSnapshot, sanitizeApiBody, redactForLog, secretKinds, JWT_RE, KEYED_SECRET_RE, LONG_DIGITS_RE } from '../shared/scrub.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + String(info).replace(/\n/g, '⏎') : ''}`); ok ? pass++ : fail++; };
const gone = (name, out, ...secrets) => { const left = secrets.filter((s) => out.includes(s)); check(name, !left.length, left.length ? `still has ${left.join(', ')} in: ${out}` : out); };
const same = (name, out, input) => check(name, out === input, out === input ? '' : `changed to: ${out}`);
const model = (s) => scrubPii(scrubSecrets(s));

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1XzEyMyIsImV4cCI6MTg5MzQ1NjAwMH0.c2lnbmF0dXJlX3Rlc3Rfb25seV9ub3RfcmVhbA';
const SES = 'ses_Fake0123456789abcdefXYZ';

console.log('Secrets (scrubSecrets)');
gone('JWT in text', scrubSecrets(`auth ${JWT} done`), JWT, 'eyJ');
gone('JWT glued to an escape (\\x22eyJ…)', scrubSecrets(`\\x22${JWT}\\x22`), JWT);
{ const o = scrubSecrets(`{"session":{"sessionToken":"${SES}","expires":"2027-09-18"}}`);
  gone('"sessionToken":"…" value', o, SES); check('  key kept, value [redacted]', o.includes('"sessionToken":"[redacted]"'), o); check('  expiry date kept', o.includes('2027-09-18')); }
gone('JSON-escaped key (\\"csiToken\\":\\"…\\")', scrubSecrets(`{\\"csiToken\\":\\"AbC123dEf456GhI789\\"}`), 'AbC123dEf456GhI789');
gone('JS-escaped key (\\x22isomorphicSessionId\\x22:\\x22…)', scrubSecrets('\\x22isomorphicSessionId\\x22:\\x22q9w8e7r6t5y4u3\\x22'), 'q9w8e7r6t5y4u3');
{ const o = scrubSecrets('csrf=Zx81aQ92Lk3mPp&page=2'); gone('csrf=… (bare value)', o, 'Zx81aQ92Lk3mPp'); check('  csrf key kept, next param kept', o === 'csrf=[redacted]&page=2', o); }
gone('scnt: … (Apple-style)', scrubSecrets('scnt: AbCdEf1234567890abcdef'), 'AbCdEf1234567890abcdef');
gone('"postkey" / "nonce" / "challenge"', scrubSecrets('"postkey":"pk_12345678ab" "nonce":"n0nce-value-9" "challenge":"Q2hhbGxlbmdlMTIz"'), 'pk_12345678ab', 'n0nce-value-9', 'Q2hhbGxlbmdlMTIz');
gone('"ceid" and an api key', scrubSecrets('"ceid":"c0ffee1234567890" api_key=live_abcdef123456'), 'c0ffee1234567890', 'live_abcdef123456');
gone('Authorization: Bearer …', scrubSecrets('Authorization: Bearer abcDEF123456ghiJKL'), 'abcDEF123456ghiJKL');
gone('32-char hex run', scrubSecrets('id 0123456789abcdef0123456789abcdef end'), '0123456789abcdef0123456789abcdef');
gone('40+ char base64 blob', scrubSecrets('blob QWxhZGRpbjpvcGVuIHNlc2FtZQ0123456789aBcDeFgHiJ+/== end'), 'QWxhZGRpbjpvcGVuIHNlc2FtZQ0123456789aBcDeFgHiJ');
gone('21-digit run', scrubSecrets('account 123456789012345678901 end'), '123456789012345678901', '1234567890');
gone('23-digit id glued to x22 (no word boundary)', scrubSecrets('datasyncId\\x2212345678901234567890123\\x22'), '12345678901234567890123', '345678901234');
gone('16-digit card with spaces', scrubSecrets('Card 4242 4242 4242 4242 on file'), '4242 4242 4242 4242', '4242 4242');
gone('16-digit card with dashes', scrubSecrets('5555-5555-5555-4444'), '5555-5555-5555', '4444');
gone('SSN', scrubSecrets('SSN 123-45-6789'), '123-45-6789');
check('already-redacted text is stable (idempotent)', scrubSecrets(scrubSecrets(`"token":"${SES}" csrf=Zx81aQ92Lk3mPp`)) === scrubSecrets(`"token":"${SES}" csrf=Zx81aQ92Lk3mPp`));

console.log('\nWhat the classifier needs stays (scrubSecrets + scrubPii)');
const billing = 'Premium $22.99/month · Next billing date October 17, 2026 · Renews 2026-10-17 · Member since 2019 · 4 screens at a time · Save 20% — 3 months for $9.99 · $1,299.99/year · Usage: 1,234,567 tokens · 50000 credits left · Call 1-800-555-0100';
same('ordinary billing text unchanged', model(billing), billing);
same('two ISO dates in a row are not a long number', model('Period 2026-09-27 2026-10-27'), 'Period 2026-09-27 2026-10-27');
same('promoCode: SAVE20 unchanged', model('promoCode: SAVE20 · promo code SAVE20OFF · Promo code: WELCOME2026'), 'promoCode: SAVE20 · promo code SAVE20OFF · Promo code: WELCOME2026');
same('prose with author/inside/state/code unchanged', model('author: Christopher · inside: everything · Subscription state: ACTIVE · Postal code required'), 'author: Christopher · inside: everything · Subscription state: ACTIVE · Postal code required');
same('prose after a secret-ish key unchanged (no digits = not a token)', model('OAuth: Connected · Authentication: Disabled · Password: ********'), 'OAuth: Connected · Authentication: Disabled · Password: ********');
same('a long slug and a long path unchanged', model('how-to-cancel-your-2024-subscription-plan-today /account/membership/subscriptions?tab=billing'), 'how-to-cancel-your-2024-subscription-plan-today /account/membership/subscriptions?tab=billing');
same('trial ending date unchanged', model('Your trial ending 2026-10-17 · Offer ends in 2026'), 'Your trial ending 2026-10-17 · Offer ends in 2026');
same('an offer expiry date (MM/DD/YYYY) unchanged', model('Your offer expires 04/27/2026'), 'Your offer expires 04/27/2026');
same('emails kept for the model', model('Signed in as you@example.com'), 'Signed in as you@example.com');

console.log('\nPersonal data (scrubPii)');
{ const o = scrubPii('Visa ending 4242'); check('Visa ending 4242 → [card]', o === 'Visa [card]', o); }
{ const o = scrubPii('Visa ending in 4242, exp 04/27'); gone('card tail + exp 04/27', o, '4242', '04/27'); check('  markers present', o.includes('[card]') && o.includes('[exp]'), o); }
gone('expires 04/2027', scrubPii('Mastercard ending in 4444 expires 04/2027'), '4444', '04/2027');
gone('masked card •••• 1234 and 12/27 after it', scrubPii('Mastercard •••• 1234 12/27'), '1234', '12/27');
gone('line-based text: card on one line, "expires 05/28" on the next', scrubPii('Payment\n**** 4321\nexpires 05/28\nEdit'), '4321', '05/28');
gone('line-based address: street, unit, city/state/ZIP on separate lines', scrubPii('Jane Doe\n42 Elm Street\nApt 7\nSpringfield IL 62704\n'), '42 Elm', 'Apt 7', '62704');
gone('Netflix-style •• •••• •••• 1234', scrubPii('•• •••• •••• 1234'), '1234');
gone('**** 9876 and XXXX-XXXX-XXXX-5555', scrubPii('**** 9876 · XXXX-XXXX-XXXX-5555'), '9876', '5555');
gone('Visa ...4321 / card #8765', scrubPii('Visa ...4321 · card #8765'), '4321', '8765');
{ const o = scrubPii('Billing address 123 Main Street Apt 4B, Springfield, IL 62704');
  gone('street address + city/state/ZIP', o, '123 Main', 'Main Street', 'Apt 4B', 'Springfield', '62704'); check('  → [address]', o === 'Billing address [address]', o); }
gone('address with direction + ZIP+4', scrubPii('1600 Pennsylvania Avenue NW, Washington, DC 20500-0003'), 'Pennsylvania', '20500');
gone('ZIP after a state code', scrubPii('Springfield, IL 62704'), '62704');
gone('ZIP after a label', scrubPii('ZIP code: 90210 · Postal code 10001'), '90210', '10001');
gone('birthdate keys (JSON, escaped JSON, param)', scrubPii('"birthDate":"1990-01-02" \\"dob\\":\\"1985-05-06\\" date_of_birth=1970-07-08'), '1990-01-02', '1985-05-06', '1970-07-08');
gone('birthdate in prose', scrubPii('Date of birth: March 3, 1990 · Birthday 04/05/1991'), 'March 3', '1990', '04/05/1991');
same('emails untouched by scrubPii', scrubPii('you@example.com'), 'you@example.com');

console.log('\nAddresses in capitals, more suffixes, lowercase after a cue (scrubPii)');
{ const o = model('123 MAIN ST, SPRINGFIELD, IL 62704'); check('all-caps USPS address → [address]', o === '[address]', o); }
gone('all-caps address on lines (street, unit, city)', model('Billing address\nJOHN DOE\n4521 OAK RIDGE DR APT 4\nAUSTIN TX 78701'), '4521', 'OAK RIDGE', 'APT 4', 'AUSTIN', '78701');
gone('all-caps address in the test log too', redactForLog('Delivering to 77 PINE AVE, DENVER, CO 80203'), '77 PINE', 'DENVER', '80203');
gone('"Loop" suffix + city/state/ZIP', model('88 Cedar Loop, Austin, TX 78701'), 'Cedar Loop', '78701');
gone('"Cove" suffix + city/state/ZIP', model('12 Heron Cove, Austin, TX 78701'), 'Heron Cove', '78701');
gone('"Ridge" suffix on its own line, city below', model('Ship to\n9 Maple Ridge\nBoulder, CO 80301'), 'Maple Ridge', '80301');
{ const o = model('ship to 123 main street'); check('lowercase after "ship to" → [address], cue kept', o === 'ship to [address]', o); }
gone('lowercase after "Delivering to", with unit and city/state/ZIP', model('Delivering to 55 elm st apt 2, austin, tx 78701 on Tue'), '55 elm', 'apt 2', 'austin', '78701');
gone('lowercase after "Address:"', model('Address: 7 oak lane'), '7 oak');
same('"2 TB drive" unchanged', model('Google One 2 TB drive · 2 TB Drive storage'), 'Google One 2 TB drive · 2 TB Drive storage');
same('plan and title names with suffix words unchanged', model('1 Xbox Game Pass Ultimate membership · 3 Month Pass · 2026 Season Pass · Top 10 Jurassic Park moments · Annual Pass'), '1 Xbox Game Pass Ultimate membership · 3 Month Pass · 2026 Season Pass · Top 10 Jurassic Park moments · Annual Pass');
same('all-caps offer banner unchanged', model('GET 3 MONTHS FOR $1 · UP TO 4 SCREENS · 1 YEAR PLAN · SAVE 50% TODAY'), 'GET 3 MONTHS FOR $1 · UP TO 4 SCREENS · 1 YEAR PLAN · SAVE 50% TODAY');
same('lowercase numbers + words without a cue unchanged', model('we deliver 2 boxes a week · 4 main dishes · 12 way cheaper plans'), 'we deliver 2 boxes a week · 4 main dishes · 12 way cheaper plans');
same('a cue without a street unchanged', model('Delivering to 2 people · Ship to 3 addresses'), 'Delivering to 2 people · Ship to 3 addresses');

console.log('\nCard last-4 and expiry formats (scrubPii)');
for (const s of ['Visa 4242', 'VISA 4242', 'Mastercard 4242', 'Visa •4242', 'Visa *4242', 'Apple Pay · Visa 4242', 'Visa (4242)', 'Visa: 4242', 'Card: Mastercard (last four: 4242)', 'Visa, last 4 digits 4242', 'Payment method: Visa 4242 · Edit', 'Visa Debit 4242', 'card •4242'])
  gone(`last-4: ${s}`, model(s), '4242');
{ const o = model('Visa 4242'); check('  brand kept, digits → [card]', o === 'Visa [card]', o); }
gone('"Exp. date: 04/27" after a card', model('Visa ending 4242 · Exp. date: 04/27'), '04/27');
gone('"Exp date 04/27" on its own (abbreviation is card-only)', model('Exp date 04/27'), '04/27');
gone('"Valid thru 04/27" after a card', model('Visa ending 4242 · Valid thru 04/27'), '04/27');
{ const o = model('Mastercard ending in 4444 · expires April 2027'); gone('"expires April 2027" after a card', o, 'April 2027', '4444'); check('  label kept', o.includes('expires [exp]'), o); }
gone('"Expires Apr 2027" on the line under a masked card', model('**** 4321\nExpires Apr 2027'), 'Apr 2027', '4321');
gone('"exp 04-2027" (dash)', model('exp 04-2027'), '04-2027');
gone('"expires 04-27" after a card (dash)', model('Visa x-4242 expires 04-27'), '04-27', '4242');
same('"Discover 1000 titles" unchanged', model('Discover 1000 titles · Discover · 2026 picks'), 'Discover 1000 titles · Discover · 2026 picks');
same('"Visa 2026 rewards" unchanged (a year is not a last-4)', model('Visa 2026 rewards · Mastercard 2025 offer · Card · 2026 plans'), 'Visa 2026 rewards · Mastercard 2025 offer · Card · 2026 plans');
same('plan expiry month-name date unchanged away from a card', model('Your plan expires April 2027 · Offer expires Jan 2027'), 'Your plan expires April 2027 · Offer expires Jan 2027');
same('offer deadlines ("valid until/through") unchanged away from a card', model('Offer valid until 12/31 · Offer valid through 12/2026 · valid thru 10/17'), 'Offer valid until 12/31 · Offer valid through 12/2026 · valid thru 10/17');
same('dash dates unchanged', model('Renews 10-17-2026 · expires 2026-10-17 · Your offer expires 04/27/2026'), 'Renews 10-17-2026 · expires 2026-10-17 · Your offer expires 04/27/2026');
same('prices next to a brand unchanged', model('Visa $17.99/month · Pay with Mastercard: $1,299.99/year'), 'Visa $17.99/month · Pay with Mastercard: $1,299.99/year');

console.log('\nEmails');
check('maskEmail keeps 2 chars of the local part', maskEmail('jane@example.com') === 'ja***@example.com', maskEmail('jane@example.com'));
check('maskEmail on a short local part reveals less', maskEmail('ab@example.com') === 'a***@example.com', maskEmail('ab@example.com'));
check('maskEmail is idempotent', maskEmail(maskEmail('ab@example.com')) === maskEmail('ab@example.com') && maskEmail('ja***@example.com') === 'ja***@example.com');
check('maskEmail never echoes a non-address in full', maskEmail('Jonathan') === 'Jo***' && maskEmail('') === '' && maskEmail(null) === '', maskEmail('Jonathan'));
{ const o = maskEmails('Signed in as you.person@example.com, backup a@b.co, link ?e=me%40example.org'); gone('maskEmails masks every address (also %40)', o, 'you.person@', 'a@b.co', 'me%40'); }

console.log('\nURLs (scrubUrl)');
{ const u = scrubUrl('https://shop.example.com/identity/signin?token=AbC123dEf456GhI789jKl012&page=2');
  check('?token=…&page=2 → token=x, page kept', u === 'https://shop.example.com/identity/signin?token=x&page=2', u); }
{ const u = scrubUrl(`https://app.example.com/reset/${JWT}/`); check('/reset/eyJ…/ path segment → [token]', u === 'https://app.example.com/reset/[token]/', u); }
same('a normal account URL unchanged', scrubUrl('https://www.example.com/account/membership/subscriptions?tab=billing#plan'), 'https://www.example.com/account/membership/subscriptions?tab=billing#plan');
{ const u = scrubUrl('https://login.example.com/oauth2/authorize?client_id=web&state=Xy12Ab34&nonce=n1&redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb%3Fcode%3Dabc12345');
  gone('OAuth state/nonce and a code inside the return URL', u, 'Xy12Ab34', 'abc12345'); check('  client_id and host kept', u.includes('client_id=web') && u.startsWith('https://login.example.com/oauth2/authorize?'), u); }
gone('fragment tokens (#access_token=…)', scrubUrl('https://app.example.com/cb#access_token=tok123abc456&expires_in=3600'), 'tok123abc456');
gone('token-like value under an innocent name', scrubUrl('https://example.com/p?aymh=Zm9vYmFyMTIzNDU2Nzg5MGFiY2Rl'), 'Zm9vYmFyMTIzNDU2Nzg5MGFiY2Rl');
gone('user:pass@ dropped', scrubUrl('https://user:hunter22@example.com/p'), 'hunter22', 'user:');
{ const u = scrubUrl('/account?sid=abcdef&keyword=netflix&promo_code=SAVE20'); check('relative URL: sid=x, keyword and promo_code kept', u === '/account?sid=x&keyword=netflix&promo_code=SAVE20', u); }
{ const once = scrubUrl(`https://Example.com/reset/${JWT}/?state=Xy12Ab34&tab=2`); same('scrubUrl is idempotent (a scrubbed URL comes back byte-for-byte)', scrubUrl(once), once); }
same('mailto: unchanged', scrubUrl('mailto:help@example.com'), 'mailto:help@example.com');
same('garbage unchanged', scrubUrl('not a url at all'), 'not a url at all');
check('non-strings pass through', scrubUrl(null) === null && scrubUrl(undefined) === undefined && scrubUrl('') === '');

console.log('\nSnapshots (sanitizeSnapshot)');
const snap = {
  url: 'https://www.example.com/account?session_id=AbC123dEf456GhI789jKl012&tab=billing', title: 'Account — you@example.com', headings: ['Your plan', `Token ${JWT}`],
  text: `Premium $17.99/month · Visa ending 4242 exp 04/27 · 123 Main Street, Springfield, IL 62704 · {"sessionToken":"${SES}"} · you@example.com`,
  textLength: 999, hasPassword: true, gen: 'g1',
  prices: [{ amount: 17.99, currency: 'USD', unit: 'month', context: 'Premium $17.99/month Visa ending 4242' }],
  elements: [
    { id: 0, tag: 'a', text: 'Billing', href: `https://www.example.com/billing?token=${SES}&tab=2` },
    { id: 1, tag: 'input', type: 'password', name: 'pw', value: 'hunter2hunter2' },
    { id: 2, tag: 'input', type: 'text', name: 'cardnumber', label: 'Card number', value: '4242 4242 4242 4242' },
    { id: 3, tag: 'input', type: 'text', name: 'q', placeholder: 'Search', value: 'netflix plans' },
    { id: 4, tag: 'input', type: 'hidden', name: 'authenticity_token', value: 'aGlkZGVuLXRva2Vu' },
    { id: 5, tag: 'select', text: 'Visa ending 4242', options: ['Visa ending 4242', 'Add a card'] },
  ],
  identity: { emails: [{ value: 'you@example.com', source: 'account-menu' }], hints: [{ source: 'account-menu', text: 'Account · Mastercard ending 5555' }] },
  frames: [{ host: 'js.stripe.com', w: 400, h: 200 }],
};
const before = JSON.stringify(snap);
const out = sanitizeSnapshot(snap);
check('input snapshot is not mutated', JSON.stringify(snap) === before);
check('returns a new object (and new element objects)', out !== snap && out.elements !== snap.elements && out.elements[0] !== snap.elements[0]);
gone('url session_id → x, tab kept', out.url, 'AbC123dEf456GhI789jKl012'); check('  tab=billing kept', out.url.includes('tab=billing'), out.url);
gone('text: card, exp, address, token out', out.text, '4242', '04/27', '123 Main', '62704', SES);
check('text: price and email kept for the classifier', out.text.includes('$17.99/month') && out.text.includes('you@example.com'), out.text);
gone('heading JWT out', out.headings.join(' '), JWT);
gone('href token out', out.elements[0].href, SES);
check('password value dropped', !('value' in out.elements[1]));
check('card-number value dropped', !('value' in out.elements[2]));
check('hidden input value dropped', !('value' in out.elements[4]));
check('ordinary input value kept', out.elements[3].value === 'netflix plans');
gone('select text/options scrubbed', out.elements[5].text + ' ' + out.elements[5].options.join(' '), '4242');
gone('price context scrubbed', out.prices[0].context, '4242'); check('  price amount kept', out.prices[0].amount === 17.99 && out.prices[0].unit === 'month');
gone('identity hint scrubbed', out.identity.hints[0].text, '5555'); check('  identity emails kept', out.identity.emails[0].value === 'you@example.com');
check('other fields carried over', out.gen === 'g1' && out.textLength === 999 && out.hasPassword === true && out.frames[0].host === 'js.stripe.com');
check('null snapshot passes through', sanitizeSnapshot(null) === null);

console.log('\nPrice contexts: scrubbed wide, then trimmed (sanitizeSnapshot)');
{ // The page cuts ~120 chars before the price from raw text; a cut through "Visa ending in 4242" must not leak the digits.
  const FILL = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ';
  const leaks = [], short = [];
  for (let k = 0; k <= 110; k++) {
    const text = 'Visa ending in 4242 · Default · ' + FILL.slice(0, k) + ' Premium $17.99/month · Cancel anytime · Next billing Oct 17, 2026';
    const at = text.indexOf('$17.99'), ctx = text.slice(Math.max(0, at - 120), at + 6 + 45);
    const c = sanitizeSnapshot({ prices: [{ amount: 17.99, currency: 'USD', unit: 'month', context: ctx }] }).prices[0].context;
    if (c.includes('4242')) leaks.push(k + ': ' + c);
    if (!c.includes('Premium $17.99/month') || c.indexOf('$17.99') > 72 || /^\s/.test(c)) short.push(k + ': ' + c);
  }
  check('no cut of "Visa ending in 4242" leaks the digits (111 offsets)', !leaks.length, leaks[0]);
  check('  price, unit and nearby words kept; head ≤ ~70 chars, starting on a word', !short.length, short[0]);
}
{ const ctx = 'ng in 4242 · Default · added Mar 3, 2026 · billing contact Jo · lorem ipsum dolor sit amet consect Premium $17.99/month · Cancel';
  const c = sanitizeSnapshot({ prices: [{ amount: 17.99, context: ctx }] }).prices[0].context;
  gone('a context already cut mid-phrase ("ng in 4242 …") loses the far head', c, '4242'); check('  starts on a whole word', /^[A-Za-z·]/.test(c) && ctx.includes(c.split(' ')[0]), c); }
{ const ctx = 'x'.repeat(40) + ' Visa ending in 4242 · Default · added Mar 3, 2026 · billing contact Jo · lorem ipsum dolor sit Plan $1,299.99/year billed yearly';
  const c = sanitizeSnapshot({ prices: [{ amount: 1299.99, context: ctx }] }).prices[0].context;
  check('thousands separator: price found, head trimmed', c.includes('$1,299.99/year') && c.indexOf('$1,299.99') <= 72 && !c.includes('xxx'), c); }
{ const ctx = 'Save $9.99 today, then Visa ending in 4242 renews at $9.99/month for the Premium plan with 4 screens and more';
  const c = sanitizeSnapshot({ prices: [{ amount: 9.99, context: ctx }] }).prices[0].context;
  check('the same amount twice: short context kept whole, scrubbed', c.includes('Save $9.99') && c.includes('[card]') && !c.includes('4242'), c); }
{ const ctx = 'ng in 4242 · ' + 'lorem ipsum dolor sit amet '.repeat(8) + 'Premium EUR 17,99 per month';
  const c = sanitizeSnapshot({ prices: [{ amount: 17.99, context: ctx }] }).prices[0].context;
  check('comma decimals: price found, far head dropped', c.includes('17,99 per month') && !c.includes('4242'), c); }
{ const ctx = 'ng in 4242 · ' + 'lorem ipsum dolor sit amet '.repeat(8) + 'Premium plan';
  const c = sanitizeSnapshot({ prices: [{ amount: 17.99, context: ctx }] }).prices[0].context;
  check('price not found: a context-sized tail is kept, far head dropped', c.length <= 130 && c.endsWith('Premium plan') && !c.includes('4242'), c); }
{ const s1 = sanitizeSnapshot({ prices: [{ amount: 17.99, context: 'x '.repeat(60) + 'Premium $17.99/month' }] }), s2 = sanitizeSnapshot(s1);
  check('price context trim is idempotent', s2.prices[0].context === s1.prices[0].context && s1.prices[0].context.endsWith('Premium $17.99/month'), s1.prices[0].context); }
check('price entries without a context or amount pass through', JSON.stringify(sanitizeSnapshot({ prices: [{ amount: 5 }, null, { context: 'Premium plan' }] }).prices) === JSON.stringify([{ amount: 5 }, null, { context: 'Premium plan' }]));

console.log('\nAPI request bodies (sanitizeApiBody)');
{ const SID = 'AbC123dEf456GhI789jKl012';
  const body = {
    runId: 'r1', goal: 'find', step: 2, merchant: { domain: 'example.com' },
    snapshot: { url: `https://www.example.com/cancel?session_id=${SID}`, text: 'Visa ending 4242 · Premium $17.99/month', elements: [] },
    readiness: { url: `https://www.example.com/account?token=${SES}`, readyState: 'complete', busy: false, dialog: 'Payment method Visa ending in 4242 updated' },
    history: [
      { step: 0, url: `https://www.example.com/cancel?session_id=${SID}`, state: 'cancel_entry', action: { type: 'click', id: 3 }, target: 'Premium · Visa ending in 4242 · exp 04/27', note: 'clicked "Premium · Visa ending in 4242 · exp 04/27"', ok: true, ts: 1 },
      { step: 1, url: 'https://www.example.com/cancel/survey', state: 'reason_survey', action: { type: 'select', id: 5 }, target: 'Ship to 42 Elm Street, Springfield, IL 62704', note: `selected token=${JWT}`, ok: true, ts: 2 },
      null,
    ],
    priorPath: ['cancel_entry: click "Premium · Visa ending in 4242" @ https://www.example.com/cancel', 'reason_survey: select "Too expensive" @ https://www.example.com/cancel/survey'],
  };
  const before = JSON.stringify(body), o = sanitizeApiBody(body);
  check('input body is not mutated', JSON.stringify(body) === before);
  check('returns a copy (and copies of history steps and readiness)', o !== body && o.history !== body.history && o.history[0] !== body.history[0] && o.readiness !== body.readiness);
  gone('snapshot sanitized', o.snapshot.url + ' ' + o.snapshot.text, SID, '4242'); check('  snapshot price kept', o.snapshot.text.includes('$17.99/month'), o.snapshot.text);
  gone('readiness.dialog: card tail out', o.readiness.dialog, '4242'); check('  dialog text kept', o.readiness.dialog === 'Payment method Visa [card] updated', o.readiness.dialog);
  gone('readiness.url: token → x', o.readiness.url, SES); check('  other readiness fields kept', o.readiness.readyState === 'complete' && o.readiness.busy === false, JSON.stringify(o.readiness));
  gone('history target/note: card tail and expiry out', o.history[0].target + ' ' + o.history[0].note, '4242', '04/27'); check('  label words kept', o.history[0].target.startsWith('Premium · Visa [card]') && o.history[0].note.startsWith('clicked "Premium'), o.history[0].target);
  gone('history url: session id → x', o.history[0].url, SID);
  gone('history target address and note token out', o.history[1].target + ' ' + o.history[1].note, '42 Elm', '62704', JWT);
  check('  history state/action/ok/ts carried over; non-object steps pass through', o.history[0].state === 'cancel_entry' && o.history[0].action.type === 'click' && o.history[0].action.id === 3 && o.history[0].ok === true && o.history[0].ts === 1 && o.history[2] === null);
  gone('priorPath lines scrubbed', o.priorPath.join(' '), '4242'); check('  priorPath route kept', o.priorPath[1] === body.priorPath[1] && o.priorPath[0].includes('cancel_entry: click "Premium'), o.priorPath[0]);
  check('other fields carried over', o.runId === 'r1' && o.goal === 'find' && o.step === 2 && o.merchant === body.merchant);
  check('sanitizing twice changes nothing more', JSON.stringify(sanitizeApiBody(o)) === JSON.stringify(o)); }
{ const b = { estimatedSavingsUsd: 12.5, sessionId: 'cs_test_1' }; check('bodies without page data sent as they are', JSON.stringify(sanitizeApiBody(b)) === JSON.stringify(b)); }
{ const r = sanitizeApiBody({ domain: 'example.com', readiness: { url: 'https://example.com/', busy: true } }).readiness; check('readiness without a dialog gets none added', !('dialog' in r) && r.url === 'https://example.com/', JSON.stringify(r)); }
check('non-object bodies pass through', sanitizeApiBody(null) === null && sanitizeApiBody(undefined) === undefined && sanitizeApiBody('x') === 'x' && Array.isArray(sanitizeApiBody([1])));

console.log('\nTest log (redactForLog)');
{ const o = redactForLog(snap.text + ' ' + snap.url + ' ' + snap.headings.join(' '));
  gone('everything sensitive out, emails masked', o, 'you@example.com', '4242', '04/27', '123 Main', SES, JWT);
  check('  masked email present', o.includes('y***@example.com'), o);
  check('  no secret patterns left', secretKinds(o).length === 0, secretKinds(o).join(',')); }
check('secretKinds names what it finds', ['jwt', 'keyed', 'digits'].every((k) => secretKinds(`${JWT} "csrfToken":"${SES}" 123456789012345`).includes(k)), secretKinds(`${JWT} "csrfToken":"${SES}" 123456789012345`).join(','));
check('exported detectors are non-global (safe to .test repeatedly)', !JWT_RE.global && !KEYED_SECRET_RE.global && !LONG_DIGITS_RE.global && JWT_RE.test(JWT) && JWT_RE.test(JWT));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

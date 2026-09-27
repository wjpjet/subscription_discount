// Unit test for the never-touch rules (shared/sensitive.js) and the other deterministic site and account rules
// (shared/domains.js, shared/accounts.js, shared/services.js), plus the server's own backstops (brain.mjs prompt
// scrubbing, guardPageClass's details-link filter) and review-log's page reading. Both directions matter: every
// financial, government or health site must be caught, and ordinary subscriptions must not be.
//   npm run test:sensitive
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sensitiveReason, financialPageReason, SENSITIVE_CATEGORY_RE } from '../shared/sensitive.js';
import { etld1, isInfra, hostMatches, AUTH_COOKIE_RE } from '../shared/domains.js';
import { isConsumerEmail, isWorkEmail, orgAccountReason, isIdpHost, isLoginUrl, hasSignInControl } from '../shared/accounts.js';
import { CATALOG, catalogFor, canonicalKey } from '../shared/services.js';
import { guardPageClass } from '../shared/brain-mock.js';

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); ok ? pass++ : fail++; };

console.log('Domains that must be skipped');
for (const d of ['chase.com', 'secure.chase.com', 'wellsfargo.com', 'connect.secure.wellsfargo.com', 'bankofamerica.com', 'capitalone.com', 'americanexpress.com',
  'navyfederal.org', 'schwab.com', 'fidelity.com', 'robinhood.com', 'coinbase.com', 'gemini.com', 'paypal.com', 'venmo.com', 'cash.app', 'experian.com',
  'irs.gov', 'www.ssa.gov', 'studentaid.gov', 'hmrc.gov.uk', 'army.mil', 'stanford.edu', 'first.bank', 'geico.com', 'kaiserpermanente.org', 'adp.com',
  'mysmallbank.com', 'firsttechfcu.com', 'hometownmortgage.com', 'redwoodcreditunion.org',
  // missed by the first live run (their names reached the model): HSA, patient portal, equity plans, a "banco", bank wallet, card networks
  'healthequity.com', 'my.healthequity.com', 'athenahealth.com', 'morganstanleyclientserv.com', 'solium.com', 'shareworks.com', 'bancoplata.mx',
  'paze.com', 'visa.com', 'mastercard.com',
  // identity and fraud-check vendors seen in the same run
  'socure.io', 'online-metrix.net', 'h.online-metrix.net', 'cardinaltrusted.com', 'riskid.security', 'signifyd.com', 'nsureapi.com', 'transmitsecurity.io', 'kaptcha.com',
  // brand prefixes: sister sites the list doesn't name
  'wellsfargoadvisors.com', 'morganstanleyatwork.com', 'fidelityinvestments.com', 'schwabplan.com', 'unitedhealthgroup.com', 'kaiserpermanentejobs.org',
  // non-English bank words, narrow care-provider stems, country government forms, single hosts
  'www.bancolombia.com.co', 'sparkasse-koeln.de', 'raiffeisen.ch', 'banque-example.fr', 'mayoclinic.org', 'cityhospital.org', 'mypatientportal.com',
  'x.gov.co', 'sat.gob.mx', 'impots.gouv.fr', 'wallet.google.com',
  // telehealth and online prescribers: no NAME_RE stem reaches them, so their names went to discovery (R22)
  'teladoc.com', 'teladochealth.com', 'amwell.com', 'mdlive.com', 'doctorondemand.com', 'plushcare.com', 'sesamecare.com', 'khealth.com', 'lemonaidhealth.com',
  'onemedical.com', 'carbonhealth.com', 'hims.com', 'forhims.com', 'www.forhims.com', 'hers.com', 'forhers.com', 'ro.co', 'www.ro.co', 'getroman.com', 'keeps.com',
  'thirtymadison.com', 'henrymeds.com', 'joinfound.com', 'joincalibrate.com',
  // DTC and mail-order pharmacies, drug-price cards; Amazon's pharmacy host (amazon.com itself stays below)
  'goodrx.com', 'capsule.com', 'alto.com', 'costplusdrugs.com', 'blinkhealth.com', 'honeybeehealth.com', 'pillpack.com', 'optumrx.com', 'express-scripts.com',
  'caremark.com', 'riteaid.com', 'pharmacy.amazon.com',
  // mental health care
  'betterhelp.com', 'talkspace.com', 'cerebral.com', 'brightside.com', 'lyrahealth.com', 'springhealth.com', 'regain.us', 'talkiatry.com', 'headway.co',
  'helloalma.com', 'rula.com', 'donefirst.com',
  // reproductive and sexual health, fertility
  'plannedparenthood.org', 'www.plannedparenthood.org', 'nurx.com', 'thepillclub.com', 'pandiahealth.com', 'hellowisp.com', 'simplehealth.com', 'kindbody.com',
  'progyny.com', 'modernfertility.com',
  // genetic testing and at-home labs
  '23andme.com', 'you.23andme.com', 'nebula.org', 'invitae.com', 'color.com', 'everlywell.com', 'letsgetchecked.com'])
  check(`skip ${d}`, sensitiveReason(d) != null, sensitiveReason(d) || 'NOT CAUGHT');

console.log('\nSubscriptions that must NOT be skipped');
for (const d of ['netflix.com', 'hulu.com', 'spotify.com', 'nytimes.com', 'wsj.com', 'adobe.com', 'dropbox.com', 'google.com', 'one.google.com', 'youtube.com',
  'apple.com', 'amazon.com', 'disneyplus.com', 'max.com', 'peacocktv.com', 'paramountplus.com', 'siriusxm.com', 'audible.com', '1password.com',
  'nordvpn.com', 'expressvpn.com', 'duolingo.com', 'strava.com', 'peloton.com', 'planetfitness.com', 'intuit.com', 'quickbooks.intuit.com',
  'patreon.com', 'substack.com', 'twitch.tv', 'xbox.com', 'playstation.com', 'verizon.com', 'xfinity.com', 'grammarly.com', 'canva.com', 'notion.so',
  'openai.com', 'claude.ai', 'streamly-testbed.netlify.app', 'localhost',
  // real subscriptions a generic prefix or a bare health word would take (K4 all over again)
  'ouraring.com', 'seekingalpha.com', 'discoveryplus.com', 'thefarmersdog.com', 'cursor.com', 'menshealth.com', 'womenshealthmag.com', 'healthifyme.com',
  'hospitalityonline.com', 'clinique.com', 'myfitnesspal.com', 'noom.com', 'headspace.com', 'monarchmoney.com',
  // apps about health or money stay subscriptions: meditation, sleep, rings, research; genealogy (not a DNA lab); Amazon itself
  'calm.com', 'www.calm.com', 'www.headspace.com', 'www.ouraring.com', 'www.seekingalpha.com', 'ancestry.com', 'www.amazon.com',
  // sign-in and account hosts a walk passes through: never-touch here would stop Microsoft 365 or Google One walks
  'login.microsoftonline.com', 'acme.okta.com', 'account.microsoft.com', 'admin.google.com', 'pay.google.com', 'payments.google.com', 'myaccount.google.com'])
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
for (const c of ['Banking', 'Bank', 'Credit card', 'Credit union', 'Brokerage', 'Crypto exchange', 'Payment app', 'Mortgage lender', 'Student loans', 'Health insurance', 'Auto insurance', 'Insurer', 'Hospital', 'Pharmacy', 'Government', 'Tax preparation', 'Payroll',
  // care delivered online (R22): the narrow net put back
  'Telehealth', 'Telemedicine', 'Teletherapy', 'Online therapy', 'Prescription delivery', 'Prescriptions', 'Online pharmacy', "Men's telehealth"])
  check(`category "${c}" caught`, SENSITIVE_CATEGORY_RE.test(c));
// Topics, not institutions: the first live run wrongly dropped Oura ("Fitness/Health") and Seeking Alpha ("Financial News").
// Never bare "mental health": the model files Calm and Headspace there (R22).
for (const c of ['Streaming', 'News', 'Music', 'Software', 'VPN', 'Fitness', 'Cloud storage', 'Dating', 'Gaming', 'Education', 'Fitness/Health', 'Financial News', 'Health & wellness', 'Personal finance app', 'Investing research', 'Budgeting', 'Meditation',
  'Mental health', 'Meditation & mental health', 'Mental health app', 'Sleep & meditation', 'Wearables', 'Prescription eyewear', 'Prescription contact lenses', 'Contact lens subscription'])
  check(`category "${c}" kept`, !SENSITIVE_CATEGORY_RE.test(c));

console.log('\nRegistrable domains (etld1)');
for (const [h, want] of [['shop.foo.com.co', 'foo.com.co'], ['foo.com.co', 'foo.com.co'], ['a.b.co.uk', 'b.co.uk'], ['x.com.br', 'x.com.br'], ['www.smartfit.com.br', 'smartfit.com.br'],
  ['netflix.com', 'netflix.com'], ['www.netflix.com', 'netflix.com'], ['a.b.example.com', 'example.com'], ['rtb.mx', 'rtb.mx'], ['sat.gob.mx', 'sat.gob.mx'],
  ['shop.example.co.id', 'example.co.id'], ['localhost', 'localhost'], ['192.168.1.1', '192.168.1.1'], ['.Example.COM.', 'example.com'],
  // hosting suffixes are public suffixes: every *.netlify.app is its own site, not one pseudo-site "netlify.app"
  ['streamly-testbed.netlify.app', 'streamly-testbed.netlify.app'], ['x.netlify.app', 'x.netlify.app'], ['a.b.vercel.app', 'b.vercel.app'], ['foo.pages.dev', 'foo.pages.dev'],
  ['user.github.io', 'user.github.io'], ['app.herokuapp.com', 'app.herokuapp.com'], ['x.web.app', 'x.web.app'], ['x.firebaseapp.com', 'x.firebaseapp.com'],
  ['api.x.workers.dev', 'x.workers.dev'], ['x.onrender.com', 'x.onrender.com'], ['x.fly.dev', 'x.fly.dev'], ['x.glitch.me', 'x.glitch.me']])
  check(`etld1(${h}) = ${want}`, etld1(h) === want, etld1(h));

console.log('\nhostMatches');
for (const [h, ds, want] of [['www.netflix.com', ['netflix.com'], true], ['netflix.com', ['netflix.com'], true], ['notnetflix.com', ['netflix.com'], false],
  ['cursor.com', ['cursor.sh', 'cursor.com'], true], ['evil-cursor.com', ['cursor.sh', 'cursor.com'], false], ['WWW.Hulu.com', ['hulu.com'], true], ['', ['hulu.com'], false], ['hulu.com', [], false]])
  check(`hostMatches(${h || "''"}, [${ds}]) = ${want}`, hostMatches(h, ds) === want);

console.log('\nInfra (dropped quietly before discovery)');
for (const d of ['tappx.com', 'richaudience.com', 'stackadapt.com', 'pubmatic.com', 'id5-sync.com', 'adroll.com', 'amazon-adsystem.com', 'clarity.ms', 'googleusercontent.com',
  'stripecdn.com', 'rtb.mx', 'bedrockplatform.bid', 'doubleclick.net', 'microsoftonline.com', 'microsoftazuread-sso.com', 'okta.com', '10.0.0.1', 'localhost',
  // hosting hosts stay infra after etld1 learned their suffixes
  'x.netlify.app', 'streamly-testbed.netlify.app', 'x.vercel.app', 'user.github.io'])
  check(`infra ${d}`, isInfra(d));
for (const d of ['netflix.com', 'ouraring.com', 'seekingalpha.com', 'claude.ai', 'cursor.com', 'microsoft.com', 'live.com', 'amazon.com', 'primevideo.com', 'google.com',
  'youtube.com', 'linkedin.com', 'medium.com', 'spotify.com', 'twitch.tv', 'nintendo.com', 'nypost.com'])
  check(`not infra ${d}`, !isInfra(d));

console.log('\nSession-like cookie names');
// __Secure-3PSIDTS: yes, through the SID family (Google's session cookies), not through the __Secure- prefix.
for (const n of ['__Secure-3PSIDTS', '__Secure-3PSID', 'SID', 'SAPISID', 'sessionid', 'PHPSESSID', '_session_id', 'user_id', 'userid', 'uid', 'auth_token', 'logged_in',
  'remember_user_token', '__Secure-next-auth.session-token'])
  check(`auth-like ${n}`, AUTH_COOKIE_RE.test(n));
for (const n of ['_ga', '_gid', 'user_prefs', 'currentUser', '__Secure-YEC', '__Secure-ENID', '_fbp', 'uuid2', 'NID', 'consent'])
  check(`not auth-like ${n}`, !AUTH_COOKIE_RE.test(n));

console.log('\nEmails');
for (const e of ['you@gmail.com', 'you@googlemail.com', 'you@hotmail.co.uk', 'you@yahoo.fr', 'you@outlook.de', 'you@icloud.com', 'you@proton.me', 'you@pm.me', 'you@comcast.net', 'yo***@gmail.com'])
  check(`consumer ${e}`, isConsumerEmail(e) && !isWorkEmail(e));
for (const e of ['you@example-corp.com', 'you@outlook.examplecorp.com', 'you@university.edu'])
  check(`work-like ${e}`, isWorkEmail(e) && !isConsumerEmail(e));
for (const e of ['', 'not-an-email', 'you@', null, undefined])
  check(`not an address: ${JSON.stringify(e)}`, !isWorkEmail(e) && !isConsumerEmail(e));

console.log('\nWork and team accounts');
const el = (texts) => texts.map((text, id) => ({ id, tag: 'a', text }));
const teamPage = { url: 'https://cursor.com/dashboard', title: 'Dashboard', headings: ['Overview'], text: 'Usage Settings Team Settings Members & Groups Invite Teammates Docs',
  elements: el(['Overview', 'Settings', 'Team Settings', 'Members & Groups', 'Invite Teammates', 'Docs']) };
check('Cursor-like team dashboard: work account', /team settings/.test(orgAccountReason(teamPage) || ''), orgAccountReason(teamPage) || 'null');
const netflix = { url: 'https://www.netflix.com/account', title: 'Account', headings: ['Account', 'Membership details'],
  text: 'Membership details Premium plan $24.99/month Next payment: October 10 Manage membership Cancel membership Profiles Security Devices',
  elements: el(['Change plan', 'Manage payment info', 'Cancel membership', 'Manage profiles']), identity: { emails: [{ value: 'you@gmail.com', source: 'account-menu' }], hints: [] } };
check('Netflix account page: not a work account', orgAccountReason(netflix) == null, orgAccountReason(netflix) || '');
const enterpriseOnly = { url: 'https://slack.com/signin', title: 'Sign in', headings: ['Sign in to Slack'], text: 'Product Enterprise Pricing Sign in with Google Sign in with SSO', elements: el(['Enterprise', 'Pricing', 'Sign in with SSO']) };
check("only 'Enterprise' and SSO cues (even with a work email): null", orgAccountReason(enterpriseOnly, 'you@example-corp.com') == null, orgAccountReason(enterpriseOnly, 'you@example-corp.com') || '');
check("'Enterprise' alone: null", orgAccountReason({ title: 'Plans', text: 'Enterprise' }) == null);
const workspace = { title: 'Google One', headings: ['Sign in with your personal account', "You're currently signed in to your Google Workspace Account. To access Google One, switch to your personal account"],
  elements: el(['Manage Google Workspace account']) };
check('Google One on a Workspace login: work account', orgAccountReason(workspace, null) != null, orgAccountReason(workspace, null) || 'null');
const wsOnly = { title: 'Account', headings: ['Google Workspace'], text: '' };
check('one strong cue + a work email: work account', orgAccountReason(wsOnly, 'you@example-corp.com') != null);
check('one strong cue + a personal email: null', orgAccountReason(wsOnly, 'you@gmail.com') == null);
check('work email taken from identity when not passed', orgAccountReason({ ...wsOnly, identity: { emails: [{ value: 'you@example-corp.com', source: 'account-menu' }] } }) != null);
const devConsole = { title: 'Settings', headings: ['Organization', 'Members'], text: 'Default Project API keys Organization Members Billing Usage', elements: el(['API keys', 'Members', 'Billing']) };
check('developer console with "Organization" and "Members" (personal gmail): null', orgAccountReason(devConsole, 'you@gmail.com') == null, orgAccountReason(devConsole, 'you@gmail.com') || '');
const family = { title: 'Family', headings: ['Family plan'], text: 'Family group Invite family members Manage family 5 members Premium Family $19.99/month', elements: el(['Invite family members', 'Manage family']) };
check('family plan page: null', orgAccountReason(family, 'you@gmail.com') == null, orgAccountReason(family, 'you@gmail.com') || '');
const managed = { title: 'Billing', headings: ['Plan'], text: "Billing is managed by your organization's admin. Business plan, 12 seats.", elements: [] };
check("'managed by your organization's admin' + seats: work account", orgAccountReason(managed, null) != null, orgAccountReason(managed, null) || 'null');

console.log('\nSign-in hosts and URLs');
for (const h of ['login.microsoftonline.com', 'login.live.com', 'accounts.google.com', 'appleid.apple.com', 'idmsa.apple.com', 'account.apple.com', 'accounts.shopify.com',
  'auth.openai.com', 'login.yahoo.com', 'sso.godaddy.com', 'signin.aws.amazon.com', 'id.atlassian.com', 'acme.okta.com', 'https://login.live.com/oauth20_authorize.srf'])
  check(`IdP ${h}`, isIdpHost(h));
for (const h of ['www.netflix.com', 'account.microsoft.com', 'secure.hulu.com', 'myaccount.google.com', 'chatgpt.com', 'www.amazon.com', 'one.google.com', 'identity.example.com', ''])
  check(`not IdP ${h || "''"}`, !isIdpHost(h));
for (const u of ['https://www.netflix.com/login', 'https://www.amazon.com/ap/signin?openid.return_to=x', 'https://auth.openai.com/log-in', 'https://example.com/users/sign_in',
  'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x', 'https://accounts.google.com/v3/signin/identifier', 'https://app.example.com/#/login',
  'https://www.example.com/signup', 'https://example.com/login.php', '/auth/'])
  check(`login URL ${u}`, isLoginUrl(u));
for (const u of ['https://www.netflix.com/account', 'https://secure.hulu.com/account', 'https://example.com/?next=/login', 'https://example.com/authors', 'https://claude.ai/settings/billing',
  'https://account.apple.com/', 'https://auth.hbomax.com/subscription', '', null])
  check(`not a login URL ${u}`, !isLoginUrl(u));
for (const t of ['Sign in', 'Log In', 'Login', 'SIGN UP', 'Sign up free', 'Create account', 'Create an account', 'Sign in to Netflix', 'Sign in or create account'])
  check(`sign-in control "${t}"`, hasSignInControl({ elements: [{ id: 0, tag: 'a', text: 'Home' }, { id: 1, tag: 'button', text: t }] }));
check('sign-in control by aria-label', hasSignInControl({ elements: [{ id: 0, tag: 'button', text: '', label: 'Sign in' }] }));
for (const t of ['Sign out', 'Log out', 'Sign in & security', 'Signing in to Google', 'Account', 'Signed in as you@example.com'])
  check(`not a sign-in control "${t}"`, !hasSignInControl({ elements: [{ id: 0, tag: 'button', text: t }] }));
check('no elements: no sign-in control', !hasSignInControl({}) && !hasSignInControl(null));

console.log('\nCatalog');
check("catalogFor('www.primevideo.com') is amazon-prime", catalogFor('www.primevideo.com')?.id === 'amazon-prime', catalogFor('www.primevideo.com')?.id);
check('catalogFor(a URL) works', catalogFor('https://chat.openai.com/c/abc')?.id === 'chatgpt');
check("canonicalKey: cursor.sh and www.cursor.com are both 'cursor'", canonicalKey('cursor.sh') === 'cursor' && canonicalKey('www.cursor.com') === 'cursor');
check("canonicalKey: icloud.com is 'apple', login.live.com is 'microsoft'", canonicalKey('icloud.com') === 'apple' && canonicalKey('login.live.com') === 'microsoft');
check('microsoftonline.com is not in the catalog (work-tenant sign-in)', catalogFor('login.microsoftonline.com') == null);
check('unknown and look-alike sites: null', catalogFor('notnetflix.com') == null && canonicalKey('example.com') == null && catalogFor('') == null);
const seen = new Map();
for (const e of CATALOG) {
  const urls = [e.accountUrl, ...(e.altUrls || [])];
  const good = urls.every((x) => { try { const u = new URL(x); return u.protocol === 'https:' && e.domains.includes(etld1(u.hostname)) && !sensitiveReason(u.hostname) && !isLoginUrl(x); } catch { return false; } });
  check(`catalog ${e.id}: https, on its own domains, not sensitive, not a sign-in page`, good, urls.join(' '));
  for (const d of e.domains) { check(`catalog ${e.id}: ${d} listed once, not sensitive, not infra`, !seen.has(d) && !sensitiveReason(d) && !isInfra(d), seen.get(d) || ''); seen.set(d, e.id); }
}

// The backend refuses on its own too, as a backstop for any client that doesn't check (mock brain: no API spend).
console.log('\nBackend backstop');
process.env.WALKAWAY_BRAIN = 'mock'; process.env.WALKAWAY_RATE_LIMIT = '0';
const call = async (name, body) => (await (await import(`../netlify/functions/${name}.mjs`)).default(new Request(`http://local/api/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), {})).json();
const disc = await call('discover', { domains: ['chase.com', 'irs.gov', 'hulu.com', 'bancoplata.mx', 'healthequity.com'] });
const v = Object.fromEntries(disc.services.map((x) => [x.domain, x]));
check('discover answers every name it was sent', ['chase.com', 'irs.gov', 'hulu.com', 'bancoplata.mx', 'healthequity.com'].every((d) => v[d]), Object.keys(v).join(', '));
check('discover: chase.com withheld, never a subscription', v['chase.com']?.isSubscription === false && /withheld/.test(v['chase.com']?.category), v['chase.com']?.category);
check('discover: irs.gov withheld', v['irs.gov']?.isSubscription === false && /withheld/.test(v['irs.gov']?.category), v['irs.gov']?.category);
for (const d of ['bancoplata.mx', 'healthequity.com']) check(`discover: ${d} withheld (missed by the first live run)`, v[d]?.isSubscription === false && /withheld/.test(v[d]?.category), v[d]?.category);
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
const disc2 = await call('discover', { domains: ['forhims.com', 'betterhelp.com', 'plannedparenthood.org', '23andme.com', 'calm.com'] });
const v2 = Object.fromEntries(disc2.services.map((x) => [x.domain, x]));
for (const d of ['forhims.com', 'betterhelp.com', 'plannedparenthood.org', '23andme.com']) check(`discover: ${d} withheld (R22)`, v2[d]?.isSubscription === false && /withheld/.test(v2[d]?.category), v2[d]?.category);
check('discover: calm.com not withheld', v2['calm.com'] && !/withheld/.test(v2['calm.com'].category), v2['calm.com']?.category);

// What the server puts in a prompt: clean() is scrubSecrets + scrubPii, on the snapshot and on everything the client
// builds from raw page text (history targets and click notes, prior path labels, an open dialog) (R18, R19).
console.log('\nPrompt scrubbing (server)');
const brain = await import('../netlify/functions/lib/brain.mjs');
const row = 'Premium · Visa ending in 4242 · exp 04/27';
const hist = brain.renderHistory([
  { step: 2, state: 'subscription_page', action: { type: 'click', id: 4 }, target: row, note: `clicked "${row}"`, url: 'https://www.example-tv.com/account?session_token=abcdef0123456789abcdef&tab=billing' },
  { step: 3, state: 'reason_survey', action: { type: 'select', id: 7 }, target: 'Ship to', note: 'selected 123 Main Street, Springfield, IL 62704' }]);
check('history: card tail and expiry scrubbed from target and note', !/4242|04\/27/.test(hist) && (hist.match(/\[card\]/g) || []).length === 2, hist);
check('history: address scrubbed from a click note', !/123 Main|62704/.test(hist) && /\[address\]/.test(hist), hist);
check('history: token in the url scrubbed, the page kept', !/abcdef0123456789/.test(hist) && /example-tv\.com\/account/.test(hist), hist);
check('history: plain labels kept', /"Ship to"/.test(hist) && /#4/.test(hist), hist);
const prior = brain.renderPriorPath(['Manage plan', row]);
check('prior path: labels kept, card data scrubbed', /PRIOR PATH/.test(prior || '') && /- Manage plan/.test(prior || '') && !/4242|04\/27/.test(prior || ''), prior);
check('prior path: none → no block', brain.renderPriorPath([]) === null && brain.renderPriorPath(undefined) === null);
const ready = brain.renderReadiness({ readyState: 'complete', visibleTextLen: 900, interactiveCount: 12, dialog: 'Update card Visa ending in 4242 · Expires 04/27' });
check('readiness: open dialog scrubbed of card data', /open dialog/.test(ready) && !/4242|04\/27/.test(ready), ready);
const snapText = brain.renderSnapshot({ url: 'https://www.example-tv.com/account', title: 'Account', text: 'Premium $17.99/month Next billing date: October 10, 2026 · renews 10/10/2026 · Visa ending in 4242', elements: [] });
check('snapshot: plan, price and renewal date survive the extra scrubPii pass', /\$17\.99\/month/.test(snapText) && /October 10, 2026/.test(snapText) && /10\/10\/2026/.test(snapText) && !/4242/.test(snapText), snapText);
// R26: the Google One Workspace screen lives on one.google.com/error, which rule 1 would otherwise call not_found.
check('classify prompt: a switch-to-personal-account page is account_other + work_or_team, even on /error',
  /switch to or sign in with a personal account is account_other with accountType work_or_team, even on an \/error URL/.test(brain.CLASSIFY_SYSTEM));

// guardPageClass keeps the details link the extension will open only when it is a safe same-site <a>. Whole words:
// a brand or section name is not an action ("My Best Buy Memberships", "Subscriber Services") (R27).
console.log('\nDetails links (server guard)');
const linkCheck = (pageUrl, text, href) => guardPageClass({ pageKind: 'account_other', signedIn: true, detailsLinkId: 3, confidence: 0.8 },
  { url: pageUrl, elements: [{ id: 3, tag: 'a', text, href }] }, new URL(pageUrl).hostname).detailsLinkId;
for (const [pg, t, href] of [['https://www.bestbuy.com/profile/c/home', 'My Best Buy Memberships', 'https://www.bestbuy.com/profile/c/memberships'],
  ['https://accounts.nintendo.com/', 'Nintendo Switch Online', 'https://accounts.nintendo.com/shop/membership'],
  ['https://www.nypost.com/account', 'Subscriber Services', 'https://www.nypost.com/subscriber-services/'],
  ['https://www.example-tv.com/home', 'Joined plans', 'https://www.example-tv.com/plans/joined'],
  ['https://www.example-tv.com/home', 'Paused? Manage membership', 'https://www.example-tv.com/membership'],
  ['https://www.example-tv.com/home', 'Billing', 'https://www.example-tv.com/account/billing']])
  check(`details link kept: "${t}"`, linkCheck(pg, t, href) === 3);
for (const [t, href] of [['Buy now', '/deal'], ['Buy a gift membership', '/gift'], ['Cancel membership', '/membership'], ['Sign out', '/bye'], ['Log out', '/bye'], ['Switch to annual', '/plan'],
  ['Start your free trial', '/plan'], ['Subscribe', '/plan'], ['Pause membership', '/membership'], ['Join now', '/join'], ['Upgrade', '/plan'], ['Delete account', '/settings'],
  ['Membership', '/account/cancel'], ['Membership', '/logout'], ['Billing', '/checkout/billing']])
  check(`details link dropped: "${t}" → ${href}`, linkCheck('https://www.example-tv.com/home', t, 'https://www.example-tv.com' + href) === null);
check('details link dropped: off-site', linkCheck('https://www.example-tv.com/home', 'Billing', 'https://billing.other-site.com/') === null);

// review-log reads a page the way the owner would; checked end to end on a small synthetic log (R11, R12).
console.log('\nreview-log page reading');
const T0 = Date.UTC(2026, 0, 1);
const probe = (svc, status, accountUrl, finalUrl, page, extra) => ({ t: T0 + 1000, dt: 1000, kind: 'probe', svc, name: svc, status, accountUrl, finalUrl, page, loadMs: 900, classifyMs: 800,
  classify: { pageKind: status === 'signed_in' ? 'account_billing' : 'other', signedIn: status === 'signed_in', hasPaidPlan: status === 'signed_in' ? true : null, confidence: 0.8, notes: '' }, ...extra });
const synthLog = { format: 'walkaway-test-log', version: 1, startedAt: T0, endedAt: T0 + 5000, meta: { extensionVersion: 'test', settings: { testMode: true } }, events: [
  { t: T0, dt: 0, kind: 'run.start' },
  // a busy page (a carousel) that never held still, read normally: an account page, not "loading/blocked"
  probe('carousel-tv.com', 'signed_in', 'https://www.carousel-tv.com/account', 'https://www.carousel-tv.com/account',
    { title: 'Your membership', headings: ['Membership'], buttons: ['Manage membership', 'Sign out'], elements: 35, textLength: 2400 }, { ready: { kind: 'timeout', ms: 15000, visibleTextLen: 2400, interactiveCount: 35 } }),
  // a timeout with almost nothing on the page still is
  probe('blank-tv.com', 'not_loaded', 'https://www.blank-tv.com/account', 'https://www.blank-tv.com/account',
    { title: 'Account', headings: [], buttons: [], elements: 2, textLength: 40 }, { ready: { kind: 'timeout', ms: 15000, visibleTextLen: 40, interactiveCount: 0 } }),
  // the service's own account host looks like an IdP (auth.*): not a sign-in page
  probe('hbomax.com', 'signed_in', 'https://auth.hbomax.com/subscription', 'https://auth.hbomax.com/subscription',
    { title: 'Subscription', headings: ['Your plan'], buttons: ['Change plan', 'Cancel subscription', 'Sign out'], elements: 20, textLength: 1800 }),
  // another service sent to that kind of host is
  probe('streamer-tv.com', 'login_wall', 'https://www.streamer-tv.com/account', 'https://account.apple.com/',
    { title: 'Apple Account', headings: ['Apple Account'], buttons: ['Continue'], elements: 5, textLength: 300 }),
  { t: T0 + 5000, dt: 5000, kind: 'run.end' }] };
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walkaway-review-'));
const logFile = path.join(tmpDir, 'log.json');
fs.writeFileSync(logFile, JSON.stringify(synthLog));
let report = '';
try { report = execFileSync(process.execPath, [fileURLToPath(new URL('./review-log.mjs', import.meta.url)), logFile], { encoding: 'utf8' }); } catch (e) { report = `THREW: ${e.message}`; }
fs.rmSync(tmpDir, { recursive: true, force: true });
const whyRow = (svc) => (report.match(new RegExp(`^  ${svc.replace(/\./g, '\\.')}\\s+\\S+\\s+(account page|sign-in form|loading\\/blocked|wrong URL|marketing|not read|sensitive)`, 'm')) || [])[1] || (report.startsWith('THREW') ? report.slice(0, 200) : 'no row');
check('review-log: busy timeout page with content reads as an account page', whyRow('carousel-tv.com') === 'account page', whyRow('carousel-tv.com'));
check('review-log: sparse timeout page reads as loading/blocked', whyRow('blank-tv.com') === 'loading/blocked', whyRow('blank-tv.com'));
check("review-log: the service's own auth.* account host is not a sign-in form", whyRow('hbomax.com') === 'account page', whyRow('hbomax.com'));
check('review-log: another service landing on an IdP host is a sign-in form', whyRow('streamer-tv.com') === 'sign-in form', whyRow('streamer-tv.com'));
check('review-log: no walk flagged as going to a loading/blocked page', !/page is loading\/blocked/.test(report), (report.match(/.*loading\/blocked.*/g) || []).join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// Unit test for the lines shown per subscription and the reveal screen's sections (extension/src/saving.ts,
// extension/src/format.ts). Pure code, so it runs under plain Node: compile both to a temp dir, then exercise
// the deal line, the paying line, the status labels, and a reveal built from a scan shaped like the first
// live run (64 rows, mostly signed out). All names and emails here are made up.
//   npm run test:saving
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.join(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-saving-'));
execFileSync('npx', ['tsc', 'src/saving.ts', 'src/format.ts', '--outDir', out, '--module', 'commonjs', '--target', 'es2022', '--moduleResolution', 'node', '--esModuleInterop', '--skipLibCheck'], { cwd: path.join(root, 'extension'), stdio: 'pipe' });
const { dealLine, payingLine, monthlyOf, groupReveal, paidSubLine, alsoLabel, countLine, bucketLine } = require(path.join(out, 'saving.js'));
const { keptLabel } = require(path.join(out, 'format.js'));

let fails = 0, n = 0;
function check(name, got, want) {
  n++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${JSON.stringify(got)}${ok ? '' : `\n      want: ${JSON.stringify(want)}`}`);
}

// ---- The deal line ----
const today = new Date(2026, 8, 23);
const base = { hasOffer: true, estSavings: 0, monthlyPrice: 17.99, cycleCharge: 17.99, cadence: 'month', renewalDate: '2026-10-10', isTrial: false, trialEndsOn: null, priceAfterTrial: null };
const O = (o) => ({ description: '', newMonthlyPriceUsd: null, discountPct: null, termMonths: null, freeMonths: null, ...o });
const deals = [
  ['monthly, 50% for 3', { ...base, offer: O({ newMonthlyPriceUsd: 9, discountPct: 0.5, termMonths: 3 }) }, '$17.99/mo → $9/mo for 3 months, from Oct 10'],
  ['monthly, pct only (derived price rounds half up)', { ...base, offer: O({ discountPct: 50, termMonths: 3 }) }, '$17.99/mo → $9/mo for 3 months, from Oct 10'],
  ['trial, then 50% for 3', { ...base, cycleCharge: 0, isTrial: true, trialEndsOn: '2026-10-10', priceAfterTrial: 17.99, offer: O({ discountPct: 0.5, termMonths: 3 }) }, 'Free until Oct 10, then $9/mo instead of $17.99 for 3 months'],
  ['2 months free', { ...base, offer: O({ freeMonths: 2 }) }, '2 months free from Oct 10, then $17.99/mo'],
  ['fixed $8.99 for 6', { ...base, offer: O({ newMonthlyPriceUsd: 8.99, termMonths: 6 }) }, '$17.99/mo → $8.99/mo for 6 months, from Oct 10'],
  ['annual, 20% off', { ...base, monthlyPrice: 10, cycleCharge: 120, cadence: 'year', renewalDate: '2027-03-03', offer: O({ discountPct: 0.2, termMonths: 12 }) }, '$120/yr → $96 at your next renewal, Mar 3 2027'],
  ['no date known', { ...base, renewalDate: null, offer: O({ newMonthlyPriceUsd: 9, discountPct: 0.5, termMonths: 3 }) }, '$17.99/mo → $9/mo for 3 months, from your next charge'],
  ['no offer, paid', { ...base, hasOffer: false, offer: null }, '$17.99/mo · renews Oct 10'],
  ['no offer, trial', { ...base, hasOffer: false, offer: null, cycleCharge: 0, isTrial: true, trialEndsOn: '2026-10-10', priceAfterTrial: 17.99 }, 'Free until Oct 10, then $17.99/mo'],
];
for (const [name, item, want] of deals) check(`deal: ${name}`, dealLine(item, today), want);

// ---- What they pay today, when parts are missing (the "–/mo" glitch) ----
const none = { ...base, hasOffer: false, offer: null, monthlyPrice: null, cycleCharge: null, renewalDate: null, cadence: 'unknown' };
check('paying: nothing known → empty, never "–/mo"', payingLine(none, today), '');
check('paying: renewal date alone', payingLine({ ...none, renewalDate: '2026-10-17' }, today), 'renews Oct 17');
check('paying: yearly charge + renewal', payingLine({ ...none, cycleCharge: 139, cadence: 'year', renewalDate: '2027-03-03' }, today), '$139/yr · renews Mar 3 2027');
check('paying: quarterly charge', payingLine({ ...none, cycleCharge: 30, cadence: 'quarter' }, today), '$30/qtr');
check('paying: trial with nothing else', payingLine({ ...none, isTrial: true }, today), 'Free trial');
check('monthlyOf: month / year / quarter / week / none', [monthlyOf(base), monthlyOf({ ...none, cycleCharge: 120, cadence: 'year' }), monthlyOf({ ...none, cycleCharge: 30, cadence: 'quarter' }), monthlyOf({ ...none, cycleCharge: 5, cadence: 'week' }), monthlyOf(none)], [17.99, 10, 10, 21.67, null]);

// ---- One label per status ----
const statuses = ['login_wall', 'no_paid_plan', 'wrong_page', 'not_loaded', 'needs_you', 'work_account', 'billed_elsewhere', 'unconfirmed', 'error', 'sensitive', 'duplicate'];
check('keptLabel: every status', statuses.map((status) => keptLabel({ status })), ['Signed out', 'Free plan', "Couldn't find the account page", "Page didn't load", 'Needs you', 'Work account', 'Billed elsewhere', 'Plan not shown', "Couldn't check", 'Skipped · sensitive', 'Same account']);
check('keptLabel: signed_in by find outcome', [{ offerApplied: true }, { findOutcome: 'not_walked' }, { findOutcome: 'no_offer_backed_out' }, { findOutcome: 'blocked_needs_you' }, { findOutcome: null }, { findOutcome: 'error' }].map((x) => keptLabel({ status: 'signed_in', offerApplied: false, ...x })), ['Promo active · kept', 'Not walked · read-only', 'No offer this time · left alone', 'Needs you to sign in', 'Not checked', "Couldn't check · left alone"]);

// ---- The reveal for a scan shaped like the first live run (read-only test) ----
// 64 rows: 7 were signed_in, 47 login_wall, 9 no_paid_plan, 1 error under the old mapping. Under the new
// statuses: 4 paying, 11 need a look, 1 work account (+1 duplicate of it), 6 free plans, 41 signed out.
const SETS = { paying: ['signed_in', 'billed_elsewhere'], needsLook: ['unconfirmed', 'wrong_page', 'not_loaded', 'needs_you', 'error'] };
let seq = 0;
const row = (name, status, o = {}) => { const domain = o.domain || `${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}${++seq}.example`; return { id: domain, domain, name, status, hasOffer: false, offer: null, estSavings: 0, monthlyPrice: null, cycleCharge: null, cadence: 'unknown', renewalDate: null, isTrial: false, trialEndsOn: null, priceAfterTrial: null, planName: null, email: null, accountName: null, dupOf: null, aliases: [], findOutcome: null, ...o, }; };
const mix = [
  row('Vidora', 'signed_in', { planName: 'Vidora Premium', monthlyPrice: 15.99, cycleCharge: 15.99, cadence: 'month', findOutcome: 'not_walked' }),
  row('Linkly', 'signed_in', { planName: 'Career Pro', findOutcome: 'not_walked' }),
  row('Streamly', 'signed_in', { planName: 'Premium plan', renewalDate: '2026-10-17', findOutcome: 'not_walked' }),
  row('Primebox', 'signed_in', { planName: 'Annual membership', cycleCharge: 139, cadence: 'year', renewalDate: '2027-03-03', aliases: ['primebox-video.example'], findOutcome: 'not_walked' }),
  row('Codepad', 'work_account', { domain: 'codepad.example', email: 'you@work.example', aliases: ['codepad-old.example'] }),
  row('Codepad', 'duplicate', { domain: 'codepad-old.example', dupOf: 'codepad.example' }),
  row('Gridbox', 'wrong_page', { email: 'you@work.example' }), row('Shopmart', 'wrong_page'),
  row('Chatter', 'unconfirmed', { email: 'you@example.com' }), row('Modelhub', 'unconfirmed'),
  row('Oldsite', 'wrong_page'), row('Rentals', 'wrong_page'), row('Tickets', 'wrong_page'),
  row('Loopcast', 'not_loaded'), row('Chatrooms', 'not_loaded'), row('Moviedb', 'needs_you'), row('Brokenco', 'error'),
  ...Array.from({ length: 6 }, (_, k) => row(`Freebie ${k + 1}`, 'no_paid_plan', { planName: 'Free' })),
  ...Array.from({ length: 41 }, (_, k) => row(`Signedout ${String(k + 1).padStart(2, '0')}`, 'login_wall')),
];
const g = groupReveal(mix, SETS);
const counts = (x) => ({ offers: x.offers.length, paying: x.paying.length, needsLook: x.needsLook.length, work: x.work.length, free: x.free.length, signedOut: x.signedOut.length, sensitive: x.sensitive.length, duplicates: x.duplicates.length });
check('mix: 64 rows', mix.length, 64);
check('mix: sections', counts(g), { offers: 0, paying: 4, needsLook: 11, work: 1, free: 6, signedOut: 41, sensitive: 0, duplicates: 1 });
check('mix: count line (read-only, find skipped)', countLine(g.paying.length + g.offers.length, 0, { readOnly: true, walked: false }), '4 subscriptions found · offers not checked (read-only test)');
check('mix: paying sorted by monthly price, unpriced last', g.paying.map((i) => i.name), ['Vidora', 'Primebox', 'Linkly', 'Streamly']);
check('mix: paying sub-lines (no "–")', g.paying.map((i) => paidSubLine(i, today)), ['Vidora Premium · $15.99/mo', 'Annual membership · $139/yr · renews Mar 3 2027', 'Career Pro', 'Premium plan · renews Oct 17']);
check('mix: needs a look, plan-not-shown first, then by status order', g.needsLook.map((i) => i.name), ['Chatter', 'Modelhub', 'Gridbox', 'Oldsite', 'Rentals', 'Shopmart', 'Tickets', 'Chatrooms', 'Loopcast', 'Moviedb', 'Brokenco']);
check('mix: work row names its duplicate once', alsoLabel(g.work[0], mix), 'also: codepad-old.example');
check('mix: alias shown on a paying row', alsoLabel(g.paying[1], mix), 'also: primebox-video.example');
check('mix: scanning summary once the pages pass is done', bucketLine(mix.filter((i) => !SETS.paying.includes(i.status)), SETS), '41 signed out · 6 free plans · 11 need a look · 1 work account · 1 duplicate');

// ---- Smaller shapes ----
check('bucket line (the contract example)', bucketLine([...Array(12)].map(() => row('a', 'login_wall')).concat([...Array(3)].map(() => row('b', 'no_paid_plan')), [row('c', 'unconfirmed'), row('d', 'wrong_page'), row('e', 'work_account')]), SETS), '12 signed out · 3 free plans · 2 need a look · 1 work account');
check('bucket line: singular look, sensitive', bucketLine([row('a', 'error'), row('b', 'sensitive')], SETS), '1 needs a look · 1 skipped (sensitive)');
check('an old saved "unknown" row asks for a look', groupReveal([row('Legacy', 'unknown')], SETS).needsLook.length, 1);
check('a duplicate with another name shows its name', alsoLabel(row('Big Store', 'signed_in', { domain: 'bigstore.example' }), [row('Big Store', 'signed_in', { domain: 'bigstore.example' }), row('Store Video', 'duplicate', { dupOf: 'bigstore.example' })]), 'also: Store Video');
check('offers sort best first and never count as paying rows', (() => { const x = groupReveal([row('A', 'signed_in', { hasOffer: true, estSavings: 5 }), row('B', 'signed_in', { hasOffer: true, estSavings: 20 }), row('C', 'signed_in')], SETS); return [x.offers.map((i) => i.name), x.paying.map((i) => i.name)]; })(), [['B', 'A'], ['C']]);
check('count line: offers', countLine(3, 2, { readOnly: false, walked: true }), "3 subscriptions found · 2 made an offer · untick anything you'd rather leave alone");
check('count line: walked, none made an offer', countLine(1, 0, { readOnly: false, walked: true }), '1 subscription found · none made an offer this time');
check('count line: nothing walkable', countLine(2, 0, { readOnly: false, walked: false }), '2 subscriptions found');

fs.rmSync(out, { recursive: true, force: true });
console.log(fails ? `\n${fails} of ${n} FAILED` : `\nall ${n} as intended`);
process.exit(fails ? 1 : 0);

// Unit test for the deal line shown per subscription (extension/src/saving.ts). Pure code, so it runs
// under plain Node: compile saving.ts + format.ts to a temp dir, then exercise the main shapes.
//   npm run test:saving
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.join(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-saving-'));
execFileSync('npx', ['tsc', 'src/saving.ts', 'src/format.ts', '--outDir', out, '--module', 'commonjs', '--target', 'es2022', '--moduleResolution', 'node', '--esModuleInterop', '--skipLibCheck'], { cwd: path.join(root, 'extension'), stdio: 'pipe' });
const { dealLine } = require(path.join(out, 'saving.js'));

const today = new Date(2026, 8, 23);
const base = { hasOffer: true, estSavings: 0, monthlyPrice: 17.99, cycleCharge: 17.99, cadence: 'month', renewalDate: '2026-10-10', isTrial: false, trialEndsOn: null, priceAfterTrial: null };
const O = (o) => ({ description: '', newMonthlyPriceUsd: null, discountPct: null, termMonths: null, freeMonths: null, ...o });
const cases = [
  ['monthly, 50% for 3', { ...base, offer: O({ newMonthlyPriceUsd: 9, discountPct: 0.5, termMonths: 3 }) }, '$17.99/mo → $9/mo for 3 months, from Oct 10'],
  ['monthly, pct only (derived price rounds half up)', { ...base, offer: O({ discountPct: 50, termMonths: 3 }) }, '$17.99/mo → $9/mo for 3 months, from Oct 10'],
  ['trial, then 50% for 3', { ...base, cycleCharge: 0, isTrial: true, trialEndsOn: '2026-10-10', priceAfterTrial: 17.99, offer: O({ discountPct: 0.5, termMonths: 3 }) }, 'Free until Oct 10, then $9/mo instead of $17.99 for 3 months'],
  ['2 months free', { ...base, offer: O({ freeMonths: 2 }) }, '2 months free from Oct 10, then $17.99/mo'],
  ['fixed $8.99 for 6', { ...base, offer: O({ newMonthlyPriceUsd: 8.99, termMonths: 6 }) }, '$17.99/mo → $8.99/mo for 6 months, from Oct 10'],
  ['annual, 20% off', { ...base, monthlyPrice: 10, cycleCharge: 120, cadence: 'year', renewalDate: '2027-03-03', offer: O({ discountPct: 0.2, termMonths: 12 }) }, '$120/yr → $96 at your next renewal, Mar 3 2027'],
  ['no date known', { ...base, renewalDate: null, offer: O({ newMonthlyPriceUsd: 9, discountPct: 0.5, termMonths: 3 }) }, '$17.99/mo → $9/mo for 3 months, from your next charge'],
  ['no offer, paid', { ...base, hasOffer: false, offer: null }, '$17.99/mo, next charge Oct 10'],
  ['no offer, trial', { ...base, hasOffer: false, offer: null, cycleCharge: 0, isTrial: true, trialEndsOn: '2026-10-10', priceAfterTrial: 17.99 }, 'Free until Oct 10, then $17.99/mo'],
];
let fails = 0;
for (const [name, item, want] of cases) {
  const got = dealLine(item, today);
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${got}${ok ? '' : `\n      want: ${want}`}`);
}
fs.rmSync(out, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : `\nall ${cases.length} as intended`);
process.exit(fails ? 1 : 0);

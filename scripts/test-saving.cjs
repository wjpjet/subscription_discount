// Unit test for the two lines shown per subscription (extension/src/saving.ts). Pure code, so it runs
// under plain Node: compile saving.ts + format.ts to a temp dir, then exercise the main shapes.
//   node scripts/test-saving.cjs
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.join(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-saving-'));
execFileSync('npx', ['tsc', 'src/saving.ts', 'src/format.ts', '--outDir', out, '--module', 'commonjs', '--target', 'es2022', '--moduleResolution', 'node', '--esModuleInterop', '--skipLibCheck'], { cwd: path.join(root, 'extension'), stdio: 'pipe' });
const { savingLines } = require(path.join(out, 'saving.js'));

const today = new Date(2026, 8, 23);
const base = { hasOffer: true, estSavings: 0, monthlyPrice: 17.99, cycleCharge: 17.99, cadence: 'month', renewalDate: '2026-10-10', isTrial: false, trialEndsOn: null, priceAfterTrial: null };
const O = (o) => ({ description: '', newMonthlyPriceUsd: null, discountPct: null, termMonths: null, freeMonths: null, ...o });
const cases = [
  ['monthly, 50% for 3', { ...base, estSavings: 26.99, offer: O({ description: '50% off for 3 months', newMonthlyPriceUsd: 9, discountPct: 0.5, termMonths: 3 }) },
    ['Paying $17.99/mo · next charge Oct 10', '50% off for 3 months → $9/mo Oct 10 – Jan 10 2027, back to $17.99/mo after · saves $26.99']],
  ['trial, then 50% for 3', { ...base, cycleCharge: 0, isTrial: true, trialEndsOn: '2026-10-10', priceAfterTrial: 17.99, estSavings: 26.99, offer: O({ discountPct: 50, termMonths: 3 }) },
    ['Free trial until Oct 10, then $17.99/mo', '50% off for 3 months → $9/mo Oct 10 – Jan 10 2027, back to $17.99/mo after · saves $26.99']],
  ['2 months free', { ...base, estSavings: 35.98, offer: O({ description: '2 months free', freeMonths: 2 }) },
    ['Paying $17.99/mo · next charge Oct 10', '2 months free → $0 Oct 10 – Dec 10, then $17.99/mo · saves $35.98']],
  ['fixed $8.99 for 6', { ...base, estSavings: 54, offer: O({ description: 'Keep Premium for $8.99/mo', newMonthlyPriceUsd: 8.99, termMonths: 6 }) },
    ['Paying $17.99/mo · next charge Oct 10', '$8.99/mo instead of $17.99 Oct 10 – Apr 10 2027, back to $17.99/mo after · saves $54']],
  ['annual, 20% off', { ...base, monthlyPrice: 10, cycleCharge: 120, cadence: 'year', renewalDate: '2027-03-03', estSavings: 24, offer: O({ description: '20% off', discountPct: 0.2, termMonths: 12 }) },
    ['Paying $120/yr · next charge Mar 3 2027', '20% off your next year → $96 on Mar 3 2027 · saves $24']],
  ['no date known', { ...base, renewalDate: null, estSavings: 26.99, offer: O({ description: '50% off for 3 months', newMonthlyPriceUsd: 9, discountPct: 0.5, termMonths: 3 }) },
    ['Paying $17.99/mo', '50% off for 3 months → $9/mo for 3 months from your next charge · saves $26.99']],
  ['no offer', { ...base, hasOffer: false, offer: null }, ['Paying $17.99/mo · next charge Oct 10', '']],
];
let fails = 0;
for (const [name, item, want] of cases) {
  const L = savingLines(item, today);
  const ok = L.now === want[0] && L.offer === want[1];
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      now:   ${L.now}\n      offer: ${L.offer}`);
  if (!ok) console.log(`      want:  ${want[0]}\n             ${want[1]}`);
}
fs.rmSync(out, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : `\nall ${cases.length} as intended`);
process.exit(fails ? 1 : 0);

// What does classify report from a real account page? Logs into the local testbed as a known address,
// snapshots the subscription page, and prints the billing facts the reveal screen depends on.
//   npm run check:email                      (real brain)   |  add --trial to render the plan as a free trial
//   WALKAWAY_BRAIN=mock npm run check:email  (heuristic)
import puppeteer from 'puppeteer-core';
import { snapshotPage } from '../shared/page-scripts.js';
import { loginTestbed, callFn } from './lib/driver.mjs';
import { serveTestbed } from './lib/testbed-server.mjs';

process.env.WALKAWAY_RATE_LIMIT = '0';
const PORT = 8797, BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EMAIL = 'willem.demo@example.com';
const TRIAL = process.argv.includes('--trial');

const srv = await serveTestbed(PORT);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
let fails = 0;
const isOct10 = (v) => { const d = new Date(String(v || '')); return !isNaN(d) && d.getFullYear() === 2026 && d.getMonth() === 9 && d.getDate() === 10; };
const check = (label, ok, got) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${got !== undefined ? '  — ' + got : ''}`); if (!ok) fails++; };
try {
  const page = await browser.newPage();
  await loginTestbed(page, BASE, EMAIL);
  await page.goto(`${BASE}/settings/subscription?trial=${TRIAL ? 1 : 0}`, { waitUntil: 'load' });
  const snap = await page.evaluate(snapshotPage, { maxElements: 80, textChars: 4000 });
  const r = await callFn('classify', { domain: '127.0.0.1', snapshot: snap });
  const c = r.result;
  console.log(`brain: ${r.brain} (${r.provider || ''})  page: ${TRIAL ? 'FREE TRIAL' : 'paid plan'}\n`);
  check('accountEmail', c.accountEmail === EMAIL, c.accountEmail);
  check('signedIn + paid plan', c.signedIn === true && c.hasPaidPlan === true, `signedIn=${c.signedIn} hasPaidPlan=${c.hasPaidPlan}`);
  check('renewalDate is the next billing date (Oct 10, 2026)', isOct10(c.renewalDate), c.renewalDate);
  check('cadence month', c.cadence === 'month', c.cadence);
  if (TRIAL) {
    check('isTrial', c.isTrial === true, c.isTrial);
    check('cycleChargeUsd is 0 during the trial', c.cycleChargeUsd === 0, c.cycleChargeUsd);
    check('priceAfterTrialUsd is 17.99', Math.abs((c.priceAfterTrialUsd ?? -1) - 17.99) < 0.01, c.priceAfterTrialUsd);
    check('trialEndsOn is Oct 10, 2026 (or null when only the billing date is shown)', c.trialEndsOn == null || isOct10(c.trialEndsOn), c.trialEndsOn);
  } else {
    check('not a trial', c.isTrial === false, c.isTrial);
    check('monthlyPriceUsd 17.99', Math.abs((c.monthlyPriceUsd ?? -1) - 17.99) < 0.01, c.monthlyPriceUsd);
    check('cycleChargeUsd 17.99', Math.abs((c.cycleChargeUsd ?? -1) - 17.99) < 0.01, c.cycleChargeUsd);
  }
  console.log(fails ? `\n${fails} FAILED` : '\nall good');
  process.exitCode = fails ? 1 : 0;
} finally { await browser.close().catch(() => {}); srv.close(); }

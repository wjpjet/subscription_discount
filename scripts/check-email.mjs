// Does classify report the signed-in email from a real account page? Logs into the local testbed as a
// known address, snapshots the subscription page, and asks the configured brain.
//   node --env-file=.env scripts/check-email.mjs            (real brain)
//   WALKAWAY_BRAIN=mock node scripts/check-email.mjs        (heuristic)
import puppeteer from 'puppeteer-core';
import { snapshotPage } from '../shared/page-scripts.js';
import { loginTestbed, callFn } from './lib/driver.mjs';
import { serveTestbed } from './lib/testbed-server.mjs';

process.env.WALKAWAY_RATE_LIMIT = '0';
const PORT = 8797, BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EMAIL = 'willem.demo@example.com';

const srv = await serveTestbed(PORT);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await loginTestbed(page, BASE, EMAIL);
  await page.goto(`${BASE}/settings/subscription`, { waitUntil: 'load' });
  const snap = await page.evaluate(snapshotPage, { maxElements: 80, textChars: 4000 });
  const r = await callFn('classify', { domain: '127.0.0.1', snapshot: snap });
  const got = r.result && r.result.accountEmail;
  console.log(`brain: ${r.brain} (${r.provider || ''})`);
  console.log(`page shows:      ${EMAIL}`);
  console.log(`classify says:   ${got}`);
  console.log(`signedIn=${r.result.signedIn} hasPaidPlan=${r.result.hasPaidPlan} monthly=${r.result.monthlyPriceUsd}`);
  console.log(got === EMAIL ? 'PASS  accountEmail matches' : 'FAIL  accountEmail does not match');
  process.exitCode = got === EMAIL ? 0 : 1;
} finally { await browser.close().catch(() => {}); srv.close(); }

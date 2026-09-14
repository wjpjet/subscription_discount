// Quick 3-scenario smoke test on the testbed (offer on / offer off / from home). `npm run e2e:testbed[:mock]`
import puppeteer from 'puppeteer-core';
import { hunt, classifyPage, sleep } from './lib/driver.mjs';
import { serveTestbed } from './lib/testbed-server.mjs';
const PORT = 8790, BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
async function scenario(browser, name, id, startAt, expectOffer) {
  const context = await browser.createBrowserContext(); const page = await context.newPage(); await page.setViewport({ width: 1100, height: 800 });
  const merchant = { name: 'Streamly (testbed)', domain: '127.0.0.1', accountUrl: `${BASE}/settings/subscription` };
  await page.goto(`${BASE}/login`, { waitUntil: 'load' }); await page.type('#email', 'e2e@example.com'); await page.type('#password', 'walkaway');
  await Promise.all([page.waitForNavigation({ timeout: 5000 }).catch(() => {}), page.click('button[type=submit]')]);
  await page.goto(`${BASE}/?scenario=${id}`, { waitUntil: 'load' }); await sleep(150);
  const before = await classifyPage(page, merchant);
  await page.goto(`${BASE}${startAt}`, { waitUntil: 'load' });
  const res = await hunt(page, merchant);
  const after = await classifyPage(page, merchant);
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('streamly.state')));
  console.log(`\n=== ${name} ===\n${res.log.join('\n')}\noutcome: ${res.outcome}${res.reason ? ' (' + res.reason + ')' : ''}\nprice before → after: $${before.monthlyPriceUsd} → $${after.monthlyPriceUsd}  offerApplied=${state.offerApplied} cancelled=${state.cancelled}`);
  await context.close();
  const pass = !state.cancelled && (expectOffer ? (res.outcome === 'discount_applied' && state.offerApplied) : (res.outcome === 'no_offer_backed_out' && !state.offerApplied));
  return { name, pass, outcome: res.outcome, cancelled: state.cancelled, offerApplied: state.offerApplied };
}
const srv = await serveTestbed(PORT);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const results = [];
try {
  results.push(await scenario(browser, 'A: offer on, start at subscription page', 'S001', '/settings/subscription', true));
  results.push(await scenario(browser, 'B: no offer (called bluff), start at subscription page', 'S019', '/settings/subscription', false));
  results.push(await scenario(browser, 'C: offer on, start at home (must navigate)', 'S005', '/', true));
} finally { await browser.close(); srv.close(); }
console.log('\n=== SUMMARY ===');
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name} → ${r.outcome}, cancelled=${r.cancelled}, offerApplied=${r.offerApplied}`);
process.exit(results.every((r) => r.pass) ? 0 : 1);

// End-to-end: drive the Streamly testbed with the real brain (or mock) using the same page scripts
// and guardrails the extension uses. Requires Google Chrome. `npm run e2e:testbed` (or :mock).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { snapshotPage, performAction, readElement } from '../shared/page-scripts.js';
import { isFinalizeText } from '../shared/guardrails.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TESTBED = path.join(ROOT, 'testbed');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8790, BASE = `http://127.0.0.1:${PORT}`;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serveTestbed() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, BASE).pathname);
      let file = path.join(TESTBED, p);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(TESTBED, 'index.html');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    }).listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

async function callFn(name, body) {
  const mod = await import(`../netlify/functions/${name}.mjs`);
  const res = await mod.default(new Request(`http://local/api/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), {});
  const j = await res.json(); if (j.error) throw new Error(`${name}: ${j.error}`); return j;
}

async function settle(page) {
  await Promise.race([page.waitForNavigation({ timeout: 2500 }).catch(() => {}), sleep(900)]);
  await sleep(400);
}

async function login(page, offerEnabled, startAt) {
  await page.goto(`${BASE}/login`, { waitUntil: 'load' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}/login`, { waitUntil: 'load' });
  await page.type('#email', 'e2e@example.com');
  await page.type('#password', 'walkaway');
  await Promise.all([page.waitForNavigation({ timeout: 5000 }).catch(() => {}), page.click('button[type=submit]')]);
  await page.evaluate((offer) => { const s = JSON.parse(localStorage.getItem('streamly.state')); s.offerEnabled = offer; s.offerApplied = false; s.cancelled = false; localStorage.setItem('streamly.state', JSON.stringify(s)); }, offerEnabled);
  await page.goto(`${BASE}${startAt}`, { waitUntil: 'load' });
}

async function hunt(page, merchant, maxSteps = 20) {
  const history = []; const log = [];
  for (let step = 0; step < maxSteps + 1; step++) {
    const snapshot = await page.evaluate(snapshotPage, { maxElements: 120, textChars: 4000 });
    const { decision, guardrails, proposed } = await callFn('agent-step', { runId: 'e2e', merchant, goal: 'hunt', step, maxSteps, history, snapshot });
    const a = decision.action;
    const target = a.id != null ? (snapshot.elements.find((e) => e.id === a.id) || {}).text : undefined;
    log.push(`step ${step} [${decision.state}] ${proposed.type}${proposed.id != null ? ' #' + proposed.id : ''} → ${a.type}${a.id != null ? ' #' + a.id : ''}${target ? ` "${target}"` : ''}${guardrails.length ? '  ⛔ ' + guardrails.join('; ') : ''}  @ ${new URL(snapshot.url).pathname}`);
    let ok = true, note = '';
    if (a.type === 'finish' || a.type === 'back_out') { history.push({ step, url: snapshot.url, state: decision.state, action: a, target, note: guardrails.join('; ') }); return { outcome: a.type === 'finish' ? a.outcome : 'no_offer_backed_out', details: a.details || null, reason: a.reason || null, history, log }; }
    if (a.type === 'click' || a.type === 'accept_offer') {
      const live = await page.evaluate(readElement, a.id);
      if (!live || isFinalizeText(live.text)) { ok = false; note = 'extension-side guard refused click'; history.push({ step, url: snapshot.url, state: decision.state, action: a, target, ok, note }); return { outcome: 'no_offer_backed_out', reason: note, history, log }; }
      const r = await page.evaluate(performAction, { type: 'click', id: a.id }); ok = r.ok; note = r.note; await settle(page);
    } else if (a.type === 'type' || a.type === 'select' || a.type === 'scroll') {
      const r = await page.evaluate(performAction, a); ok = r.ok; note = r.note; await sleep(300);
    } else if (a.type === 'navigate') { await page.goto(a.url, { waitUntil: 'load' }).catch(() => { ok = false; }); }
    else if (a.type === 'wait') { await sleep(800); }
    history.push({ step, url: snapshot.url, state: decision.state, action: a, target, ok, note });
  }
  return { outcome: 'error', reason: 'loop exhausted', history, log };
}

async function verify(page, merchant) {
  await page.goto(merchant.accountUrl, { waitUntil: 'load' }); await sleep(300);
  const snapshot = await page.evaluate(snapshotPage, {});
  const { result } = await callFn('classify', { domain: merchant.domain, snapshot });
  return result;
}

async function scenario(browser, name, { offerEnabled, startAt }) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 800 });
  const merchant = { name: 'Streamly (testbed)', domain: '127.0.0.1', accountUrl: `${BASE}/settings/subscription` };
  await login(page, offerEnabled, startAt);
  const before = await verify(page, merchant);
  await page.goto(`${BASE}${startAt}`, { waitUntil: 'load' });
  const res = await hunt(page, merchant);
  const after = await verify(page, merchant);
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('streamly.state')));
  const savings = (before.monthlyPriceUsd != null && after.monthlyPriceUsd != null) ? +((before.monthlyPriceUsd - after.monthlyPriceUsd) * (res.details && res.details.termMonths || 3)).toFixed(2) : null;
  console.log(`\n=== ${name} (offer ${offerEnabled ? 'ON' : 'OFF'}, start ${startAt}) ===`);
  console.log(res.log.join('\n'));
  console.log(`outcome: ${res.outcome}${res.reason ? ' (' + res.reason + ')' : ''}`);
  console.log(`price before → after: $${before.monthlyPriceUsd} → $${after.monthlyPriceUsd}  offerApplied=${after.offerApplied}  savings≈${savings == null ? 'n/a' : '$' + savings}`);
  console.log(`testbed state: cancelled=${state.cancelled} offerApplied=${state.offerApplied}`);
  await page.close();
  return { name, outcome: res.outcome, cancelled: state.cancelled, offerApplied: state.offerApplied, savings };
}

const srv = await serveTestbed();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const results = [];
try {
  results.push(await scenario(browser, 'A: offer on, start at subscription page', { offerEnabled: true, startAt: '/settings/subscription' }));
  results.push(await scenario(browser, 'B: offer OFF (called bluff), start at subscription page', { offerEnabled: false, startAt: '/settings/subscription' }));
  results.push(await scenario(browser, 'C: offer on, start at home (must navigate)', { offerEnabled: true, startAt: '/' }));
} finally { await browser.close(); srv.close(); }

console.log('\n=== SUMMARY ===');
let failed = 0;
for (const r of results) {
  const expectOffer = r.name.startsWith('A') || r.name.startsWith('C');
  const pass = !r.cancelled && (expectOffer ? (r.outcome === 'discount_applied' && r.offerApplied) : (r.outcome === 'no_offer_backed_out' && !r.offerApplied));
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${r.name} → ${r.outcome}, cancelled=${r.cancelled}, offerApplied=${r.offerApplied}, savings=${r.savings}`);
}
process.exit(failed ? 1 : 0);

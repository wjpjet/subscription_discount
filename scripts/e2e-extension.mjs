// End-to-end test of the REAL extension in test mode, against the local testbed.
//   npm run e2e:extension               mock brain, read-only (no cancellation flow opened)
//   npm run e2e:extension -- --find     mock brain, walks the cancellation flow to the offer
//   npm run e2e:extension -- --find --real   real brain from .env (costs a few cents)
//   npm run e2e:extension -- --sensitive     banks & co. are never sent, opened or walked
//
// Builds a test-only copy of the extension (WXT_E2E=1 → .output-e2e/, testbed hosts pre-granted), starts
// the API and Streamly locally, loads the extension into Chrome, signs into Streamly, runs a test-mode
// scan from the actual side panel, then checks the log and that NOTHING was accepted on the site.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { serveTestbed } from './lib/testbed-server.mjs';
import { loginTestbed, sleep } from './lib/driver.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXT = path.join(ROOT, 'extension', '.output-e2e', 'chrome-mv3');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SENSITIVE = process.argv.includes('--sensitive');
const FIND = process.argv.includes('--find') || SENSITIVE, REAL = process.argv.includes('--real'), SHOW = process.argv.includes('--show');
const API_PORT = 8788, TB_PORT = 8081, EMAIL = 'e2e.tester@example.com';
const API = `http://127.0.0.1:${API_PORT}`, TB = `http://localhost:${TB_PORT}`;

let pass = 0, fail = 0;

/** Configure the panel, press Scan like a person, and return the finished test log. */
async function scanOnce(panel, settings) {
  await panel.evaluate(async (settings) => { await chrome.storage.local.remove(['testLog', 'scanResult', 'huntResults']); await chrome.storage.local.set({ settings, consentAt: Date.now() }); }, settings);
  await panel.reload({ waitUntil: 'load' });
  await panel.waitForFunction(() => /Test mode/.test(document.body.innerText), { timeout: 10000 }).catch(() => {});
  await panel.click('::-p-text(Scan my subscriptions)');
  let log = null;
  for (let i = 0; i < 300; i++) { await sleep(1000); log = (await panel.evaluate(async () => (await chrome.storage.local.get('testLog')).testLog)) || null; if (log?.endedAt) break; }
  return log;
}

/** Banks and the like: withheld before discovery, skipped by the page check, never walked. */
async function sensitiveChecks(browser, extId) {
  const site = await browser.newPage();
  await loginTestbed(site, TB, EMAIL);
  await site.goto(`${TB}/?scenario=S001`, { waitUntil: 'load' });
  await site.goto(`${TB}/settings/subscription?bank=1`, { waitUntil: 'load' });   // Streamly now reads like online banking
  const panel = await browser.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'load' });
  const base = { apiBase: API, testMode: true, testFind: true, testPageText: true, skipPayment: true, maxSteps: 20 };

  console.log('\n-- page check: an account page that reads like a bank --');
  let log = await scanOnce(panel, { ...base, restrictedMode: true });
  check('scan finished', !!log?.endedAt, log ? `${log.events.length} events` : 'no log');
  const ev = (k) => (log?.events || []).filter((e) => e.kind === k);
  const pr = ev('probe').find((p) => p.svc === 'localhost');
  check('bank-like page marked sensitive', pr?.status === 'sensitive', `${pr?.status} · ${pr?.sensitive}`);
  check('its text was never sent to the model', !ev('api').some((a) => a.path === '/api/classify' && a.svc === 'localhost'), '');
  check('its text is not in the log either', !pr?.page?.text, '');
  check('no walk was started on it', !ev('find.start').some((e) => e.svc === 'localhost') && !ev('step').some((e) => e.svc === 'localhost'), '');
  const st1 = await site.evaluate(() => JSON.parse(localStorage.getItem('streamly.state') || '{}'));
  check('site untouched', st1.cancelled === false && st1.offerApplied === false && !st1.paused && !st1.downgraded, '');
  await site.goto(`${TB}/settings/subscription?bank=0`, { waitUntil: 'load' });

  console.log('\n-- discovery: signed into banks, irs.gov, Hulu and Netflix --');
  const sess = (domain) => ({ name: 'session_id', value: 'x', domain, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' });
  await browser.defaultBrowserContext().setCookie(sess('.chase.com'), sess('.bankofamerica.com'), sess('.irs.gov'), sess('.navyfederal.org'), sess('.hulu.com'), sess('.netflix.com'));
  log = await scanOnce(panel, { ...base, restrictedMode: false });
  check('scan finished', !!log?.endedAt, log ? `${log.events.length} events` : 'no log');
  const ev2 = (k) => (log?.events || []).filter((e) => e.kind === k);
  const held = (ev2('discover.withheld')[0]?.sites || []).map((x) => x.d);
  const sent = (ev2('discover.cookies')[0]?.sites_sent || []).map((x) => x.d);
  for (const d of ['chase.com', 'bankofamerica.com', 'irs.gov', 'navyfederal.org']) {
    check(`${d} withheld`, held.includes(d), '');
    check(`${d} never sent to the model`, !sent.includes(d), '');
  }
  check('Hulu and Netflix were sent as normal', sent.includes('hulu.com') && sent.includes('netflix.com'), sent.join(', '));
  check('no bank page was opened', !ev2('probe').some((p) => ['chase.com', 'bankofamerica.com', 'irs.gov', 'navyfederal.org'].includes(p.svc)), '');

  const out = path.join(ROOT, 'results', `e2e-test-log-sensitive-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(log, null, 2));
  console.log(`\nlog saved → ${path.relative(ROOT, out)}`);
}
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); ok ? pass++ : fail++; };

console.log(`building the E2E extension (${FIND ? 'find' : 'read-only'}, ${REAL ? 'real brain' : 'mock brain'})…`);
execSync('npx wxt build', { cwd: path.join(ROOT, 'extension'), env: { ...process.env, WXT_E2E: '1', WXT_API_BASE: API }, stdio: 'ignore' });

const tb = await serveTestbed(TB_PORT).catch((e) => { console.error(`testbed port ${TB_PORT} busy? stop "npm run testbed:dev" first. ${e.message}`); process.exit(1); });
const apiEnv = { ...process.env, PORT: String(API_PORT), WALKAWAY_RATE_LIMIT: '0', ...(REAL ? { AI_PROVIDER: 'gemini' } : { WALKAWAY_BRAIN: 'mock' }) };
const api = spawn(process.execPath, [...(REAL ? ['--env-file-if-exists=.env'] : []), 'scripts/api-server.mjs'], { cwd: ROOT, env: apiEnv, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r) => { api.stdout.on('data', (d) => { if (/walkaway api/.test(String(d))) r(); }); setTimeout(r, 4000); });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: !SHOW, pipe: true, enableExtensions: [EXT], args: ['--no-sandbox', '--no-first-run'] });
try {
  // The extension's id, from its service worker.
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  check('extension loaded', !!extId, extId);
  if (SENSITIVE) { await sensitiveChecks(browser, extId); } else {

  // Sign into the local Streamly and pick the scenario with a 50%-for-3-months offer.
  const site = await browser.newPage();
  await loginTestbed(site, TB, EMAIL);
  await site.goto(`${TB}/?scenario=S001`, { waitUntil: 'load' });

  // Open the side panel as a page and configure it: test mode, restricted to the allowlist, local API.
  const panel = await browser.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: 'load' });
  await panel.evaluate(async (settings) => { await chrome.storage.local.clear(); await chrome.storage.local.set({ settings, consentAt: Date.now() }); },
    { apiBase: API, restrictedMode: true, testMode: true, testFind: FIND, testPageText: true, skipPayment: true, maxSteps: 20 });
  await panel.reload({ waitUntil: 'load' });
  // Settings load asynchronously after the page renders; wait for them before reading or clicking.
  await panel.waitForFunction(() => /Test mode/.test(document.body.innerText), { timeout: 10000 }).catch(() => {});
  const idleText = await panel.evaluate(() => document.body.innerText);
  check('idle screen announces test mode', /Test mode/.test(idleText), (idleText.match(/Test mode[^.]*\./) || [''])[0]);

  // Scan, exactly as a person would: press the button.
  const t0 = Date.now();
  await panel.click('::-p-text(Scan my subscriptions)');   // a real, trusted click
  let log = null;
  for (let i = 0; i < 300; i++) { await sleep(1000); log = (await panel.evaluate(async () => (await chrome.storage.local.get('testLog')).testLog)) || null; if (log?.endedAt) break; }
  check('scan finished and the log was closed', !!log?.endedAt, log ? `${log.events.length} events in ${((Date.now() - t0) / 1000).toFixed(0)}s` : 'no log');
  if (!log) throw new Error('no log. Panel shows: ' + (await panel.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 400));

  const out = path.join(ROOT, 'results', `e2e-test-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(log, null, 2));

  const ev = (k) => log.events.filter((e) => e.kind === k);
  check('run metadata recorded', !!log.meta?.extensionVersion && !!log.meta?.settings && log.meta.settings.testMode === true, `v${log.meta?.extensionVersion}`);
  check('no scan error', !ev('run.error').length, ev('run.error')[0]?.error || '');
  check('phases recorded', ev('phase').some((p) => p.phase === 'discover') && ev('phase').some((p) => p.phase === 'pages'), ev('phase').map((p) => p.phase + (p.skipped ? '(skipped)' : '')).join(', '));
  const local = ev('probe').find((p) => p.svc === 'localhost');
  check('local Streamly probed and signed in', local?.status === 'signed_in', `${local?.status} · ${local?.finalUrl}`);
  check('email read from the page', local?.email === EMAIL, local?.email);
  check('price read from the page', Math.abs((local?.monthlyPrice ?? 0) - 17.99) < 0.01, String(local?.monthlyPrice));
  check('probe timing recorded', typeof local?.loadMs === 'number' && typeof local?.classifyMs === 'number' && local?.loadTimedOut === false, `load ${local?.loadMs}ms, classify ${local?.classifyMs}ms`);
  check('page text recorded (and redacted)', typeof local?.page?.text === 'string' && local.page.text.length > 50 && !/\b\d{16}\b/.test(local.page.text), `${local?.page?.text?.length} chars`);
  const hosted = ev('probe').find((p) => p.svc === 'streamly-testbed.netlify.app');
  check('hosted Streamly (not signed in there) reported as a sign-in wall', !hosted || hosted.status === 'login_wall', hosted ? hosted.status : 'not probed (offline?)');
  const calls = ev('api');
  check('API calls recorded with server and network time', calls.length > 0 && calls.every((a) => typeof a.ms === 'number') && calls.some((a) => typeof a.serverMs === 'number'), `${calls.length} calls`);

  if (FIND) {
    const fr = ev('find.result').find((f) => f.svc === 'localhost');
    check('offer found on the local Streamly', fr?.outcome === 'offer_found', fr?.outcome);
    const o = fr?.offer || {};
    const pctOk = o.discountPct != null && Math.abs((o.discountPct > 1 ? o.discountPct / 100 : o.discountPct) - 0.5) < 0.01;
    check('offer terms read: 50% for 3 months', pctOk && o.termMonths === 3, JSON.stringify(o));
    const steps = ev('step').filter((x) => x.svc === 'localhost');
    check('every walk step recorded with state, action and timing', steps.length > 0 && steps.every((x) => x.state && x.action && typeof x.brainMs === 'number'), `${steps.length} steps`);
    check('walk step reasoning recorded', steps.some((x) => typeof x.reasoning === 'string' && x.reasoning.length > 0), (steps.find((x) => x.reasoning) || {}).reasoning?.slice(0, 80));
    check('the final step paused on the offer (find mode)', steps.some((x) => x.terminal && x.action?.outcome === 'offer_found'), '');
  } else {
    const sk = ev('phase').find((p) => p.phase === 'find');
    check('read-only: no cancellation flow opened', sk?.skipped === true && !ev('step').length, `would have walked: ${(sk?.wouldWalk || []).join(', ')}`);
  }

  // The thing that matters most: test mode accepted nothing and cancelled nothing on the site.
  const state = await site.evaluate(() => JSON.parse(localStorage.getItem('streamly.state') || '{}'));
  check('site state: NOT cancelled', state.cancelled === false, '');
  check('site state: NO offer accepted', state.offerApplied === false, '');
  check('site state: no pause or downgrade', !state.paused && !state.downgraded, '');

  // The reveal screen offers the log instead of a run.
  const reveal = await panel.evaluate(() => document.body.innerText);
  check('reveal shows "Download test log" and no way to accept', /Download test log/.test(reveal) && !/Get these discounts/.test(reveal), '');
  check('reveal lists the service with its email', reveal.includes(EMAIL), '');

  console.log(`\nlog saved → ${path.relative(ROOT, out)}\n`);
  console.log(execSync(`node scripts/review-log.mjs "${out}"`, { cwd: ROOT, encoding: 'utf8' }));
  }
} catch (e) {
  check('e2e ran without throwing', false, String(e?.stack || e).slice(0, 600));
} finally {
  await browser.close().catch(() => {}); tb.close(); api.kill();
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

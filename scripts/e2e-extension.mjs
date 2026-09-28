// End-to-end test of the REAL extension in test mode, against the local testbed.
//   npm run e2e:extension               mock brain, read-only (no cancellation flow opened)
//   npm run e2e:extension -- --find     mock brain, walks the cancellation flow to the offer
//   npm run e2e:extension -- --find --real   real brain from .env (costs a few cents)
//   npm run e2e:extension -- --sensitive     banks & co. are never sent, opened or walked
//
// After the main run (not with --sensitive), two more scans: a wrong account URL (/settings/nope on a second host,
// moved.localhost) must still end signed in through the probe's hops, and a team seat (?org=1) must be called a
// work account and never walked. Every log is checked for leaks: the testbed inlines a fake session (csrf token,
// JWT, the email) that must never reach page text or the log, and emails must appear only masked.
//
// Builds a test-only copy of the extension (WXT_E2E=1 → .output-e2e/, testbed hosts pre-granted), starts
// the API and Streamly locally, loads the extension into Chrome, signs into Streamly, runs a test-mode
// scan from the actual side panel, then checks the log and that NOTHING was accepted on the site.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { serveTestbed } from './lib/testbed-server.mjs';
import { loginTestbed, sleep } from './lib/driver.mjs';
import { maskEmail } from '../shared/scrub.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXT = path.join(ROOT, 'extension', '.output-e2e', 'chrome-mv3');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SENSITIVE = process.argv.includes('--sensitive');
const FIND = process.argv.includes('--find') || SENSITIVE, REAL = process.argv.includes('--real'), SHOW = process.argv.includes('--show');
const API_PORT = 8788, TB_PORT = 8081, EMAIL = 'e2e.tester@example.com';
const API = `http://127.0.0.1:${API_PORT}`, TB = `http://localhost:${TB_PORT}`;
const MOVED = 'moved.localhost';   // the same local Streamly on a second host: Chrome resolves *.localhost to this machine

let pass = 0, fail = 0;

/** Configure the panel, press Scan like a person, and return the finished test log. */
async function scanOnce(panel, settings) {
  await panel.evaluate(async (settings) => { await chrome.storage.local.remove(['testLog', 'scanResult', 'huntResults']); await chrome.storage.local.set({ settings, consentAt: Date.now() }); }, settings);
  await panel.bringToFront();   // puppeteer's waitForFunction polls on rAF, which a background tab never runs
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

  console.log('\n-- discovery: signed into banks, irs.gov, the NYT and Duolingo --');
  const sess = (domain) => ({ name: 'session_id', value: 'x', domain, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' });
  await browser.defaultBrowserContext().setCookie(sess('.chase.com'), sess('.bankofamerica.com'), sess('.irs.gov'), sess('.navyfederal.org'), sess('.nytimes.com'), sess('.duolingo.com'));
  log = await scanOnce(panel, { ...base, restrictedMode: false });
  check('scan finished', !!log?.endedAt, log ? `${log.events.length} events` : 'no log');
  const ev2 = (k) => (log?.events || []).filter((e) => e.kind === k);
  const held = (ev2('discover.withheld')[0]?.sites || []).map((x) => x.d);
  const sent = (ev2('discover.cookies')[0]?.sites_sent || []).map((x) => x.d);
  for (const d of ['chase.com', 'bankofamerica.com', 'irs.gov', 'navyfederal.org']) {
    check(`${d} withheld`, held.includes(d), '');
    check(`${d} never sent to the model`, !sent.includes(d), '');
  }
  // Ordinary subscriptions outside the service catalog, so they go to the (mock) model and no real site is opened.
  check('the NYT and Duolingo were sent as normal', ['nytimes.com', 'duolingo.com'].every((d) => !held.includes(d) && sent.includes(d)), sent.join(', '));
  check('no bank page was opened', !ev2('probe').some((p) => ['chase.com', 'bankofamerica.com', 'irs.gov', 'navyfederal.org'].includes(p.svc)), '');

  const out = path.join(ROOT, 'results', `e2e-test-log-sensitive-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(log, null, 2));
  console.log(`\nlog saved → ${path.relative(ROOT, out)}`);
}
/** Nothing secret in a log: each signed-in page's inlined session (csrf token, JWT), any JWT at all, the full test email. */
async function leakChecks(log, sites, label) {
  const json = JSON.stringify(log || {});
  const sts = await Promise.all(sites.map((p) => p.evaluate(() => JSON.parse(localStorage.getItem('streamly.state') || '{}'))));
  check(`${label}: the pages' csrf tokens and session JWTs are not in the log`, sts.every((st) => !!st.csrf && !!st.jwt && !json.includes(st.csrf) && !json.includes(st.jwt)), sts.every((st) => st.csrf) ? '' : 'a testbed state has no session tokens');
  check(`${label}: no JWT anywhere in the log`, !/eyJ[\w-]{8,}\.[\w-]{8,}\./.test(json), '');
  check(`${label}: no full email anywhere in the log (masked only)`, !json.toLowerCase().includes(EMAIL.toLowerCase()), '');
}

/** A wrong account URL finds its way to the plan page; a team seat is a work account and is never walked. */
async function probeChecks(browser, panel, site) {
  const base = { apiBase: API, testMode: true, testPageText: true, skipPayment: true, maxSteps: 20, restrictedMode: true };

  console.log(`\n-- probe: a wrong account URL (${MOVED}/settings/nope) hops to the plan page --`);
  const moved = await browser.newPage();   // a new page is in front: the login form needs it (puppeteer polls on rAF)
  await loginTestbed(moved, `http://${MOVED}:${TB_PORT}`, EMAIL);
  let log = await scanOnce(panel, { ...base, testFind: false, extraAllow: `${MOVED}|Streamly (moved)|http://${MOVED}:${TB_PORT}/settings/nope` });
  check('scan finished', !!log?.endedAt, log ? `${log.events.length} events` : 'no log');
  const mp = (log?.events || []).find((e) => e.kind === 'probe' && e.svc === MOVED);
  check('wrong account URL: the probe still ends signed in', mp?.status === 'signed_in', `${mp?.status} · ${mp?.finalUrl}`);
  check('wrong account URL: the trace shows the hops', (mp?.hops || []).length > 0, (mp?.hops || []).map((h) => `${h.why} → ${h.to}`).join(' · '));
  check('wrong account URL: landed on the plan page with its price', /\/settings\/subscription/.test(mp?.finalUrl || '') && Math.abs((mp?.monthlyPrice ?? 0) - 17.99) < 0.01, `${mp?.finalUrl} · ${mp?.monthlyPrice}`);
  await leakChecks(log, [site, moved], 'wrong-URL scan');
  await moved.close();

  console.log('\n-- work account: team-admin settings (?org=1) are left alone --');
  await site.goto(`${TB}/settings/subscription?org=1`, { waitUntil: 'load' });
  log = await scanOnce(panel, { ...base, testFind: FIND });
  check('scan finished', !!log?.endedAt, log ? `${log.events.length} events` : 'no log');
  const ev = (k) => (log?.events || []).filter((e) => e.kind === k);
  const wp = ev('probe').find((p) => p.svc === 'localhost');
  check('team seat marked work_account', wp?.status === 'work_account', `${wp?.status} · ${wp?.workReason || wp?.classify?.accountType || ''}`);
  const sk = ev('phase').find((p) => p.phase === 'find');
  check('work account never walked', !ev('find.start').some((e) => e.svc === 'localhost') && !ev('step').some((e) => e.svc === 'localhost') && !(sk?.wouldWalk || []).includes('localhost'), `would walk: ${(sk?.wouldWalk || []).join(', ') || 'nothing'}`);
  await leakChecks(log, [site], 'work-account scan');
  await site.goto(`${TB}/settings/subscription?org=0`, { waitUntil: 'load' });
  const st = await site.evaluate(() => JSON.parse(localStorage.getItem('streamly.state') || '{}'));
  check('site untouched by the work-account scan', !st.org && st.cancelled === false && st.offerApplied === false && !st.paused && !st.downgraded, '');
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
  check('classified as the billing page', local?.pageKind === 'account_billing' && local?.siteDomain === 'localhost', `${local?.pageKind} · ${local?.siteDomain}`);
  check('identity: the signed-in email, masked in the log', local?.email === maskEmail(EMAIL) && local?.email !== EMAIL, local?.email);
  check('price read from the page', Math.abs((local?.monthlyPrice ?? 0) - 17.99) < 0.01, String(local?.monthlyPrice));
  check('probe timing recorded', typeof local?.loadMs === 'number' && typeof local?.classifyMs === 'number' && local?.loadTimedOut === false, `load ${local?.loadMs}ms, classify ${local?.classifyMs}ms`);
  check('page judged ready before it was read', local?.ready?.kind === 'ready', `${local?.ready?.kind} in ${local?.ready?.ms}ms`);
  check('page text recorded (and redacted)', typeof local?.page?.text === 'string' && local.page.text.length > 50 && !/\b\d{16}\b/.test(local.page.text), `${local?.page?.text?.length} chars`);
  check('page text has no inlined app state (no {"session" JSON)', typeof local?.page?.text === 'string' && !local.page.text.includes('{"session"') && !/csrfToken|sessionToken/.test(local.page.text), '');
  const recProbe = ev('flow.page').filter((x) => x.svc === 'localhost' && x.phase === 'probe');
  check('the account page is recorded for replay (whole snapshot, scrubbed)', recProbe.length > 0 && recProbe[0].snapshot?.elements?.length > 0 && typeof recProbe[0].snapshot?.text === 'string' && recProbe[0].classify?.pageKind === 'account_billing', `${recProbe.length} page(s)`);
  await leakChecks(log, [site], 'main scan');
  const hosted = ev('probe').find((p) => p.svc === 'streamly-testbed.netlify.app');
  check('hosted Streamly (not signed in there) reported as signed out (or not loaded when offline)', !hosted || hosted.status === 'login_wall' || hosted.status === 'not_loaded', hosted ? `${hosted.status} · ${hosted.pageKind}` : 'not probed');
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
    const recSteps = ev('flow.page').filter((x) => x.svc === 'localhost' && x.phase === 'find');
    check('every walk step is recorded for replay, with its decision', recSteps.length === steps.length && recSteps.every((x) => x.snapshot?.elements && x.action?.type && x.state), `${recSteps.length} recorded, ${steps.length} steps`);
    // The safety lock, in real Chrome: from the tab held on the offer, a POST that names a cancellation never leaves
    // the browser; a GET to the same address and a POST elsewhere still do (the testbed server answers 200 to anything).
    const lockProbe = await panel.evaluate(async () => {
      const r = (await chrome.storage.local.get('scanResult')).scanResult;
      const held = (r?.items || []).find((i) => i.paused);
      if (!held) return { held: false };
      const rules = await chrome.declarativeNetRequest.getSessionRules();
      const [res] = await chrome.scripting.executeScript({ target: { tabId: held.paused.tabId }, world: 'MAIN', func: async () => {
        const go = async (method, p) => { try { return (await fetch(p, { method, body: method === 'GET' ? undefined : '{}' })).status; } catch { return 'blocked'; } };
        return { cancelPost: await go('POST', '/api/subscription/cancel'), cancelGet: await go('GET', '/api/subscription/cancel'), surveyPost: await go('POST', '/api/survey') };
      } });
      return { held: true, tabId: held.paused.tabId, rules: rules.map((x) => ({ id: x.id, tabIds: x.condition?.tabIds })), ...res.result };
    });
    check('safety lock: the held tab has its rule', lockProbe.held && lockProbe.rules.some((x) => (x.tabIds || []).includes(lockProbe.tabId)), JSON.stringify(lockProbe));
    check('safety lock: a POST to a cancel address from the held tab is blocked', lockProbe.cancelPost === 'blocked', JSON.stringify(lockProbe));
    check('safety lock: a GET to the same address and a POST to a survey still go through', lockProbe.cancelGet === 200 && lockProbe.surveyPost === 200, JSON.stringify(lockProbe));
    check('safety lock: the log shows it engaged on the walk', ev('netlock.on').some((x) => x.svc === 'localhost'), JSON.stringify(ev('netlock.error').concat(ev('netlock.unavailable'))).slice(0, 400));
  } else {
    const sk = ev('phase').find((p) => p.phase === 'find');
    check('read-only: no cancellation flow opened', sk?.skipped === true && !ev('step').length, `would have walked: ${(sk?.wouldWalk || []).join(', ')}`);
    check('read-only: the confirmed plan would have been walked', (sk?.wouldWalk || []).includes('localhost'), '');
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
  const report = execSync(`node scripts/review-log.mjs "${out}"`, { cwd: ROOT, encoding: 'utf8' });
  console.log(report);
  check('review-log prints no full email', !report.toLowerCase().includes(EMAIL.toLowerCase()), '');

  await probeChecks(browser, panel, site);
  }
} catch (e) {
  check('e2e ran without throwing', false, String(e?.stack || e).slice(0, 600));
} finally {
  await browser.close().catch(() => {}); tb.close(); api.kill();
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

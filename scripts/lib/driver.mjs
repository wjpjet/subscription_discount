// Drives one hunt against a page the way the extension does: snapshot → /api/agent-step → guardrails → act.
import { snapshotPage, performAction, readElement } from '../../shared/page-scripts.js';
import { isFinalizeClick } from '../../shared/guardrails.js';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const ZERO = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, calls: 0 };
function add(acc, u) { if (acc && u) { acc.inputTokens += u.inputTokens || 0; acc.outputTokens += u.outputTokens || 0; acc.thinkingTokens += u.thinkingTokens || 0; acc.calls += u.calls || 1; } }
/** Sign in to the testbed (email → password → code) with a clean state. */
export async function loginTestbed(page, base, email = 'suite@example.com') {
  await page.goto(`${base}/login`, { waitUntil: 'load' });
  await page.evaluate(() => { localStorage.clear(); document.cookie = 'streamly_session=; path=/; max-age=0'; document.cookie = 'streamly_uid=; path=/; max-age=0'; });
  await page.goto(`${base}/login`, { waitUntil: 'load' });
  await page.type('#email', email); await page.type('#password', 'walkaway'); await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#code', { timeout: 5000 });
  await page.type('#code', '424242');
  await Promise.all([page.waitForNavigation({ timeout: 5000 }).catch(() => {}), page.click('#code-form button[type=submit]')]);
}
/** Wall-clock ms for every function call this process has made: { name, ms, ok }. Read by scripts/latency.mjs. */
export const timings = [];
export async function callFn(name, body, acc) {
  const mod = await import(`../../netlify/functions/${name}.mjs`);
  const t0 = Date.now();
  let ok = true, res;
  try {
    res = await mod.default(new Request(`http://local/api/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), {});
  } catch (e) { ok = false; timings.push({ name, ms: Date.now() - t0, ok }); throw e; }
  const j = await res.json();
  if (j.error) ok = false;
  timings.push({ name, ms: Date.now() - t0, ok });
  if (j.error) throw new Error(`${name}: ${j.error}`);
  add(acc, j.usage); return j;
}
async function settle(page) { await Promise.race([page.waitForNavigation({ timeout: 2500 }).catch(() => {}), sleep(900)]); await sleep(400); }

/**
 * Drive one loop the way the extension does. goal 'find' pauses in front of the accept button and returns
 * outcome offer_found with acceptId/acceptText (nothing accepted); goal 'hunt' accepts and finishes.
 */
export async function hunt(page, merchant, maxSteps = 20, acc, opts = {}) {
  const goal = opts.goal || 'hunt';
  const history = opts.history ? [...opts.history] : [], log = opts.log ? [...opts.log] : []; let t0 = Date.now();
  for (let step = opts.startStep || 0; step <= maxSteps; step++) {
    const snapshot = await page.evaluate(snapshotPage, {});
    const { decision, guardrails, proposed } = await callFn('agent-step', { runId: 'suite', merchant, goal, step, maxSteps, history, snapshot, priorPath: opts.priorPath || null }, acc);
    const a = decision.action;
    const target = a.id != null ? (snapshot.elements.find((e) => e.id === a.id) || {}).text : undefined;
    log.push(`  step ${step} [${decision.state}] ${proposed.type}${proposed.id != null ? ' #' + proposed.id : ''} → ${a.type}${a.outcome ? ':' + a.outcome : ''}${target ? ` "${target}"` : ''}${guardrails.length ? '  ⛔ ' + guardrails.join('; ') : ''}  @ ${new URL(snapshot.url).pathname}`);
    let ok = true, note = '';
    if (a.type === 'finish' || a.type === 'back_out') {
      history.push({ step, url: snapshot.url, state: decision.state, action: a, target, note: guardrails.join('; ') });
      let outcome = a.type === 'finish' ? a.outcome : 'no_offer_backed_out';
      if (a.type === 'back_out' && /^ai_declined/.test(a.reason || '')) outcome = 'ai_declined';
      const base = { outcome, details: a.details || null, reason: a.reason || null, offer: a.offer || null, history, log, steps: step + 1, ms: Date.now() - t0 };
      if (outcome === 'offer_found') return { ...base, acceptId: a.id ?? null, acceptText: target || '', url: snapshot.url };
      return base;
    }
    if (a.type === 'click' || a.type === 'accept_offer') {
      const live = await page.evaluate(readElement, a.id);
      if (!live || isFinalizeClick(live.text, snapshot.text)) { note = 'client guard refused click'; history.push({ step, url: snapshot.url, state: decision.state, action: a, target, ok: false, note }); return { outcome: 'no_offer_backed_out', reason: note, history, log, steps: step + 1, ms: Date.now() - t0 }; }
      const r = await page.evaluate(performAction, { type: 'click', id: a.id }); ok = r.ok; note = r.note; await settle(page);
    } else if (a.type === 'type' || a.type === 'select' || a.type === 'scroll') { const r = await page.evaluate(performAction, a); ok = r.ok; note = r.note; await sleep(350); }
    else if (a.type === 'navigate') { await page.goto(a.url, { waitUntil: 'load' }).catch(() => { ok = false; }); }
    else await sleep(700);
    history.push({ step, url: snapshot.url, state: decision.state, action: a, target, ok, note });
  }
  return { outcome: 'error', reason: 'loop exhausted', history, log, steps: maxSteps + 1, ms: Date.now() - t0 };
}

/** Phase two on the same page: press the recorded accept button (guarded), then let the hunt loop finish. */
export async function acceptPaused(page, merchant, found, maxSteps = 20, acc) {
  const t0 = Date.now();
  const snapshot = await page.evaluate(snapshotPage, {});
  const want = (found.acceptText || '').trim();
  const el = snapshot.elements.find((e) => e.id === found.acceptId && (e.text || '').trim() === want) || snapshot.elements.find((e) => want && (e.text || '').trim() === want);
  const log = [...found.log];
  if (!el || isFinalizeClick(el.text, snapshot.text)) { log.push(`  accept: recorded button not found or refused ("${want}")`); return { outcome: 'error', reason: 'accept button not found on the paused screen', history: found.history, log, steps: found.steps, ms: Date.now() - t0, phase: 'accept' }; }
  const live = await page.evaluate(readElement, el.id);
  if (!live || isFinalizeClick(live.text, snapshot.text)) { log.push('  accept: client guard refused click'); return { outcome: 'no_offer_backed_out', reason: 'client guard refused click', history: found.history, log, steps: found.steps, ms: Date.now() - t0, phase: 'accept' }; }
  const r = await page.evaluate(performAction, { type: 'click', id: el.id }); await settle(page);
  log.push(`  accept: clicked "${el.text}" (${r.ok ? 'ok' : r.note})`);
  const rec = { step: found.steps, url: snapshot.url, state: 'save_offer_presented', action: { type: 'accept_offer', id: el.id, offer: found.offer || null }, target: el.text, ok: r.ok, note: 'accepted from pause' };
  const res = await hunt(page, merchant, maxSteps, acc, { goal: 'hunt', startStep: found.steps + 1, history: [...found.history.filter((h) => h.action && h.action.type !== 'finish'), rec], log });
  return { ...res, phase: 'accept', ms: Date.now() - t0 };
}

export async function classifyPage(page, merchant, acc) {
  await page.goto(merchant.accountUrl, { waitUntil: 'load' }); await sleep(300);
  const snapshot = await page.evaluate(snapshotPage, {});
  return (await callFn('classify', { domain: merchant.domain, snapshot }, acc)).result;
}

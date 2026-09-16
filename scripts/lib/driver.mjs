// Drives one hunt against a page the way the extension does: snapshot → /api/agent-step → guardrails → act.
import { snapshotPage, performAction, readElement } from '../../shared/page-scripts.js';
import { isFinalizeText } from '../../shared/guardrails.js';
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
export async function callFn(name, body, acc) {
  const mod = await import(`../../netlify/functions/${name}.mjs`);
  const res = await mod.default(new Request(`http://local/api/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), {});
  const j = await res.json(); if (j.error) throw new Error(`${name}: ${j.error}`); add(acc, j.usage); return j;
}
async function settle(page) { await Promise.race([page.waitForNavigation({ timeout: 2500 }).catch(() => {}), sleep(900)]); await sleep(400); }

export async function hunt(page, merchant, maxSteps = 20, acc) {
  const history = [], log = []; let t0 = Date.now();
  for (let step = 0; step <= maxSteps; step++) {
    const snapshot = await page.evaluate(snapshotPage, { maxElements: 100, textChars: 3000 });
    const { decision, guardrails, proposed } = await callFn('agent-step', { runId: 'suite', merchant, goal: 'hunt', step, maxSteps, history, snapshot }, acc);
    const a = decision.action;
    const target = a.id != null ? (snapshot.elements.find((e) => e.id === a.id) || {}).text : undefined;
    log.push(`  step ${step} [${decision.state}] ${proposed.type}${proposed.id != null ? ' #' + proposed.id : ''} → ${a.type}${target ? ` "${target}"` : ''}${guardrails.length ? '  ⛔ ' + guardrails.join('; ') : ''}  @ ${new URL(snapshot.url).pathname}`);
    let ok = true, note = '';
    if (a.type === 'finish' || a.type === 'back_out') {
      history.push({ step, url: snapshot.url, state: decision.state, action: a, target, note: guardrails.join('; ') });
      let outcome = a.type === 'finish' ? a.outcome : 'no_offer_backed_out';
      if (a.type === 'back_out' && /^ai_declined/.test(a.reason || '')) outcome = 'ai_declined';
      return { outcome, details: a.details || null, reason: a.reason || null, history, log, steps: step + 1, ms: Date.now() - t0 };
    }
    if (a.type === 'click' || a.type === 'accept_offer') {
      const live = await page.evaluate(readElement, a.id);
      if (!live || isFinalizeText(live.text)) { note = 'client guard refused click'; history.push({ step, url: snapshot.url, state: decision.state, action: a, target, ok: false, note }); return { outcome: 'no_offer_backed_out', reason: note, history, log, steps: step + 1, ms: Date.now() - t0 }; }
      const r = await page.evaluate(performAction, { type: 'click', id: a.id }); ok = r.ok; note = r.note; await settle(page);
    } else if (a.type === 'type' || a.type === 'select' || a.type === 'scroll') { const r = await page.evaluate(performAction, a); ok = r.ok; note = r.note; await sleep(350); }
    else if (a.type === 'navigate') { await page.goto(a.url, { waitUntil: 'load' }).catch(() => { ok = false; }); }
    else await sleep(700);
    history.push({ step, url: snapshot.url, state: decision.state, action: a, target, ok, note });
  }
  return { outcome: 'error', reason: 'loop exhausted', history, log, steps: maxSteps + 1, ms: Date.now() - t0 };
}

export async function classifyPage(page, merchant, acc) {
  await page.goto(merchant.accountUrl, { waitUntil: 'load' }); await sleep(300);
  const snapshot = await page.evaluate(snapshotPage, {});
  return (await callFn('classify', { domain: merchant.domain, snapshot }, acc)).result;
}

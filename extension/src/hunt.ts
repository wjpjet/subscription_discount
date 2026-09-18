/**
 * Two phases per service, one tab.
 *
 *   FIND (during the scan)  Walk the cancellation flow until an offer is on screen, then PAUSE with the
 *                           tab left open. The backend turns the model's accept_offer into "offer found"
 *                           and records which button it would have pressed. Nothing is accepted.
 *   ACCEPT (after payment)  In that same tab, re-read the recorded button, run the click-time guard,
 *                           press it, continue to the confirmation, then verify on the billing page.
 *                           If the tab is gone, re-walk from the account page with the found path as a
 *                           hint to the model.
 *
 * The backend applies the guardrails; they are re-applied here as defense in depth, and the live button
 * text is re-read at the moment of clicking. "Confirm cancellation" is never clickable anywhere.
 */
import { snapshotPage, readElement, performAction } from '../../shared/page-scripts.js';
import { isFinalizeClick, isAcceptText, applyGuardrails } from '../../shared/guardrails.js';
import { mockClassify } from '../../shared/brain-mock.js';
import { apiPost, apiAvailable } from './api';
import { openTab, waitForLoad, runInTab, closeTab, sleep, tabUrl, navigateTab, tabAlive, focusTab } from './tabs';
import type { Settings } from './settings';
import type { ScanItem } from './scan';
import type { AgentAction, Decision, FinishDetails, Offer, PageClass, StepResponse } from './types';
import { isBlocked, hostOf } from './lists';

export interface HuntStep { step: number; url: string; state: string; action: AgentAction; target?: string; ok?: boolean; note?: string; guardrails?: string[]; ts: number }
/** Where a find left off: the open tab and the accept button it stopped in front of. */
export interface PausedAt { tabId: number; url: string; acceptId: number; acceptText: string }
export interface FindResult { outcome: string; reason?: string | null; offer: Offer | null; paused: PausedAt | null; path: HuntStep[]; error?: string }
export interface HuntResult { domain: string; name: string; outcome: string; reason?: string | null; details?: FinishDetails | null; before?: PageClass | null; after?: PageClass | null; savingsUsd: number | null; termMonths: number | null; steps: HuntStep[]; phase?: 'accept' | 'rewalk'; error?: string }
export type HuntEvent =
  | { type: 'start'; item: ScanItem; tabId: number }
  | { type: 'step'; item: ScanItem; step: HuntStep }
  | { type: 'verify'; item: ScanItem }
  | { type: 'found'; item: ScanItem; result: FindResult }
  | { type: 'done'; item: ScanItem; result: HuntResult };

let stopRequested = false;
export function requestStop() { stopRequested = true; }

type Goal = 'find' | 'hunt';
interface LoopOpts { goal: Goal; startStep?: number; history?: HuntStep[]; priorPath?: string[] | null }
interface LoopOut { outcome: string; reason: string | null; details: FinishDetails | null; offer: Offer | null; acceptId: number | null; acceptText: string | null; url: string }

const merchantOf = (item: ScanItem) => ({ name: item.name, domain: item.domain, accountUrl: item.accountUrl });

/** One decision-act loop on an open tab. Shared by find, accept and the re-walk fallback. */
async function runLoop(tabId: number, item: ScanItem, settings: Settings, onEvent: (e: HuntEvent) => void, steps: HuntStep[], opts: LoopOpts): Promise<LoopOut> {
  const merchant = merchantOf(item);
  const maxSteps = settings.maxSteps || 25;
  const history: HuntStep[] = opts.history ? [...opts.history] : [];
  const out: LoopOut = { outcome: 'error', reason: 'step budget exhausted', details: null, offer: null, acceptId: null, acceptText: null, url: '' };
  for (let step = opts.startStep || 0; step <= maxSteps; step++) {
    if (stopRequested) { out.outcome = 'error'; out.reason = 'stopped by user'; break; }
    const snapshot = await runInTab(tabId, snapshotPage, [{ maxElements: 100, textChars: 3000 }]);
    out.url = snapshot.url;
    if (isBlocked(hostOf(snapshot.url), settings.extraBlock)) { out.outcome = 'error'; out.reason = 'landed on a blocklisted site — stopped'; break; }
    const res = await stepWithRetry({ runId: `${item.domain}-${Date.now()}`, merchant, goal: opts.goal, step, maxSteps, history, snapshot, priorPath: opts.priorPath || null });
    const local = applyGuardrails({ decision: res.decision as Decision, snapshot, history, merchantDomain: item.domain, step, maxSteps, goal: opts.goal });
    const decision: Decision = local.decision;
    const a = decision.action;
    const target = a.id != null ? (snapshot.elements.find((e) => e.id === a.id)?.text) : undefined;
    const rec: HuntStep = { step, url: snapshot.url, state: decision.state, action: a, target, guardrails: [...res.guardrails, ...local.notes], ts: Date.now() };

    if (a.type === 'finish' || a.type === 'back_out') {
      rec.ok = true; steps.push(rec); history.push(rec); onEvent({ type: 'step', item, step: rec });
      out.outcome = a.type === 'finish' ? (a.outcome || 'error') : 'no_offer_backed_out';
      out.reason = a.reason || null; out.details = a.details || null; out.offer = a.offer || null;
      if (a.type === 'finish' && a.outcome === 'offer_found') { out.acceptId = a.id ?? null; out.acceptText = target ?? null; }
      if (a.type === 'back_out' && /^ai_declined/.test(a.reason || '')) out.outcome = 'ai_declined';
      break;
    }
    if (a.type === 'click' || a.type === 'accept_offer') {
      const live = await runInTab(tabId, readElement, [a.id]);
      if (!live || isFinalizeClick(live.text, snapshot.text)) { rec.ok = false; rec.note = 'refused at click time: finalize/decline text or final-confirmation page'; steps.push(rec); history.push(rec); onEvent({ type: 'step', item, step: rec }); out.outcome = 'no_offer_backed_out'; out.reason = rec.note; break; }
      const r = await runInTab(tabId, performAction, [{ type: 'click', id: a.id }]); rec.ok = r.ok; rec.note = r.note;
      await settleTab(tabId);
    } else if (a.type === 'type' || a.type === 'select' || a.type === 'scroll') {
      const r = await runInTab(tabId, performAction, [a]); rec.ok = r.ok; rec.note = r.note; await sleep(400);
    } else if (a.type === 'navigate' && a.url) {
      await navigateTab(tabId, a.url); await sleep(800); rec.ok = true;
    } else { await sleep(900); rec.ok = true; }
    steps.push(rec); history.push(rec); onEvent({ type: 'step', item, step: rec });
  }
  return out;
}

// ---------------------------------------------------------------- FIND (scan)

export async function findOne(item: ScanItem, settings: Settings, onEvent: (e: HuntEvent) => void): Promise<FindResult> {
  const steps: HuntStep[] = [];
  const result: FindResult = { outcome: 'error', reason: null, offer: null, paused: null, path: steps };
  let tabId: number | undefined;
  try {
    if (!(await apiAvailable())) throw new Error('No API URL configured — open Settings (⚙).');
    if (isBlocked(item.domain, settings.extraBlock) || isBlocked(hostOf(item.accountUrl), settings.extraBlock)) throw new Error('blocklisted site — never explored');
    tabId = await openTab(item.accountUrl, false);   // the scan always works in the background
    onEvent({ type: 'start', item, tabId });
    await waitForLoad(tabId); await sleep(1200);
    const out = await runLoop(tabId, item, settings, onEvent, steps, { goal: 'find' });
    result.outcome = out.outcome; result.reason = out.reason; result.offer = out.offer;
    if (out.outcome === 'offer_found') {
      if (out.acceptId != null) result.paused = { tabId, url: out.url, acceptId: out.acceptId, acceptText: out.acceptText || '' };
      else { result.outcome = 'error'; result.reason = 'offer reported without an accept button'; }
    }
  } catch (e: any) {
    result.outcome = 'error'; result.error = String(e?.message || e); result.reason = 'brain unavailable';
  } finally {
    // Only a paused tab stays open, and only so the accept can happen on the very screen that was found.
    if (tabId !== undefined && !result.paused) await closeTab(tabId);
  }
  onEvent({ type: 'found', item, result });
  return result;
}

/** Find offers on several services at once; each one is its own background tab. */
export async function findAll(items: ScanItem[], settings: Settings, onEvent: (e: HuntEvent) => void, concurrency = 3): Promise<Map<string, FindResult>> {
  stopRequested = false;
  const out = new Map<string, FindResult>();
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length && !stopRequested) { const item = queue.shift()!; out.set(item.id, await findOne(item, settings, onEvent)); }
  }));
  return out;
}

/** Close the tabs left open for services the user did not pick. Nothing is clicked. */
export async function closePaused(items: ScanItem[]): Promise<void> {
  for (const i of items) if (i.paused) { await closeTab(i.paused.tabId); i.paused = null; }
}

// ---------------------------------------------------------------- ACCEPT (after payment)

export async function acceptAll(items: ScanItem[], settings: Settings, onEvent: (e: HuntEvent) => void): Promise<HuntResult[]> {
  stopRequested = false;
  const results: HuntResult[] = [];
  for (const item of items) {
    if (stopRequested) break;
    results.push(await acceptOne(item, settings, onEvent));
  }
  return results;
}

export async function acceptOne(item: ScanItem, settings: Settings, onEvent: (e: HuntEvent) => void): Promise<HuntResult> {
  const steps: HuntStep[] = [];
  const result: HuntResult = { domain: item.domain, name: item.name, outcome: 'error', before: item.before, savingsUsd: null, termMonths: null, steps, phase: 'accept' };
  let tabId: number | undefined = item.paused?.tabId;
  try {
    if (!(await apiAvailable())) throw new Error('No API URL configured — open Settings (⚙).');
    if (isBlocked(item.domain, settings.extraBlock) || isBlocked(hostOf(item.accountUrl), settings.extraBlock)) throw new Error('blocklisted site — never explored');

    let accepted = false;
    if (item.paused && tabId != null && (await tabAlive(tabId))) {
      onEvent({ type: 'start', item, tabId });
      if (settings.watch) await focusTab(tabId);
      // Re-read the recorded accept button: same id if its text is unchanged, otherwise the same text.
      const snapshot = await runInTab(tabId, snapshotPage, [{ maxElements: 100, textChars: 3000 }]);
      const want = item.paused.acceptText.trim();
      const el = snapshot.elements.find((e) => e.id === item.paused!.acceptId && (e.text || '').trim() === want)
        || snapshot.elements.find((e) => (e.text || '').trim() === want && want.length > 0);
      const looksRight = !!el && !isFinalizeClick(el.text, snapshot.text) && (isAcceptText(el.text) || (el.text || '').trim() === want);
      if (el && looksRight) {
        const live = await runInTab(tabId, readElement, [el.id]);
        if (live && !isFinalizeClick(live.text, snapshot.text)) {
          const r = await runInTab(tabId, performAction, [{ type: 'click', id: el.id }]);
          const rec: HuntStep = { step: 0, url: snapshot.url, state: 'save_offer_presented', action: { type: 'accept_offer', id: el.id, offer: item.offer }, target: el.text, ok: r.ok, note: 'accepted the offer found during the scan', ts: Date.now() };
          steps.push(rec); onEvent({ type: 'step', item, step: rec });
          await settleTab(tabId);
          if (r.ok) {
            accepted = true;
            const out = await runLoop(tabId, item, settings, onEvent, steps, { goal: 'hunt', startStep: 1, history: [rec] });
            result.outcome = out.outcome; result.reason = out.reason; result.details = out.details;
          }
        }
      }
    }
    if (!accepted) {
      // The tab is gone or the screen changed under us: walk again from the account page, with the
      // route the find phase took as a hint. Same guardrails, same loop.
      result.phase = 'rewalk';
      if (tabId != null && (await tabAlive(tabId))) await navigateTab(tabId, item.accountUrl);
      else tabId = await openTab(item.accountUrl, settings.watch);
      onEvent({ type: 'start', item, tabId });
      await waitForLoad(tabId); await sleep(1200);
      const priorPath = (item.path || []).filter((s) => s.action.type !== 'finish').map((s) => `${s.state}: ${s.action.type}${s.target ? ` "${s.target.slice(0, 60)}"` : ''} @ ${s.url}`);
      const out = await runLoop(tabId, item, settings, onEvent, steps, { goal: 'hunt', priorPath });
      result.outcome = out.outcome; result.reason = out.reason; result.details = out.details;
    }

    // Verify on the account page, whatever happened.
    onEvent({ type: 'verify', item });
    await navigateTab(tabId!, item.accountUrl); await sleep(1200);
    const snap = await runInTab(tabId!, snapshotPage, [{ maxElements: 80, textChars: 4000 }]);
    const after = (await apiPost<{ result: PageClass }>('/api/classify', { domain: item.domain, snapshot: snap }).catch(() => ({ result: mockClassify(snap) }))).result;
    result.after = after;
    const before = item.before?.monthlyPriceUsd ?? item.monthlyPrice;
    const term = result.details?.termMonths ?? (result.outcome === 'discount_applied' ? item.termMonths : null);
    if (result.outcome === 'discount_applied') {
      if (!after.offerApplied && (before == null || after.monthlyPriceUsd == null || after.monthlyPriceUsd >= before)) {
        result.outcome = 'error'; result.reason = 'could not verify a lower price on the billing page';
      } else if (before != null && after.monthlyPriceUsd != null) {
        result.termMonths = term; result.savingsUsd = +(((before - after.monthlyPriceUsd) * (term || 1))).toFixed(2);
      } else { result.termMonths = term; result.savingsUsd = result.details?.savingsUsd ?? null; }
    }
  } catch (e: any) {
    // Nothing is ever clicked without a decision: an outage or a refused API call ends the run here.
    result.outcome = 'error'; result.error = String(e?.message || e); result.reason = 'brain unavailable';
  } finally {
    item.paused = null;
    if (tabId !== undefined && !settings.watch) await closeTab(tabId);
  }
  onEvent({ type: 'done', item, result });
  return result;
}

/** The brain is remote; retry transient failures before giving up. No decision → no click. */
async function stepWithRetry(body: unknown): Promise<StepResponse> {
  let last: any;
  for (let i = 0; i < 3; i++) {
    try { return await apiPost<StepResponse>('/api/agent-step', body); }
    catch (e: any) { last = e; if (/unauthorized|No API URL/i.test(String(e?.message))) break; if (i < 2) await sleep(1500 * (i + 1)); }
  }
  throw new Error(`brain unavailable: ${String(last?.message || last)}`);
}

async function settleTab(tabId: number) {
  const before = await tabUrl(tabId);
  await sleep(700);
  const after = await tabUrl(tabId);
  if (before !== after) await waitForLoad(tabId, 8000);
  await sleep(500);
}

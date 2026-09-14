/**
 * The Hunt: for one service, drive a merchant tab step by step. The backend brain proposes each action;
 * guardrails run server-side and again here (the final "confirm cancellation" is never clickable).
 */
import { snapshotPage, readElement, performAction } from '../../shared/page-scripts.js';
import { isFinalizeText, applyGuardrails } from '../../shared/guardrails.js';
import { mockClassify } from '../../shared/brain-mock.js';
import { apiPost, apiAvailable } from './api';
import { openTab, waitForLoad, runInTab, closeTab, sleep, tabUrl, navigateTab } from './tabs';
import type { Settings } from './settings';
import type { ScanItem } from './scan';
import type { AgentAction, Decision, FinishDetails, PageClass, StepResponse } from './types';

export interface HuntStep { step: number; url: string; state: string; action: AgentAction; target?: string; ok?: boolean; note?: string; guardrails?: string[]; ts: number }
export interface HuntResult { domain: string; name: string; outcome: string; reason?: string | null; details?: FinishDetails | null; before?: PageClass | null; after?: PageClass | null; savingsUsd: number | null; termMonths: number | null; steps: HuntStep[]; error?: string }
export type HuntEvent = { type: 'start'; item: ScanItem; tabId: number } | { type: 'step'; item: ScanItem; step: HuntStep } | { type: 'verify'; item: ScanItem } | { type: 'done'; item: ScanItem; result: HuntResult };

let stopRequested = false;
export function requestStop() { stopRequested = true; }

export async function huntAll(items: ScanItem[], settings: Settings, onEvent: (e: HuntEvent) => void): Promise<HuntResult[]> {
  stopRequested = false;
  const results: HuntResult[] = [];
  for (const item of items) {
    if (stopRequested) break;
    results.push(await huntOne(item, settings, onEvent));
  }
  return results;
}

export async function huntOne(item: ScanItem, settings: Settings, onEvent: (e: HuntEvent) => void): Promise<HuntResult> {
  const merchant = { name: item.name, domain: item.domain, accountUrl: item.accountUrl };
  const steps: HuntStep[] = [];
  const history: any[] = [];
  const maxSteps = settings.maxSteps || 25;
  let tabId: number | undefined;
  const result: HuntResult = { domain: item.domain, name: item.name, outcome: 'error', before: item.before, savingsUsd: null, termMonths: null, steps };
  try {
    if (!(await apiAvailable())) throw new Error('No API URL configured — open Settings (⚙).');
    tabId = await openTab(item.accountUrl, settings.watch);
    onEvent({ type: 'start', item, tabId });
    await waitForLoad(tabId); await sleep(1200);

    for (let step = 0; step <= maxSteps; step++) {
      if (stopRequested) { result.outcome = 'error'; result.reason = 'stopped by user'; break; }
      const snapshot = await runInTab(tabId, snapshotPage, [{ maxElements: 100, textChars: 3000 }]);
      const res = await stepWithRetry({ runId: `${item.domain}-${Date.now()}`, merchant, goal: 'hunt', step, maxSteps, history, snapshot });
      // Defense in depth: re-apply the guardrails locally too.
      const local = applyGuardrails({ decision: res.decision as Decision, snapshot, history, merchantDomain: item.domain, step, maxSteps, goal: 'hunt' });
      const decision: Decision = local.decision;
      const a = decision.action;
      const target = a.id != null ? (snapshot.elements.find((e) => e.id === a.id)?.text) : undefined;
      const rec: HuntStep = { step, url: snapshot.url, state: decision.state, action: a, target, guardrails: [...res.guardrails, ...local.notes], ts: Date.now() };

      if (a.type === 'finish' || a.type === 'back_out') {
        rec.ok = true; steps.push(rec); history.push(rec); onEvent({ type: 'step', item, step: rec });
        result.outcome = a.type === 'finish' ? (a.outcome || 'error') : 'no_offer_backed_out';
        result.reason = a.reason || null; result.details = a.details || null;
        if (a.type === 'back_out' && /^ai_declined/.test(a.reason || '')) result.outcome = 'ai_declined';
        break;
      }
      if (a.type === 'click' || a.type === 'accept_offer') {
        const live = await runInTab(tabId, readElement, [a.id]);
        if (!live || isFinalizeText(live.text)) { rec.ok = false; rec.note = 'refused at click time: finalize/decline text'; steps.push(rec); history.push(rec); onEvent({ type: 'step', item, step: rec }); result.outcome = 'no_offer_backed_out'; result.reason = rec.note; break; }
        const r = await runInTab(tabId, performAction, [{ type: 'click', id: a.id }]); rec.ok = r.ok; rec.note = r.note;
        await settle(tabId);
      } else if (a.type === 'type' || a.type === 'select' || a.type === 'scroll') {
        const r = await runInTab(tabId, performAction, [a]); rec.ok = r.ok; rec.note = r.note; await sleep(400);
      } else if (a.type === 'navigate' && a.url) {
        await navigateTab(tabId, a.url); await sleep(800); rec.ok = true;
      } else { await sleep(900); rec.ok = true; }
      steps.push(rec); history.push(rec); onEvent({ type: 'step', item, step: rec });
      if (step === maxSteps) { result.outcome = 'error'; result.reason = 'step budget exhausted'; }
    }

    // Verify on the account page, whatever happened.
    onEvent({ type: 'verify', item });
    await navigateTab(tabId, item.accountUrl); await sleep(1200);
    const snap = await runInTab(tabId, snapshotPage, [{ maxElements: 80, textChars: 4000 }]);
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

async function settle(tabId: number) {
  const before = await tabUrl(tabId);
  await sleep(700);
  const after = await tabUrl(tabId);
  if (before !== after) await waitForLoad(tabId, 8000);
  await sleep(500);
}

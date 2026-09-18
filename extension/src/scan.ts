/**
 * The Scan, in three passes:
 *   1. discover  — which signed-in domains are subscription services (domain names only leave the browser)
 *   2. classify  — open each account page in a background tab and read the real plan, price and email
 *   3. find      — walk each confirmed subscription's cancellation flow up to the loyalty offer and PAUSE
 *                  there, tab left open. Nothing is accepted. The reveal screen shows what was actually
 *                  found, not a guess.
 */
import { browser } from '#imports';
import { snapshotPage } from '../../shared/page-scripts.js';
import { mockClassify } from '../../shared/brain-mock.js';
import { apiAvailable, apiPost } from './api';
import { discoverCandidates, type Candidate } from './discovery';
import { openTab, waitForLoad, runInTab, closeTab, sleep } from './tabs';
import { findAll, closePaused, type HuntStep, type PausedAt } from './hunt';
import { money } from './format';
import type { Settings } from './settings';
import type { Offer, PageClass } from './types';

export type ItemStatus = 'signed_in' | 'login_wall' | 'no_paid_plan' | 'unknown' | 'error';
export interface ScanItem {
  id: string; domain: string; name: string; accountUrl: string; source: string; status: ItemStatus;
  monthlyPrice: number | null; planName: string | null; email: string | null; offerApplied: boolean; confidence: number;
  /** From the find pass. hasOffer is true only when an offer was actually seen. */
  hasOffer: boolean; offer: Offer | null; offerText: string; findOutcome: string | null; findReason?: string | null; paused: PausedAt | null; path: HuntStep[];
  estSavings: number; termMonths: number; discountPct: number;
  url?: string; note?: string; before: PageClass | null;
}
export interface ScanProgress { phase: 'discover' | 'pages' | 'find' | 'done'; done: number; total: number; current?: string; message?: string }
export interface ScanResult { at: number; restrictedMode: boolean; domainsChecked: number; items: ScanItem[]; found: number; withOffers: number; totalEstSavings: number }

const CONCURRENCY = 4, FIND_CONCURRENCY = 3, SETTLE_MS = 1500, PAGE_TIMEOUT_MS = 20000;

export async function runScan(settings: Settings, onProgress: (p: ScanProgress) => void): Promise<ScanResult> {
  await browser.storage.local.set({ scanRunning: true });
  try {
    onProgress({ phase: 'discover', done: 0, total: 0, message: 'Discovering…' });
    const { candidates, domainsChecked } = await discoverCandidates(settings, (message) => onProgress({ phase: 'discover', done: 0, total: 0, message }));
    const useApi = await apiAvailable();
    const items: ScanItem[] = [];
    let done = 0;
    onProgress({ phase: 'pages', done, total: candidates.length });
    const queue = [...candidates];
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const c = queue.shift()!;
        onProgress({ phase: 'pages', done, total: candidates.length, current: c.name });
        items.push(await probe(c, useApi));
        done++;
        onProgress({ phase: 'pages', done, total: candidates.length, current: c.name });
      }
    }));

    // Pass 3: find the offers. Only confirmed, paid, not-already-discounted subscriptions are walked.
    const subs = items.filter((i) => i.status === 'signed_in' && !i.offerApplied);
    let fdone = 0;
    onProgress({ phase: 'find', done: 0, total: subs.length, message: 'Looking for loyalty offers…' });
    const found = await findAll(subs, settings, (e) => {
      if (e.type === 'start') onProgress({ phase: 'find', done: fdone, total: subs.length, current: e.item.name });
      else if (e.type === 'found') { fdone++; onProgress({ phase: 'find', done: fdone, total: subs.length, current: e.item.name }); }
    }, FIND_CONCURRENCY);
    for (const i of subs) {
      const f = found.get(i.id); if (!f) continue;
      i.findOutcome = f.outcome; i.findReason = f.reason ?? null; i.offer = f.offer; i.paused = f.paused; i.path = f.path;
      i.hasOffer = f.outcome === 'offer_found' && !!f.paused;
      const sv = offerSavings(f.offer, i.monthlyPrice);
      i.estSavings = i.hasOffer ? sv.savingsUsd : 0; i.termMonths = sv.termMonths; i.discountPct = sv.discountPct; i.offerText = i.hasOffer ? sv.text : '';
      if (!i.hasOffer) i.note = f.outcome === 'no_offer_backed_out' ? 'no offer this time' : f.outcome === 'blocked_needs_you' ? 'needs you to sign in' : f.outcome === 'ai_declined' ? 'left alone' : (f.reason || f.error || 'could not check');
    }

    items.sort((a, b) => b.estSavings - a.estSavings || a.name.localeCompare(b.name));
    const foundItems = items.filter((i) => i.status === 'signed_in' || i.status === 'unknown');
    const offers = foundItems.filter((i) => i.hasOffer);
    const result: ScanResult = { at: Date.now(), restrictedMode: settings.restrictedMode, domainsChecked, items, found: foundItems.length, withOffers: offers.length, totalEstSavings: Math.round(offers.reduce((s, i) => s + i.estSavings, 0)) };
    await browser.storage.local.set({ scanResult: result });
    onProgress({ phase: 'done', done: candidates.length, total: candidates.length });
    return result;
  } finally { await browser.storage.local.set({ scanRunning: false }); }
}

/** Forget a scan: close any tabs still paused on an offer screen (nothing is clicked), then clear storage. */
export async function discardScan(result: ScanResult | null): Promise<void> {
  if (result) await closePaused(result.items);
  await browser.storage.local.remove(['scanResult', 'huntResults']);
}

async function probe(c: Candidate, useApi: boolean): Promise<ScanItem> {
  const base: ScanItem = { id: c.domain, domain: c.domain, name: c.name, accountUrl: c.accountUrl, source: c.source, status: 'unknown', monthlyPrice: null, planName: null, email: null, offerApplied: false, confidence: c.confidence, hasOffer: false, offer: null, offerText: '', findOutcome: null, paused: null, path: [], estSavings: 0, termMonths: 0, discountPct: 0, before: null };
  let tabId: number | undefined;
  try {
    tabId = await openTab(c.accountUrl, false);
    await waitForLoad(tabId, PAGE_TIMEOUT_MS);
    await sleep(SETTLE_MS);
    const snap = await runInTab(tabId, snapshotPage, [{ maxElements: 80, textChars: 4000 }]);
    base.url = snap?.url;
    const cls: PageClass = useApi ? (await apiPost<{ result: PageClass }>('/api/classify', { domain: c.domain, snapshot: snap })).result : mockClassify(snap);
    base.before = cls;
    if (!cls.signedIn) return { ...base, status: 'login_wall' };
    if (cls.hasPaidPlan === false) return { ...base, status: 'no_paid_plan' };
    base.status = 'signed_in';
    base.monthlyPrice = cls.monthlyPriceUsd; base.planName = cls.planName; base.email = cls.accountEmail ?? null; base.offerApplied = cls.offerApplied;
    if (cls.offerApplied) base.note = 'a promotional price is already applied';
    return base;
  } catch (e: any) {
    return { ...base, status: 'error', note: String(e?.message || e) };
  } finally { if (tabId !== undefined) await closeTab(tabId); }
}

/** Turn an observed offer into money and a one-line description in the service's own shape. */
export function offerSavings(o: Offer | null, price: number | null): { savingsUsd: number; termMonths: number; discountPct: number; text: string } {
  if (!o) return { savingsUsd: 0, termMonths: 0, discountPct: 0, text: '' };
  const r = (n: number) => +n.toFixed(2);
  const p = price ?? 0;
  let pct = o.discountPct ?? 0; if (pct > 1) pct = pct / 100;
  const term = o.termMonths ?? 0;
  if (o.newMonthlyPriceUsd != null && p > 0 && o.newMonthlyPriceUsd < p) {
    return { savingsUsd: r((p - o.newMonthlyPriceUsd) * Math.max(1, term)), termMonths: term, discountPct: r(1 - o.newMonthlyPriceUsd / p), text: `${money(o.newMonthlyPriceUsd)}/mo instead of ${money(p)}${term ? ` for ${term} month${term === 1 ? '' : 's'}` : ''}` };
  }
  if (o.freeMonths && p > 0) {
    return { savingsUsd: r(p * o.freeMonths), termMonths: o.freeMonths, discountPct: 1, text: `${o.freeMonths} free month${o.freeMonths === 1 ? '' : 's'} on ${money(p)}/mo` };
  }
  if (pct > 0 && p > 0) {
    return { savingsUsd: r(p * pct * Math.max(1, term)), termMonths: term, discountPct: pct, text: `${Math.round(pct * 100)}% off${term ? ` for ${term} month${term === 1 ? '' : 's'}` : ''} on ${money(p)}/mo` };
  }
  return { savingsUsd: 0, termMonths: term, discountPct: pct, text: o.description || 'offer terms unclear' };
}

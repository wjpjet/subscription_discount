/** The Scan: discover candidates → read each account page in a background tab → classify → estimate. */
import { browser } from '#imports';
import { snapshotPage } from '../../shared/page-scripts.js';
import { mockClassify } from '../../shared/brain-mock.js';
import { apiAvailable, apiPost } from './api';
import { discoverCandidates, type Candidate } from './discovery';
import { openTab, waitForLoad, runInTab, closeTab, sleep } from './tabs';
import type { Settings } from './settings';
import type { PageClass } from './types';

export type ItemStatus = 'signed_in' | 'login_wall' | 'no_paid_plan' | 'unknown' | 'error';
export interface ScanItem { id: string; domain: string; name: string; accountUrl: string; source: string; status: ItemStatus; hasOffer: boolean; monthlyPrice: number | null; planName: string | null; offerApplied: boolean; estSavings: number; termMonths: number; discountPct: number; confidence: number; url?: string; note?: string; before: PageClass | null }
export interface ScanProgress { phase: 'discover' | 'pages' | 'done'; done: number; total: number; current?: string; message?: string }
export interface ScanResult { at: number; testMode: boolean; domainsChecked: number; items: ScanItem[]; found: number; withOffers: number; totalEstSavings: number }

const CONCURRENCY = 2, SETTLE_MS = 1500, PAGE_TIMEOUT_MS = 20000;

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
    items.sort((a, b) => b.estSavings - a.estSavings || a.name.localeCompare(b.name));
    const found = items.filter((i) => i.status === 'signed_in' || i.status === 'unknown');
    const offers = found.filter((i) => i.hasOffer);
    const result: ScanResult = { at: Date.now(), testMode: settings.testMode, domainsChecked, items, found: found.length, withOffers: offers.length, totalEstSavings: Math.round(offers.reduce((s, i) => s + i.estSavings, 0)) };
    await browser.storage.local.set({ scanResult: result });
    onProgress({ phase: 'done', done: candidates.length, total: candidates.length });
    return result;
  } finally { await browser.storage.local.set({ scanRunning: false }); }
}

async function probe(c: Candidate, useApi: boolean): Promise<ScanItem> {
  const base: ScanItem = { id: c.domain, domain: c.domain, name: c.name, accountUrl: c.accountUrl, source: c.source, status: 'unknown', hasOffer: c.makesOffers === 'likely', monthlyPrice: null, planName: null, offerApplied: false, estSavings: 0, termMonths: c.playbook?.typicalTermMonths ?? 3, discountPct: c.playbook?.typicalDiscountPct ?? 0.5, confidence: c.confidence, before: null };
  let tabId: number | undefined;
  try {
    tabId = await openTab(c.accountUrl, false);
    await waitForLoad(tabId, PAGE_TIMEOUT_MS);
    await sleep(SETTLE_MS);
    const snap = await runInTab(tabId, snapshotPage, [{ maxElements: 80, textChars: 4000 }]);
    base.url = snap?.url;
    const cls: PageClass = useApi ? (await apiPost<{ result: PageClass }>('/api/classify', { domain: c.domain, snapshot: snap })).result : mockClassify(snap);
    base.before = cls;
    if (!cls.signedIn) return { ...base, status: 'login_wall', hasOffer: false };
    if (cls.hasPaidPlan === false) return { ...base, status: 'no_paid_plan', hasOffer: false };
    base.status = 'signed_in';
    base.monthlyPrice = cls.monthlyPriceUsd; base.planName = cls.planName; base.offerApplied = cls.offerApplied;
    if (cls.offerApplied) { base.hasOffer = false; base.note = 'a promotional price is already applied'; }
    if (base.hasOffer) { const price = cls.monthlyPriceUsd ?? c.typicalPrice ?? 15; base.estSavings = Math.round(price * base.discountPct * base.termMonths); }
    return base;
  } catch (e: any) {
    return { ...base, status: 'error', hasOffer: false, note: String(e?.message || e) };
  } finally { if (tabId !== undefined) await closeTab(tabId); }
}

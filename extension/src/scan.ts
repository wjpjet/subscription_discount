/**
 * The Scan, in three passes, reported live so the list fills in as it goes:
 *   1. discover  — which signed-in domains are subscription services (domain names only leave the browser)
 *   2. classify  — open each account page in a background tab and read the real plan, price and email
 *   3. find      — walk each confirmed subscription's cancellation flow up to the loyalty offer and PAUSE
 *                  there, tab left open. Nothing is accepted. The reveal screen shows what was actually
 *                  found, not a guess.
 * Every item carries a `live` line in plain words ("Answering the survey…", "No offer this time — left
 * alone") so the person can follow what is happening to each service while it happens.
 */
import { browser } from '#imports';
import { snapshotPage } from '../../shared/page-scripts.js';
import { mockClassify } from '../../shared/brain-mock.js';
import { apiAvailable, apiPost } from './api';
import { discoverCandidates, type Candidate } from './discovery';
import { openTab, waitForLoad, runInTab, closeTab, sleep } from './tabs';
import { findAll, closePaused, type FindResult, type HuntStep, type PausedAt } from './hunt';
import { money } from './format';
import type { Settings } from './settings';
import type { Offer, PageClass } from './types';

export type ItemStatus = 'checking' | 'signed_in' | 'login_wall' | 'no_paid_plan' | 'unknown' | 'error';
export interface ScanItem {
  id: string; domain: string; name: string; accountUrl: string; source: string; status: ItemStatus;
  monthlyPrice: number | null; cycleCharge: number | null; cadence: string; renewalDate: string | null; isTrial: boolean; trialEndsOn: string | null; priceAfterTrial: number | null;
  planName: string | null; email: string | null; offerApplied: boolean; confidence: number;
  /** From the find pass. hasOffer is true only when an offer was actually seen. */
  hasOffer: boolean; offer: Offer | null; offerText: string; findOutcome: string | null; findReason?: string | null; paused: PausedAt | null; path: HuntStep[];
  estSavings: number; termMonths: number; discountPct: number;
  /** What is happening to this service right now, in plain words. */
  live?: string;
  url?: string; note?: string; before: PageClass | null;
}
export interface ScanProgress { phase: 'discover' | 'pages' | 'find' | 'done'; done: number; total: number; current?: string; message?: string; items: ScanItem[]; totalEstSavings: number }
export interface ScanResult { at: number; restrictedMode: boolean; domainsChecked: number; items: ScanItem[]; found: number; withOffers: number; totalEstSavings: number }

const CONCURRENCY = 4, FIND_CONCURRENCY = 3, SETTLE_MS = 1500, PAGE_TIMEOUT_MS = 20000;

/** Still being worked on: the account page is being read, or the find pass hasn't reported yet. */
export const isBusy = (i: ScanItem) => i.status === 'checking' || (i.status === 'signed_in' && !i.offerApplied && i.findOutcome == null);
const order = (a: ScanItem, b: ScanItem) => (Number(b.hasOffer) - Number(a.hasOffer)) || (Number(isBusy(b)) - Number(isBusy(a))) || (b.estSavings - a.estSavings) || a.name.localeCompare(b.name);

export async function runScan(settings: Settings, onProgress: (p: ScanProgress) => void): Promise<ScanResult> {
  await browser.storage.local.set({ scanRunning: true });
  const items: ScanItem[] = [];
  const emit = (p: Omit<ScanProgress, 'items' | 'totalEstSavings'>) => onProgress({ ...p, items: [...items].sort(order), totalEstSavings: +items.filter((i) => i.hasOffer).reduce((s, i) => s + i.estSavings, 0).toFixed(2) });
  try {
    emit({ phase: 'discover', done: 0, total: 0, message: 'Discovering…' });
    const { candidates, domainsChecked } = await discoverCandidates(settings, (message) => emit({ phase: 'discover', done: 0, total: 0, message }));
    const useApi = await apiAvailable();
    let done = 0;
    emit({ phase: 'pages', done, total: candidates.length });
    const queue = [...candidates];
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const c = queue.shift()!;
        const item = blank(c); items.push(item);
        emit({ phase: 'pages', done, total: candidates.length, current: c.name });
        await probe(item, c, useApi);
        done++;
        emit({ phase: 'pages', done, total: candidates.length, current: c.name });
      }
    }));

    // Pass 3: find the offers. Only confirmed, paid, not-already-discounted subscriptions are walked.
    const subs = items.filter((i) => i.status === 'signed_in' && !i.offerApplied);
    let fdone = 0;
    emit({ phase: 'find', done: 0, total: subs.length, message: 'Looking for loyalty offers…' });
    const found = await findAll(subs, settings, (e) => {
      if (e.type === 'start') { e.item.live = 'Starting the cancellation flow…'; emit({ phase: 'find', done: fdone, total: subs.length, current: e.item.name }); }
      else if (e.type === 'step') { e.item.live = liveText(e.step); emit({ phase: 'find', done: fdone, total: subs.length, current: e.item.name }); }
      else if (e.type === 'found') { applyFind(e.item, e.result); fdone++; emit({ phase: 'find', done: fdone, total: subs.length, current: e.item.name }); }
    }, FIND_CONCURRENCY);
    for (const i of subs) { const f = found.get(i.id); if (f && i.findOutcome == null) applyFind(i, f); }

    items.sort(order);
    const foundItems = items.filter((i) => i.status === 'signed_in' || i.status === 'unknown');
    const offers = foundItems.filter((i) => i.hasOffer);
    const result: ScanResult = { at: Date.now(), restrictedMode: settings.restrictedMode, domainsChecked, items, found: foundItems.length, withOffers: offers.length, totalEstSavings: Math.round(offers.reduce((s, i) => s + i.estSavings, 0)) };
    await browser.storage.local.set({ scanResult: result });
    emit({ phase: 'done', done: candidates.length, total: candidates.length });
    return result;
  } finally { await browser.storage.local.set({ scanRunning: false }); }
}

/** Forget a scan: close any tabs still paused on an offer screen (nothing is clicked), then clear storage. */
export async function discardScan(result: ScanResult | null): Promise<void> {
  if (result) await closePaused(result.items);
  await browser.storage.local.remove(['scanResult', 'huntResults']);
}

function blank(c: Candidate): ScanItem {
  return { id: c.domain, domain: c.domain, name: c.name, accountUrl: c.accountUrl, source: c.source, status: 'checking', monthlyPrice: null, cycleCharge: null, cadence: 'unknown', renewalDate: null, isTrial: false, trialEndsOn: null, priceAfterTrial: null, planName: null, email: null, offerApplied: false, confidence: c.confidence, hasOffer: false, offer: null, offerText: '', findOutcome: null, paused: null, path: [], estSavings: 0, termMonths: 0, discountPct: 0, live: 'Opening the account page…', before: null };
}

/** Read one account page and fill the item in place. */
async function probe(item: ScanItem, c: Candidate, useApi: boolean): Promise<void> {
  let tabId: number | undefined;
  try {
    tabId = await openTab(c.accountUrl, false);
    await waitForLoad(tabId, PAGE_TIMEOUT_MS);
    await sleep(SETTLE_MS);
    item.live = 'Reading the account page…';
    const snap = await runInTab(tabId, snapshotPage, [{ maxElements: 80, textChars: 4000 }]);
    item.url = snap?.url;
    const cls: PageClass = useApi ? (await apiPost<{ result: PageClass }>('/api/classify', { domain: c.domain, snapshot: snap })).result : mockClassify(snap);
    item.before = cls;
    if (!cls.signedIn) { item.status = 'login_wall'; item.live = 'Not signed in here'; return; }
    if (cls.hasPaidPlan === false) { item.status = 'no_paid_plan'; item.live = 'No paid plan on this account'; return; }
    item.status = 'signed_in';
    item.monthlyPrice = cls.monthlyPriceUsd; item.planName = cls.planName; item.email = cls.accountEmail ?? null; item.offerApplied = cls.offerApplied;
    item.cycleCharge = cls.cycleChargeUsd ?? null; item.cadence = cls.cadence || 'unknown'; item.renewalDate = cls.renewalDate ?? null;
    item.isTrial = !!cls.isTrial; item.trialEndsOn = cls.trialEndsOn ?? null; item.priceAfterTrial = cls.priceAfterTrialUsd ?? null;
    if (cls.offerApplied) { item.note = 'a promotional price is already applied'; item.live = 'A promo price is already applied — left alone'; }
    else item.live = `Signed in${item.monthlyPrice != null ? ` · ${money(item.monthlyPrice)}/mo` : ''} · waiting to look for an offer`;
  } catch (e: any) {
    item.status = 'error'; item.note = String(e?.message || e); item.live = "Couldn't open the account page";
  } finally { if (tabId !== undefined) await closeTab(tabId); }
}

/** Record what the find pass saw, and say it in plain words. */
function applyFind(i: ScanItem, f: FindResult): void {
  i.findOutcome = f.outcome; i.findReason = f.reason ?? null; i.offer = f.offer; i.paused = f.paused; i.path = f.path;
  i.hasOffer = f.outcome === 'offer_found' && !!f.paused;
  const sv = offerSavings(f.offer, i.isTrial && i.priceAfterTrial != null ? i.priceAfterTrial : i.monthlyPrice);
  i.estSavings = i.hasOffer ? sv.savingsUsd : 0; i.termMonths = sv.termMonths; i.discountPct = sv.discountPct; i.offerText = i.hasOffer ? sv.text : '';
  if (i.hasOffer) { i.live = `Offer found: ${sv.text} — holding it for you`; return; }
  i.note = f.outcome === 'no_offer_backed_out' ? 'no offer this time' : f.outcome === 'blocked_needs_you' ? 'needs you to sign in' : f.outcome === 'ai_declined' ? 'left alone' : (f.reason || f.error || 'could not check');
  i.live = f.outcome === 'no_offer_backed_out' ? `No offer from ${i.name} this time — backed out, nothing changed`
    : f.outcome === 'blocked_needs_you' ? 'Needs you to sign in — left alone'
    : f.outcome === 'ai_declined' ? 'Left alone'
    : `Couldn't check${f.reason ? ` — ${f.reason}` : ''}`;
}

const PHRASE: Record<string, string> = {
  login: 'Hit a sign-in page',
  account_home: 'On the account home, looking for subscription settings',
  settings: 'In settings, looking for the subscription',
  subscription_page: 'On the subscription page',
  cancel_entry: 'Starting the cancellation flow',
  reason_survey: 'Answering the "why are you leaving?" survey',
  save_offer_presented: 'An offer appeared, reading the terms',
  offer_accepted_confirmation: 'Offer confirmed',
  about_to_finalize_cancel: 'Reached the final step with no offer, backing out',
  cancellation_completed: 'Backing out',
  other: 'Looking around',
  ambiguous: 'Not sure what this screen is, backing out',
};
/** One step of a walk, as a person would describe it. */
export function liveText(s: HuntStep): string {
  const a = s.action;
  if (a.type === 'back_out') return 'Backing out — nothing was changed';
  if (a.type === 'finish') return a.outcome === 'offer_found' ? 'Offer found' : a.outcome === 'blocked_needs_you' ? 'Needs you to sign in' : 'Done';
  const held = (s.guardrails || []).find((g) => /^refused/.test(g));
  if (held) return `Held back: would not press "${(s.target || '').slice(0, 40)}"`;
  const doing = a.type === 'click' && s.target ? ` · pressing "${s.target.slice(0, 40)}"` : a.type === 'accept_offer' ? ' · reading the offer' : a.type === 'type' ? ' · filling in the form' : a.type === 'select' ? ' · choosing an option' : a.type === 'scroll' ? ' · scrolling' : a.type === 'navigate' ? ' · opening a page' : a.type === 'wait' ? ' · waiting for the page' : '';
  return `Step ${s.step + 1}: ${PHRASE[s.state] || 'Working'}${doing}`;
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

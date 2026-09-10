/**
 * The Scan (runs in the background service worker).
 *  1. Cookie presence check per playbook domain — local, instant, presence only.
 *  2. For candidates: open the account page in a BACKGROUND tab, read plan/price, close the tab.
 *  3. Estimate savings over the offer term for services that make in-flow offers.
 * Nothing about the user's browsing leaves the browser: no history access, no cookie values,
 * no page content is sent anywhere in this build.
 */
import { browser } from '#imports';
import { PLAYBOOKS, type Playbook } from './playbooks';

export type ItemStatus = 'not_signed_in' | 'signed_in' | 'login_wall' | 'no_paid_plan' | 'unknown' | 'error';
export type Cadence = 'month' | 'year' | 'week';

export interface ScanItem {
  id: string;
  name: string;
  status: ItemStatus;
  hasOffer: boolean;
  cookieHit: boolean;
  price?: number;
  cadence?: Cadence;
  monthlyPrice?: number;
  /** Estimated savings over the offer term (USD) — 0 when the service makes no offers. */
  estSavings: number;
  termMonths: number;
  confidence: number;
  url?: string;
  note?: string;
}

export interface ScanProgress {
  phase: 'cookies' | 'pages' | 'done';
  done: number;
  total: number;
  current?: string;
}

export interface ScanResult {
  at: number;
  items: ScanItem[];
  found: number;
  withOffers: number;
  totalEstSavings: number;
}

interface PageExtract {
  url: string;
  title: string;
  hasPassword: boolean;
  textSample: string;
  prices: { amount: number; unit: string; index: number }[];
  hints: { signedIn: string[]; noPlan: string[]; loginWall: string[] };
}

const PAGE_TIMEOUT_MS = 20000;
const SETTLE_MS = 1800;
const RETRY_MS = 2500;
const CONCURRENCY = 2;

export async function runScan(onProgress: (p: ScanProgress) => void): Promise<ScanResult> {
  await browser.storage.local.set({ scanRunning: true });
  try {
    onProgress({ phase: 'cookies', done: 0, total: PLAYBOOKS.length });
    const items: ScanItem[] = [];
    const candidates: Playbook[] = [];
    for (const pb of PLAYBOOKS) {
      if (await cookieHit(pb)) candidates.push(pb);
      else items.push(baseItem(pb, 'not_signed_in', false));
    }

    let done = 0;
    onProgress({ phase: 'pages', done, total: candidates.length });
    const queue = [...candidates];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const pb = queue.shift()!;
        onProgress({ phase: 'pages', done, total: candidates.length, current: pb.name });
        items.push(await probe(pb));
        done++;
        onProgress({ phase: 'pages', done, total: candidates.length, current: pb.name });
      }
    });
    await Promise.all(workers);

    const order = new Map(PLAYBOOKS.map((p, i) => [p.id, i]));
    items.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

    const found = items.filter((i) => i.status === 'signed_in' || i.status === 'unknown');
    const offers = found.filter((i) => i.hasOffer);
    const result: ScanResult = {
      at: Date.now(),
      items,
      found: found.length,
      withOffers: offers.length,
      totalEstSavings: Math.round(offers.reduce((s, i) => s + i.estSavings, 0)),
    };
    await browser.storage.local.set({ scanResult: result });
    onProgress({ phase: 'done', done: candidates.length, total: candidates.length });
    return result;
  } finally {
    await browser.storage.local.set({ scanRunning: false });
  }
}

async function cookieHit(pb: Playbook): Promise<boolean> {
  try {
    const names = new Set<string>();
    for (const d of pb.domains) {
      const cookies = await browser.cookies.getAll({ domain: d });
      for (const c of cookies) names.add(c.name);
    }
    if (pb.sessionCookieNames && pb.sessionCookieNames.length) return pb.sessionCookieNames.some((n) => names.has(n));
    return names.size > 0;
  } catch {
    return false;
  }
}

async function probe(pb: Playbook): Promise<ScanItem> {
  let tabId: number | undefined;
  try {
    const tab = await browser.tabs.create({ url: pb.accountUrl, active: false });
    tabId = tab.id;
    if (tabId === undefined) throw new Error('no tab id');
    await waitForLoad(tabId, PAGE_TIMEOUT_MS);
    await sleep(SETTLE_MS);
    let ex = await extract(tabId, pb);
    const weak = !ex || (ex.hints.signedIn.length === 0 && ex.prices.length === 0 && !ex.hasPassword);
    if (weak) {
      await sleep(RETRY_MS);
      ex = (await extract(tabId, pb)) ?? ex;
    }
    return classify(pb, ex);
  } catch (e: any) {
    return { ...baseItem(pb, 'error', true), note: String(e?.message || e) };
  } finally {
    if (tabId !== undefined) {
      try { await browser.tabs.remove(tabId); } catch { /* already closed */ }
    }
  }
}

async function extract(tabId: number, pb: Playbook): Promise<PageExtract | null> {
  const cfg = { signedInHints: pb.signedInHints, noPlanHints: pb.noPlanHints ?? [], loginHints: ['sign in', 'log in', 'login'] };
  const res = await browser.scripting.executeScript({ target: { tabId }, func: extractPage, args: [cfg] });
  return (res?.[0]?.result as PageExtract | undefined) ?? null;
}

/** Runs INSIDE the merchant page. Must be self-contained (it is serialized). Reads only. */
function extractPage(cfg: { signedInHints: string[]; noPlanHints: string[]; loginHints: string[] }) {
  const body = document.body as HTMLElement | null;
  const text = (body && body.innerText) || '';
  const lower = text.toLowerCase();
  const prices: { amount: number; unit: string; index: number }[] = [];
  const re = /(?:US)?\$\s?(\d{1,4}(?:\.\d{2})?)\s*(?:\/|per\s*|a\s*|each\s*)?\s*(month|mo\b|year|yr\b|annually|week|wk\b)?/gi;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(text)) && guard++ < 200) {
    prices.push({ amount: parseFloat(m[1]), unit: (m[2] || '').toLowerCase(), index: m.index });
  }
  const has = (arr: string[]) => arr.filter((h) => lower.indexOf(h.toLowerCase()) !== -1);
  return {
    url: location.href,
    title: document.title,
    hasPassword: !!document.querySelector('input[type="password"]'),
    textSample: text.slice(0, 3000),
    prices,
    hints: { signedIn: has(cfg.signedInHints), noPlan: has(cfg.noPlanHints), loginWall: has(cfg.loginHints) },
  };
}

function classify(pb: Playbook, ex: PageExtract | null): ScanItem {
  const base = baseItem(pb, 'unknown', true);
  if (!ex) return { ...base, note: 'no page data' };
  base.url = ex.url;
  const urlLower = ex.url.toLowerCase();
  const loginByUrl = (pb.loginUrlPatterns ?? []).some((p) => urlLower.includes(p.toLowerCase()));
  const signedIn = ex.hints.signedIn.length;
  const noPlan = ex.hints.noPlan.length;

  if (loginByUrl || (ex.hasPassword && signedIn === 0)) return { ...base, status: 'login_wall', estSavings: 0 };
  if (noPlan > 0 && signedIn === 0) return { ...base, status: 'no_paid_plan', estSavings: 0 };

  const monthly = pickMonthly(ex.prices);
  if (signedIn > 0 || monthly) {
    const item: ScanItem = { ...base, status: 'signed_in', monthlyPrice: monthly?.monthly, price: monthly?.amount, cadence: monthly?.cadence };
    item.estSavings = estimate(pb, item.monthlyPrice);
    return item;
  }
  return { ...base, note: 'signed-in state unclear' };
}

function pickMonthly(prices: PageExtract['prices']): { amount: number; cadence: Cadence; monthly: number } | undefined {
  const plausible = prices.filter((p) => p.amount >= 1 && p.amount <= 500);
  const month = plausible.find((p) => p.unit === 'month' || p.unit === 'mo');
  if (month) return { amount: month.amount, cadence: 'month', monthly: month.amount };
  const year = plausible.find((p) => p.unit === 'year' || p.unit === 'yr' || p.unit === 'annually');
  if (year) return { amount: year.amount, cadence: 'year', monthly: +(year.amount / 12).toFixed(2) };
  const week = plausible.find((p) => p.unit === 'week' || p.unit === 'wk');
  if (week) return { amount: week.amount, cadence: 'week', monthly: +(week.amount * 4.33).toFixed(2) };
  return undefined;
}

function estimate(pb: Playbook, monthly?: number): number {
  if (!pb.hasInflowOffer) return 0;
  const price = monthly ?? pb.typicalPrice;
  return Math.round(price * pb.typicalDiscountPct * pb.typicalTermMonths);
}

function baseItem(pb: Playbook, status: ItemStatus, cookieHit: boolean): ScanItem {
  const counts = status === 'signed_in' || status === 'unknown';
  return {
    id: pb.id,
    name: pb.name,
    status,
    hasOffer: pb.hasInflowOffer,
    cookieHit,
    estSavings: counts ? estimate(pb) : 0,
    termMonths: pb.typicalTermMonths,
    confidence: pb.confidence,
  };
}

function waitForLoad(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      browser.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id: number, info: any) => {
      if (id === tabId && info && info.status === 'complete') finish();
    };
    browser.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
    browser.tabs.get(tabId).then((t) => { if (t.status === 'complete') finish(); }).catch(finish);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

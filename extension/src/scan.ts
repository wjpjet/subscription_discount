/**
 * The Scan, in three passes, reported live so the list fills in as it goes:
 *   1. discover  — which signed-in domains are subscription services (domain names only leave the browser)
 *   2. classify  — open each account page in a background tab, wait until it has really rendered, and read
 *                  the real plan, price and email. A 404 or error page falls back to the next known URL or
 *                  the site root; a signed-in page that doesn't show the plan follows its own Billing /
 *                  Membership link (by URL, never a click). At most 2 extra hops per service.
 *   3. find      — walk each CONFIRMED paid personal subscription's cancellation flow up to the loyalty offer
 *                  and PAUSE there, tab left open. Nothing is accepted. The reveal screen shows what was
 *                  actually found, not a guess.
 * Every item carries a `live` line in plain words ("Answering the survey…", "No offer this time — left
 * alone") so the person can follow what is happening to each service while it happens.
 */
import { browser } from '#imports';
import { snapshotPage, type PageSnapshot } from '../../shared/page-scripts.js';
import { mockClassify } from '../../shared/brain-mock.js';
import { etld1, hostMatches } from '../../shared/domains.js';
import { orgAccountReason, isIdpHost, isLoginUrl, hasSignInControl, isConsumerEmail } from '../../shared/accounts.js';
import { isFinalizeText, CANCELLED_RE } from '../../shared/guardrails.js';
import { scrubUrl, scrubSecrets, scrubPii, redactForLog } from '../../shared/scrub.js';
import { financialPageReason } from '../../shared/sensitive.js';
import { apiAvailable, apiPost } from './api';
import { discoverCandidates, type Candidate } from './discovery';
import { openTab, waitForPage, waitForContent, runInTab, closeTab, navigateTab, sleep, classifyTabError, closeOrphanTabs, ownedPausedTab } from './tabs';
import { findAll, closePaused, type FindResult, type HuntStep, type PausedAt } from './hunt';
import { trace, snapSummary, maskForLog, recordPage } from './trace';
import { hostOf, blockReason } from './lists';
import { money } from './format';
import type { Settings } from './settings';
import type { Offer, PageClass } from './types';

export type ItemStatus = 'checking' | 'signed_in' | 'unconfirmed' | 'billed_elsewhere' | 'no_paid_plan' | 'login_wall' | 'wrong_page'
  | 'not_loaded' | 'needs_you' | 'work_account' | 'duplicate' | 'error' | 'sensitive';
/** Counted as "subscriptions found". billed_elsewhere is paid, but through Apple, a carrier or a bundle: never walked. */
export const PAYING: ItemStatus[] = ['signed_in', 'billed_elsewhere'];
/** Shown as "Needs a look": we couldn't tell, and the person can open the page and see. */
export const NEEDS_LOOK: ItemStatus[] = ['unconfirmed', 'wrong_page', 'not_loaded', 'needs_you', 'error'];
export interface ScanItem {
  id: string; domain: string; name: string; accountUrl: string; source: string; status: ItemStatus;
  monthlyPrice: number | null; cycleCharge: number | null; cadence: string; renewalDate: string | null; isTrial: boolean; trialEndsOn: string | null; priceAfterTrial: number | null;
  planName: string | null; email: string | null; offerApplied: boolean; confidence: number;
  /** Display name of the signed-in account, when the page shows one. */
  accountName: string | null;
  /** An email a SIGN-IN page had pre-filled: it doesn't prove a session, so it is never `email`. */
  rememberedEmail: string | null;
  /** Registrable domain the account page actually landed on (the walk's site; duplicates share it). */
  siteDomain: string | null;
  /** Other signed-in domains for the same account and bill; their names show as "also: …". */
  aliases: string[];
  /** Fallback account URLs, tried in order when the first one is a 404 or error page. */
  altUrls: string[];
  /** Set when this item is the same account as another item (status 'duplicate'). */
  dupOf: string | null;
  pageKind: string | null; billedVia: string | null;
  /** Signed in with a different personal email than the one most of the paid services use. Informational only. */
  otherAccount: boolean;
  /** From the find pass. hasOffer is true only when an offer was actually seen. */
  hasOffer: boolean; offer: Offer | null; offerText: string; findOutcome: string | null; findReason?: string | null; paused: PausedAt | null; path: HuntStep[];
  estSavings: number; termMonths: number; discountPct: number;
  /** What is happening to this service right now, in plain words. */
  live?: string;
  url?: string; note?: string; before: PageClass | null;
  /** The account page already said it was cancelled when the scan read it: after an accept, that is not news. */
  pageSaidCancelled?: boolean;
}
export interface ScanProgress { phase: 'discover' | 'pages' | 'find' | 'done'; done: number; total: number; current?: string; message?: string; items: ScanItem[]; totalEstSavings: number }
export interface ScanResult { at: number; restrictedMode: boolean; domainsChecked: number; items: ScanItem[]; found: number; needsLook: number; withOffers: number; totalEstSavings: number }

const CONCURRENCY = 6, FIND_CONCURRENCY = 3;
// Per-service probe budget: the first load plus at most 2 hops, and no new hop once 45s have gone by.
const LOAD_CAP_MS = 12000, CONTENT_CAP_MS = 8000, PROBE_BUDGET_MS = 45000, MAX_HOPS = 2;
/** Pages that say nothing about the account: a hop away from them never makes things worse. */
const BAD_PAGE = ['not_found', 'error', 'loading', 'bot_challenge'];
/** A details link is opened by URL, never clicked, and never when it reads like an action. Whole words and
 *  phrases, as the server's guard: "Subscriber Services", "Nintendo Switch Online" and "Joined plans" are links. */
const UNSAFE_LINK_RE = /\b(cancel\w*|end (my |your |the )?(subscription|membership|plan)|(log|sign)[- ]?(out|off)|delete|remove|unsubscribe|upgrade|downgrade|pause|checkout|check out|purchase|pay now|subscribe|start (a |your |my )?(free )?trial|switch (to|plan|plans)|leave|deactivate|close (my |your )?account|join (now|free|today)|buy (now|it|this|more|gift|a|an|the))\b/i;   // same words as the server's guard (brain-mock.js)
/** Action segments in the path or query (/cancel, /logout, ?do=checkout); /subscriber-center is not one. */
const UNSAFE_PATH_RE = /[/=](cancel\w*|log-?out|logoff|sign-?out|signoff|checkout|upgrade|downgrade|delete|deactivate|unsubscribe|pause)(?=$|[-/_.?#&;=])/i;
/** Sign-in hosts many services share (the explicit hosts and third-party IdPs of accounts.js's IDP_HOST_RE). A
 *  service's own auth./accounts./id. subdomain (accounts.nintendo.com, auth.hbomax.com) is its account site. */
const SHARED_IDP_RE = /^(login\.microsoftonline\.com|login\.live\.com|accounts\.google\.com|appleid\.apple\.com|idmsa\.apple\.com|account\.apple\.com|accounts\.shopify\.com)$|(^|\.)(microsoftonline\.com|okta\.com|oktapreview\.com|okta-emea\.com|onelogin\.com|auth0\.com|duosecurity\.com|b2clogin\.com|amazoncognito\.com)$/i;
/** Paid, but not through the service: never walked. */
const ELSEWHERE = ['app_store', 'carrier', 'bundle_or_partner'];
const ROBOT = 'The site asked for a robot check — open it yourself';
/** A bare "404: Not Found" (no links, a few words) is a wrong URL, not a page that failed to render. */
const NOT_FOUND_TEXT_RE = /\b404\b|not found|page (could not|couldn['’]t|can['’]t) be found|doesn['’]t exist/i;

/** Walked by the find pass: a confirmed paid plan on a personal account, not already discounted. */
const walkable = (i: ScanItem) => i.status === 'signed_in' && !i.offerApplied && i.before?.hasPaidPlan === true;
/** Still being worked on: the account page is being read, or the find pass hasn't reported yet. */
export const isBusy = (i: ScanItem) => i.status === 'checking' || (walkable(i) && i.findOutcome == null);
const order = (a: ScanItem, b: ScanItem) => (Number(b.hasOffer) - Number(a.hasOffer)) || (Number(isBusy(b)) - Number(isBusy(a))) || (b.estSavings - a.estSavings) || a.name.localeCompare(b.name);

export async function runScan(settings: Settings, onProgress: (p: ScanProgress) => void): Promise<ScanResult> {
  await browser.storage.local.set({ scanRunning: true });
  const items: ScanItem[] = [];
  const emit = (p: Omit<ScanProgress, 'items' | 'totalEstSavings'>) => onProgress({ ...p, items: [...items].sort(order), totalEstSavings: +items.filter((i) => i.hasOffer).reduce((s, i) => s + i.estSavings, 0).toFixed(2) });
  try {
    emit({ phase: 'discover', done: 0, total: 0, message: 'Discovering…' });
    let tp = Date.now();
    const { candidates, domainsChecked } = await discoverCandidates(settings, (message) => emit({ phase: 'discover', done: 0, total: 0, message }));
    trace('phase', { phase: 'discover', ms: Date.now() - tp, candidates: candidates.map((c) => ({ domain: c.domain, name: c.name, accountUrl: scrubUrl(c.accountUrl), source: c.source, canonical: c.canonical, payLikelihood: c.payLikelihood, aliases: c.aliases, altUrls: c.altUrls.length })) });
    tp = Date.now();
    const useApi = await apiAvailable();
    let done = 0;
    emit({ phase: 'pages', done, total: candidates.length });
    const queue = [...candidates];
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const c = queue.shift()!;
        const item = blank(c); items.push(item);
        emit({ phase: 'pages', done, total: candidates.length, current: c.name });
        await probe(item, c, useApi, settings);
        done++;
        emit({ phase: 'pages', done, total: candidates.length, current: c.name });
      }
    }));

    // Two domains that reach one account (cursor.sh + cursor.com) must count, and be walked, once.
    const dups = markDuplicates(items);
    if (dups.merged.length || dups.keptApart.length) trace('scan.duplicates', dups);
    const owner = markOtherAccounts(items);
    trace('phase', { phase: 'pages', ms: Date.now() - tp, probed: items.length, byStatus: countBy(items.map((i) => i.status)), duplicates: dups.merged.length, ownerEmail: maskForLog(owner), otherAccounts: items.filter((i) => i.otherAccount).map((i) => i.domain) });
    emit({ phase: 'pages', done, total: candidates.length });
    tp = Date.now();

    // Pass 3: find the offers. Only confirmed, paid, personal, not-already-discounted subscriptions are walked:
    // work accounts, duplicates, billed-elsewhere and unconfirmed plans all have other statuses and never get here.
    const subs = items.filter(walkable);
    if (settings.testMode && !settings.testFind) {
      // Read-only test run: no cancellation flow is opened on any site.
      for (const i of subs) { i.findOutcome = 'not_walked'; i.live = 'Read-only test: cancellation flow not opened'; }
      trace('phase', { phase: 'find', skipped: true, reason: 'test mode, read-only', wouldWalk: subs.map((i) => i.domain) });
    } else {
      let fdone = 0;
      emit({ phase: 'find', done: 0, total: subs.length, message: 'Looking for loyalty offers…' });
      const found = await findAll(subs, settings, (e) => {
        if (e.type === 'start') { e.item.live = 'Starting the cancellation flow…'; emit({ phase: 'find', done: fdone, total: subs.length, current: e.item.name }); }
        else if (e.type === 'step') { e.item.live = liveText(e.step); emit({ phase: 'find', done: fdone, total: subs.length, current: e.item.name }); }
        else if (e.type === 'found') { applyFind(e.item, e.result); fdone++; emit({ phase: 'find', done: fdone, total: subs.length, current: e.item.name }); }
      }, FIND_CONCURRENCY);
      for (const i of subs) { const f = found.get(i.id); if (f && i.findOutcome == null) applyFind(i, f); }
      trace('phase', { phase: 'find', ms: Date.now() - tp, walked: subs.length, byOutcome: countBy(subs.map((i) => i.findOutcome || 'none')) });
    }

    items.sort(order);
    const offers = items.filter((i) => i.hasOffer);
    const result: ScanResult = {
      at: Date.now(), restrictedMode: settings.restrictedMode, domainsChecked, items,
      found: items.filter((i) => PAYING.includes(i.status)).length, needsLook: items.filter((i) => NEEDS_LOOK.includes(i.status)).length,
      withOffers: offers.length, totalEstSavings: Math.round(offers.reduce((s, i) => s + i.estSavings, 0)),
    };
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

/**
 * Called by the side panel on mount. A scan that was still marked running belongs to a panel that is gone:
 * its probe and walk tabs are orphans, so close them. A paused tab the person closed (or that no longer
 * shows the service) is forgotten, so nothing later acts on a tab we don't own.
 */
export async function reconcileOnLoad(result: ScanResult | null): Promise<ScanResult | null> {
  let changed = false;
  try {
    const v = await browser.storage.local.get('scanRunning');
    // Paused tabs the saved result still points at are kept; any other paused tab belonged to the interrupted run.
    if (v.scanRunning) { await closeOrphanTabs({ pausedToKeep: (result?.items || []).filter((i) => i.paused).map((i) => i.paused!.tabId) }); await browser.storage.local.set({ scanRunning: false }); }
  } catch { /* storage or tabs unavailable: nothing to reconcile */ }
  if (!result) return result;
  for (const i of result.items) {
    // Results stored by an older version lack the newer fields; fill them so the panel can render them.
    if (upgradeItem(i)) changed = true;
    if (i.paused) { let owned = false; try { owned = await ownedPausedTab(i.paused); } catch { /* gone */ } if (!owned) { i.paused = null; changed = true; } }
  }
  if (result.needsLook == null) { result.needsLook = result.items.filter((i) => NEEDS_LOOK.includes(i.status)).length; changed = true; }
  if (changed) { try { await browser.storage.local.set({ scanResult: result }); } catch { /* keep the in-memory copy */ } }
  return result;
}

function upgradeItem(i: ScanItem): boolean {
  let changed = false;
  const d = i as unknown as Record<string, unknown>;
  const fill = (k: string, v: unknown) => { if (d[k] === undefined) { d[k] = v; changed = true; } };
  fill('accountName', null); fill('rememberedEmail', null); fill('siteDomain', null); fill('aliases', []); fill('altUrls', []);
  fill('dupOf', null); fill('pageKind', null); fill('billedVia', null); fill('otherAccount', false);
  if ((i.status as string) === 'unknown') { i.status = 'unconfirmed'; changed = true; }
  return changed;
}

function blank(c: Candidate): ScanItem {
  return {
    id: c.domain, domain: c.domain, name: c.name, accountUrl: c.accountUrl, source: c.source, status: 'checking',
    monthlyPrice: null, cycleCharge: null, cadence: 'unknown', renewalDate: null, isTrial: false, trialEndsOn: null, priceAfterTrial: null,
    planName: null, email: null, offerApplied: false, confidence: c.confidence,
    accountName: null, rememberedEmail: null, siteDomain: null, aliases: [...(c.aliases || [])], altUrls: [...(c.altUrls || [])], dupOf: null, pageKind: null, billedVia: null, otherAccount: false,
    hasOffer: false, offer: null, offerText: '', findOutcome: null, paused: null, path: [], estSavings: 0, termMonths: 0, discountPct: 0, live: 'Opening the account page…', before: null,
  };
}

interface Seen { cls: PageClass; snap: PageSnapshot; ready: Record<string, unknown> }
/**
 * Who pays, as seen on ANY page one probe read. The page kept is chosen for its plan and price, so a hop to the
 * billing page (or from Google One's /error page to the site root) must not drop an employer seat or an App Store
 * bill that an earlier page showed.
 */
interface Evidence { work: { why: string; url: string } | null; elsewhere: { via: string; hay: string } | null }
/** Which of two readings of a service to keep: signed in first (a signed-in 404 says more than a signed-out
 *  marketing root), then a real page over a 404, a paid plan, the plan page, a price, the billing page. Ties go to the later page. */
function better(a: PageClass, b: PageClass | null): boolean {
  if (!b) return true;
  const key = (x: PageClass) => [x.signedIn === true ? 1 : 0, BAD_PAGE.includes(x.pageKind as string) ? 0 : 1, x.hasPaidPlan === true ? 1 : 0, x.isPlanPage ? 1 : 0, x.monthlyPriceUsd != null || x.cycleChargeUsd != null ? 1 : 0, x.pageKind === 'account_billing' ? 1 : 0];
  const ka = key(a), kb = key(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return (ka[i] ?? 0) > (kb[i] ?? 0);
  return true;
}
/** Why a signed-in page is an employer's or team's account, or null. An employer's seat is never the person's to
 *  cancel, whatever it costs. With no account email the reader uses the page's own identity hints (undefined, not null). */
function workEvidence(cls: PageClass, snap: PageSnapshot): string | null {
  if (cls.signedIn !== true) return null;
  const orgWhy = orgAccountReason(snap, cls.accountEmail ?? undefined);
  return cls.accountType === 'work_or_team' ? `classifier: work or team account${orgWhy ? ` · ${orgWhy}` : ''}` : cls.billedVia === 'employer' ? 'billed by an employer' : orgWhy;
}
/** Fold one classified page into what the probe knows about who pays. Returns the page's work reason, if any. */
function noteEvidence(ev: Evidence, cls: PageClass, snap: PageSnapshot, url: string): string | null {
  const work = workEvidence(cls, snap);
  if (work && !ev.work) ev.work = { why: work, url: snap.url || url };
  if (!ev.elsewhere && cls.signedIn === true && ELSEWHERE.includes(cls.billedVia as string)) ev.elsewhere = { via: cls.billedVia as string, hay: `${cls.notes || ''} ${cls.priceEvidence || ''} ${cls.pageEvidence || ''}` };
  return work;
}
/** Why a page's details link must not be opened, or null: an action label or path, another site, or a sign-in
 *  host many services share. The item's own account host (auth.hbomax.com, account.apple.com) is always its site. */
export function linkProblem(label: string, u: URL, sites: string[], accountHost: string): string | null {
  if (!/^https?:$/.test(u.protocol)) return 'not a web link';
  if (UNSAFE_LINK_RE.test(label) || isFinalizeText(label)) return 'action label';
  if (UNSAFE_PATH_RE.test(u.pathname + u.search)) return 'action path';
  const h = u.hostname.toLowerCase();
  if (!sites.includes(etld1(h))) return 'other site';
  return SHARED_IDP_RE.test(h) && h !== accountHost ? 'shared sign-in host' : null;
}
/** Origin + path, for "have we been here already" (a #fragment or trailing slash is the same page). */
function pageKey(url: string): string { try { const u = new URL(url); return (u.origin + u.pathname.replace(/\/+$/, '')).toLowerCase(); } catch { return url; } }

/** Read one account page (following at most 2 hops) and fill the item in place. */
async function probe(item: ScanItem, c: Candidate, useApi: boolean, settings: Settings): Promise<void> {
  let tabId: number | undefined;
  const t0 = Date.now();
  const extra = settings.extraBlock;
  const hops: { why: string; from: string; to: string }[] = [], loads: Record<string, unknown>[] = [];
  const rec: Record<string, unknown> = { svc: c.domain, name: c.name, accountUrl: scrubUrl(c.accountUrl), hops, loads, workReason: null };
  let best: Seen | null = null, lastSnap: PageSnapshot | null = null, lastReady: Record<string, unknown> | null = null;
  const ev: Evidence = { work: null, elsewhere: null };
  let local: { status: ItemStatus; live: string; pageKind: string | null } | null = null;
  let classifyMs = 0;
  try {
    // Never-touch check BEFORE anything is opened: the service itself and the host of its account URL.
    const pre = blockReason(c.domain, extra) || blockReason(hostOf(c.accountUrl), extra);
    if (pre) {
      item.status = 'sensitive'; item.note = pre; rec.sensitive = pre;
      item.live = pre === 'on your never-explore list' ? 'On your never-explore list — skipped, nothing opened' : 'Looks like a bank or other sensitive account — skipped, nothing opened';
      return;
    }
    if (!hostOf(c.accountUrl)) throw new Error('bad account URL');
    const tried = new Set<string>([pageKey(c.accountUrl)]);
    const homeSites = [...new Set([c.domain, etld1(hostOf(c.accountUrl)), ...(c.aliases || [])].filter(Boolean))];
    const siteSet = (pageUrl: string) => [...new Set([...homeSites, etld1(hostOf(pageUrl))].filter(Boolean))];
    const canHop = () => hops.length < MAX_HOPS && Date.now() - t0 < PROBE_BUDGET_MS;
    const usable = (u: string) => { let p: URL; try { p = new URL(u); } catch { return false; } return /^https?:$/.test(p.protocol) && !tried.has(pageKey(u)) && !blockReason(p.hostname, extra) && !isLoginUrl(u); };
    // After a 404 or error page: the next known account URL, then the root of the site the account page is on.
    // A network-level failure (made-up subdomain) skips that host's root and goes to the service's own domain.
    const fallback = (landed: string | null, netError: boolean): string | null => {
      const out = [...(c.altUrls || [])];
      const lh = hostOf(landed || ''), origin = (u: string) => { try { return new URL(u).origin + '/'; } catch { return ''; } };
      if (!netError) out.push(lh && hostMatches(lh, homeSites) ? origin(landed!) : origin(c.accountUrl));
      if (hostOf(c.accountUrl) !== c.domain && c.domain.includes('.')) out.push(`https://${c.domain}/`);
      return out.find((u) => u && usable(u)) || null;
    };
    // The page's own "Billing" / "Membership" link, when the classifier points at one: same site, a plain
    // link (never a button), not an action, not somewhere we've been. It is opened by URL, not clicked.
    const detailsLink = (cls: PageClass, snap: PageSnapshot): string | null => {
      if (cls.detailsLinkId == null) return null;
      const el = (snap.elements || []).find((e) => e.id === cls.detailsLinkId);
      if (!el || el.tag !== 'a' || !el.href) return null;
      let u: URL; try { u = new URL(el.href, snap.url); } catch { return null; }
      const bad = linkProblem(`${el.text || ''} ${el.label || ''}`, u, siteSet(snap.url), hostOf(c.accountUrl));
      if (bad) { rec.linkRefused = bad; return null; }
      u.hash = '';
      return usable(u.href) ? u.href : null;   // usable() also refuses sign-in URLs and blocked hosts
    };

    let url = c.accountUrl, first = true, reread = false, rereadDone = false, pricing = false, keptLast = false;
    for (;;) {
      try {
        // Load, then wait until the page has actually rendered (SPAs render well after 'complete').
        const tl = Date.now();
        let loadKind: string;
        // A re-read stays on the same page: an app that was still filling in gets a little more time.
        if (reread) { loadKind = 'reread'; await sleep(1500); }
        else if (first) { tabId = await openTab(url, false, { purpose: 'probe', svc: c.domain }); loadKind = (await waitForPage(tabId, LOAD_CAP_MS)).kind; }
        else loadKind = (await navigateTab(tabId!, url)) ? 'complete' : 'timeout';
        reread = false;
        const pricingNow: boolean = pricing; pricing = false;   // this page was opened only to find the plan's price
        const loadMs = Date.now() - tl;
        if (first) { rec.loadMs = loadMs; rec.loadTimedOut = loadKind === 'timeout'; }
        first = false;
        if (loadKind === 'gone') throw new Error('tab was closed');
        item.live = 'Reading the account page…';
        const ready = await waitForContent(tabId!, { capMs: CONTENT_CAP_MS, patientSparse: true });
        const r = { kind: ready.kind, ms: ready.ms, visibleTextLen: ready.probe?.visibleTextLen ?? null, interactiveCount: ready.probe?.interactiveCount ?? null };
        const load: Record<string, unknown> = { url: scrubUrl(url), load: loadKind, loadMs, ready: ready.kind, readyMs: ready.ms };
        loads.push(load); lastReady = r;
        if (ready.kind === 'gone') throw new Error('tab was closed');
        let snap: PageSnapshot | null = null, netError = ready.kind === 'error_page';
        if (!netError) {
          try { snap = await runInTab<PageSnapshot>(tabId!, snapshotPage, [{ maxElements: 80, textChars: 4000, domain: c.domain }]); }
          catch (e) { if (classifyTabError(e) !== 'error_page') throw e; netError = true; }
        }
        if (netError || !snap) {
          // The browser's own error page (DNS failure, refused connection): try the next URL, else give up.
          const next = best && !BAD_PAGE.includes(best.cls.pageKind as string) ? null : fallback(null, true);
          if (next && canHop()) { hops.push({ why: 'error_page', from: scrubUrl(url), to: scrubUrl(next) }); tried.add(pageKey(next)); url = next; continue; }
          if (!best) local = { status: 'not_loaded', live: "The site didn't load", pageKind: null };
          break;
        }
        lastSnap = snap;
        // Never-touch check on where the page actually landed, and on what it says, BEFORE its text is sent.
        const why = blockReason(hostOf(snap.url || url), extra) || financialPageReason(snap.text);
        if (why) {
          item.status = 'sensitive'; item.note = why; item.url = undefined; item.live = 'Looks like a bank or other sensitive account — skipped, nothing sent';
          rec.sensitive = why; rec.page = { url: scrubUrl(snap.url || '') };   // no page text in the log either
          return;
        }
        const onLogin = isLoginUrl(snap.url || '');
        if (!onLogin && (ready.kind === 'challenge' || ready.probe?.challenge)) {
          load.pageKind = 'bot_challenge';
          if (!best) local = { status: 'needs_you', live: ROBOT, pageKind: 'bot_challenge' };
          break;
        }
        const textLen = snap.textLength ?? (snap.text || '').length;
        const empty = textLen < 40 && !(snap.elements || []).length && (!ready.probe || (ready.probe.visibleTextLen < 40 && ready.probe.interactiveCount === 0));
        const bareNotFound = textLen < 60 && !(snap.elements || []).length && NOT_FOUND_TEXT_RE.test(`${snap.title || ''} ${snap.text || ''}`);
        if (!onLogin && bareNotFound) {
          // "404: Not Found" and nothing else (Oura's guessed billing URL): recover like any other 404.
          load.pageKind = 'not_found';
          const next = best && !BAD_PAGE.includes(best.cls.pageKind as string) ? null : fallback(snap.url || url, false);
          if (next && canHop()) { hops.push({ why: 'not_found', from: scrubUrl(snap.url || url), to: scrubUrl(next) }); tried.add(pageKey(next)); url = next; continue; }
          if (!best) local = { status: 'wrong_page', live: "Couldn't find the account page", pageKind: 'not_found' };
          break;
        }
        if (!onLogin && empty) {
          load.pageKind = 'loading';
          if (!best) local = { status: 'not_loaded', live: "The page didn't finish loading — open it yourself", pageKind: 'loading' };
          break;
        }
        const tc = Date.now();
        const readiness = ready.probe && { ...ready.probe, url: scrubUrl(ready.probe.url), dialog: scrubPii(scrubSecrets(ready.probe.dialog || '')) };
        const cls: PageClass = useApi
          ? (await apiPost<{ result: PageClass }>('/api/classify', { domain: c.domain, name: c.name, snapshot: snap, readiness })).result
          : (mockClassify(snap, c.domain) as unknown as PageClass);
        classifyMs += Date.now() - tc;
        recordPage({ svc: c.domain, name: c.name, phase: 'probe', hop: hops.length, reread: loadKind === 'reread', readiness,
          classify: { pageKind: cls.pageKind ?? null, signedIn: cls.signedIn, accountType: cls.accountType ?? null, billedVia: cls.billedVia ?? null, isPlanPage: cls.isPlanPage ?? null,
            hasPaidPlan: cls.hasPaidPlan, planName: cls.planName, monthlyPriceUsd: cls.monthlyPriceUsd, cycleChargeUsd: cls.cycleChargeUsd, cadence: cls.cadence,
            detailsLinkId: cls.detailsLinkId ?? null, confidence: cls.confidence, notes: cls.notes } }, snap);
        Object.assign(load, { pageKind: cls.pageKind ?? null, signedIn: cls.signedIn, hasPaidPlan: cls.hasPaidPlan, confidence: cls.confidence });
        // A price page that shows no price must not replace the reading it was meant to complete (its renewal date, plan name).
        // A re-read is the same page, finished: it replaces the reading of the half-rendered one it was kept from (a
        // clear "no paid plan" beats an unsure "paid"), unless the page fell over or now reads signed out.
        const rereadWins: boolean = loadKind === 'reread' && keptLast && !BAD_PAGE.includes(cls.pageKind as string) && !(best?.cls.signedIn === true && cls.signedIn !== true);
        const improved: boolean = rereadWins || (better(cls, best?.cls ?? null) && (!pricingNow || cls.monthlyPriceUsd != null || cls.cycleChargeUsd != null));
        if (improved) best = { cls, snap, ready: r };
        keptLast = improved;
        // Who pays is read on EVERY page, whichever one is kept. An employer's or team's page settles it: no hop
        // can make that seat the person's to cancel, and a hop could land where it no longer shows (Google One).
        if (noteEvidence(ev, cls, snap, url)) { load.work = true; break; }
        // Still filling in (a loading screen, or a near-empty frame the classifier wasn't sure about): read the same
        // page once more before judging it. The second live run read YouTube and Reddit this way, blank.
        const sparse = textLen < 150 && (snap.elements || []).length < 8;
        if (!rereadDone && (cls.pageKind === 'loading' || (sparse && (cls.confidence ?? 1) < 0.7)) && Date.now() - t0 < PROBE_BUDGET_MS) {
          rereadDone = true; reread = true; rec.reread = true; pricing = pricingNow; continue;   // same page, same purpose
        }
        // Hop 1: a 404 / error page, while nothing useful has been seen yet.
        if ((cls.pageKind === 'not_found' || cls.pageKind === 'error') && BAD_PAGE.includes(best!.cls.pageKind as string)) {
          const next = fallback(snap.url || url, false);
          if (next && canHop()) { hops.push({ why: cls.pageKind, from: scrubUrl(snap.url || url), to: scrubUrl(next) }); tried.add(pageKey(next)); url = next; continue; }
          break;
        }
        // Hop 2: signed in, but this page doesn't show the plan or its price: follow the page's own details link.
        const noPrice = cls.monthlyPriceUsd == null && cls.cycleChargeUsd == null;
        if (improved && cls.signedIn === true && cls.detailsLinkId != null && (cls.hasPaidPlan == null || !cls.isPlanPage || (cls.hasPaidPlan === true && noPrice))
          && !['login', 'reauth', 'bot_challenge', 'loading'].includes(cls.pageKind as string)) {
          const next = detailsLink(cls, snap);
          if (next && canHop()) { hops.push({ why: 'details_link', from: scrubUrl(snap.url || url), to: scrubUrl(next) }); tried.add(pageKey(next)); url = next; continue; }
        }
        // Hop 3: a confirmed paid plan whose price no page has shown yet: the catalog's other account page for it
        // (Amazon's Prime page, Netflix's membership page). Without a price an offer can't be valued.
        const b = best!.cls;
        if (b.signedIn === true && b.hasPaidPlan === true && b.monthlyPriceUsd == null && b.cycleChargeUsd == null && canHop()) {
          const next = (c.knownAltUrls || []).find((u) => usable(u));   // the catalog's own pages only, never a model's guess
          if (next) { hops.push({ why: 'price', from: scrubUrl(snap.url || url), to: scrubUrl(next) }); tried.add(pageKey(next)); url = next; pricing = true; continue; }
        }
        break;
      } catch (e) {
        // A hop that fails must not throw away what an earlier page already showed.
        if (!best) throw e;
        rec.hopError = String((e as any)?.message || e).slice(0, 160);
        break;
      }
    }

    if (best) {
      const { cls, snap } = best;
      item.url = snap.url;
      item.pageSaidCancelled = CANCELLED_RE.test(snap.text || '');
      rec.page = snapSummary(snap); rec.ready = best.ready;
      mapStatus(item, c, cls, snap, rec, ev);
      rec.classify = { ...cls, accountEmail: maskForLog(cls.accountEmail), accountName: cls.accountName ? redactForLog(cls.accountName) : null, notes: redactForLog(cls.notes || ''), pageEvidence: cls.pageEvidence ? redactForLog(cls.pageEvidence) : cls.pageEvidence, priceEvidence: cls.priceEvidence ? redactForLog(cls.priceEvidence) : cls.priceEvidence };
    } else if (local) {
      item.status = local.status; item.live = local.live; item.pageKind = local.pageKind;
      item.url = lastSnap?.url || url;
      rec.page = lastSnap ? snapSummary(lastSnap) : null; rec.ready = lastReady;
    }
    if (item.url) item.siteDomain = etld1(hostOf(item.url)) || null;
  } catch (e: any) {
    const msg = String(e?.message || e), kind = classifyTabError(e);
    const reason = /^brain unavailable/i.test(msg) ? 'brain unavailable' : /^timeout:/i.test(msg) ? 'the classifier took too long'
      : msg === 'tab was closed' || kind === 'tab_gone' ? 'tab was closed' : kind === 'no_access' ? "couldn't read the page"
      : kind === 'error_page' ? "the site didn't load" : kind === 'script_timeout' ? 'the page stopped responding' : kind === 'frame_gone' ? 'the page kept navigating' : msg.slice(0, 160);
    item.status = kind === 'error_page' || kind === 'script_timeout' ? 'not_loaded' : 'error';
    item.note = reason; item.live = `Couldn't open the account page — ${reason}`;
    rec.error = reason; rec.errorKind = kind;
  } finally {
    if (tabId !== undefined) await closeTab(tabId);
    const finalUrl = item.url || null, host = hostOf(finalUrl || '');
    trace('probe', {
      ...rec, finalUrl: finalUrl ? scrubUrl(finalUrl) : null, redirected: !!finalUrl && finalUrl !== c.accountUrl,
      leftSite: !!host && !hostMatches(host, [c.domain, etld1(hostOf(c.accountUrl)), ...(c.aliases || [])].filter(Boolean)),
      classifyMs, ms: Date.now() - t0, status: item.status, pageKind: item.pageKind, billedVia: item.billedVia,
      email: maskForLog(item.email), rememberedEmail: maskForLog(item.rememberedEmail), accountName: item.accountName ? redactForLog(item.accountName) : null, siteDomain: item.siteDomain,
      monthlyPrice: item.monthlyPrice, cycleCharge: item.cycleCharge, cadence: item.cadence, renewalDate: item.renewalDate, isTrial: item.isTrial, offerApplied: item.offerApplied,
    });
  }
}

/**
 * Turn the kept classification into a status, in a fixed order: page kind first, then who, then what they pay.
 * `ev` is what every page of the probe showed about who pays: work evidence from any of them is checked before
 * the kept page's 404 / login / marketing verdicts, and an App Store or carrier bill seen on one page is not
 * undone by the billing page that showed the price.
 */
function mapStatus(item: ScanItem, c: Candidate, cls: PageClass, snap: PageSnapshot, rec: Record<string, unknown>, ev: Evidence): void {
  const kind = (cls.pageKind as string | undefined) ?? null, signedIn = cls.signedIn === true;
  item.before = cls; item.pageKind = kind; item.billedVia = cls.billedVia ?? null;
  // Identity before any branch, so a login wall or free plan still says whose account it is. A login page's
  // pre-filled email is only "remembered": it doesn't prove a session.
  item.accountName = cls.accountName ?? null;
  item.email = signedIn ? cls.accountEmail ?? null : null;
  item.rememberedEmail = signedIn ? null : cls.accountEmail ?? null;
  item.note = cls.notes || undefined;
  const set = (s: ItemStatus, live: string) => { item.status = s; item.live = live; };
  if (kind === 'bot_challenge') return set('needs_you', ROBOT);
  if (kind === 'reauth') return set('needs_you', `${item.name} wants your password again before it shows your plan`);
  if (kind === 'loading') return set('not_loaded', "The page didn't finish loading — open it yourself");
  // Google One on a Workspace session lands on /error ("Sign in with your personal account"): the page is a
  // "not found" to the classifier, but it is the clearest work-account page there is.
  const own = workEvidence(cls, snap);
  const work = ev.work ?? (own ? { why: own, url: snap.url || '' } : null);
  rec.workReason = work?.why ?? null;
  if (work) {
    if (work.url && work.url !== snap.url) rec.workPage = scrubUrl(work.url);
    item.note = [work.why, cls.notes].filter(Boolean).join(' · ');
    const google = c.domain === 'google.com' || [work.url, snap.url].some((u) => etld1(hostOf(u || '')) === 'google.com');
    return set('work_account', `Work account — managed by your organization, left alone${google ? '. Sign into your personal Google account and scan again' : ''}`);
  }
  if (kind === 'not_found' || kind === 'error') return set('wrong_page', "Couldn't find the account page");
  if (kind === 'login') return set('login_wall', 'Not signed in here');
  // A public sales page with no signed-in chrome: for the person that's "not signed in here", whether or not a Sign
  // in link survived the element cap. "Needs a look" is for pages worth opening; the second run filled it with these.
  if (kind === 'marketing' && !signedIn) return set('login_wall', 'Not signed in here');
  if (!signedIn) return set('login_wall', 'Not signed in here');
  item.planName = cls.planName ?? null;
  // "No paid plan" only when the plan page says so; absence on some other page proves nothing.
  if (cls.hasPaidPlan === false && (cls.isPlanPage || kind === 'account_billing' || kind === 'marketing')) {
    const pn = item.planName;
    return set('no_paid_plan', pn ? (/free/i.test(pn) ? pn : `Free plan · ${pn}`) : 'Free plan');
  }
  if (cls.hasPaidPlan !== true || (cls.confidence ?? 0) < 0.6) return set('unconfirmed', 'Signed in · plan not shown — open it to check');
  item.monthlyPrice = cls.monthlyPriceUsd ?? null; item.offerApplied = !!cls.offerApplied;
  item.cycleCharge = cls.cycleChargeUsd ?? null; item.cadence = cls.cadence || 'unknown'; item.renewalDate = cls.renewalDate ?? null;
  item.isTrial = !!cls.isTrial; item.trialEndsOn = cls.trialEndsOn ?? null; item.priceAfterTrial = cls.priceAfterTrialUsd ?? null;
  // Billed through someone else on this page or an earlier one: a hop to the price must not make it walkable.
  const elsewhere = ELSEWHERE.includes(cls.billedVia as string) ? { via: cls.billedVia as string, hay: `${cls.notes || ''} ${cls.priceEvidence || ''} ${cls.pageEvidence || ''}` } : ev.elsewhere;
  if (elsewhere) {
    const { via: bv, hay } = elsewhere;
    item.billedVia = bv; rec.billedElsewhere = bv;
    const via = bv === 'carrier' ? 'your carrier' : bv === 'bundle_or_partner' ? 'a bundle' : /google play/i.test(hay) ? 'Google Play' : /apple|app store|itunes/i.test(hay) ? 'Apple' : 'an app store';
    return set('billed_elsewhere', `Billed through ${via} · left alone`);
  }
  item.status = 'signed_in';
  if (cls.offerApplied) { item.note = ['a promotional price is already applied', cls.notes].filter(Boolean).join(' · '); item.live = 'A promo price is already applied — left alone'; }
  else item.live = `Signed in${item.monthlyPrice != null ? ` · ${money(item.monthlyPrice)}/mo` : ''} · waiting to look for an offer`;
}

// work_account leads: two readings of one session that disagree about an employer seat must never walk it.
const RANK: Record<string, number> = { work_account: 0, signed_in: 1, billed_elsewhere: 2, no_paid_plan: 3, unconfirmed: 4 };
const known = (i: ScanItem) => [i.monthlyPrice, i.cycleCharge, i.planName, i.renewalDate, i.email].filter((v) => v != null).length;
const planWords = (s: string | null) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/**
 * Backstop for duplicates discovery couldn't merge: signed-in items that landed on the same registrable domain
 * (not a shared sign-in host) are one account. The best-read one is kept and the rest point at it. Two paid
 * items that name clearly different plans (Prime vs Kindle Unlimited) stay apart.
 */
function markDuplicates(items: ScanItem[]): { merged: { site: string; kept: string; dup: string }[]; keptApart: { site: string; a: string; b: string }[] } {
  const merged: { site: string; kept: string; dup: string }[] = [], keptApart: { site: string; a: string; b: string }[] = [];
  const groups = new Map<string, ScanItem[]>();
  for (const i of items) {
    if (i.before?.signedIn !== true || !i.siteDomain || i.status === 'sensitive' || i.status === 'duplicate' || i.status === 'error') continue;
    // A shared sign-in host says nothing about whose account it is; the item's own account host (auth.hbomax.com) does.
    const h = hostOf(i.url || '');
    if (isIdpHost(h) && h !== hostOf(i.accountUrl)) continue;
    groups.set(i.siteDomain, [...(groups.get(i.siteDomain) || []), i]);
  }
  for (const [site, g] of groups) {
    if (g.length < 2) continue;
    g.sort((a, b) => ((RANK[a.status] ?? 5) - (RANK[b.status] ?? 5)) || (known(b) - known(a)) || (b.confidence - a.confidence) || a.domain.localeCompare(b.domain));
    const [keep, ...rest] = g;
    if (!keep) continue;
    for (const d of rest) {
      const pk = planWords(keep.planName), pd = planWords(d.planName);
      if (PAYING.includes(keep.status) && PAYING.includes(d.status) && pk && pd && !pk.includes(pd) && !pd.includes(pk)) { keptApart.push({ site, a: keep.domain, b: d.domain }); continue; }
      d.status = 'duplicate'; d.dupOf = keep.id; d.live = `Same account as ${keep.name}`;
      keep.aliases = [...new Set([...keep.aliases, d.domain, ...d.aliases])].filter((x) => x !== keep.domain);
      merged.push({ site, kept: keep.domain, dup: d.domain });
    }
  }
  return { merged, keptApart };
}

/**
 * "Yours" is the personal email most paid (or unconfirmed) services are signed in with; a service signed in
 * with a different personal email gets an informational flag. Needs 2+ sightings and a clear lead, so one
 * household member's login can't become the owner. Work addresses are never compared.
 */
function markOtherAccounts(items: ScanItem[]): string | null {
  const counts = new Map<string, number>();
  for (const i of items) if ((PAYING.includes(i.status) || i.status === 'unconfirmed') && i.email && isConsumerEmail(i.email)) { const e = i.email.trim().toLowerCase(); counts.set(e, (counts.get(e) || 0) + 1); }
  const [top, second] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const owner = top && top[1] >= 2 && (!second || top[1] > second[1]) ? top[0] : null;
  for (const i of items) i.otherAccount = !!(owner && i.email && isConsumerEmail(i.email) && i.email.trim().toLowerCase() !== owner);
  return owner;
}

/** Record what the find pass saw, and say it in plain words. */
function applyFind(i: ScanItem, f: FindResult): void {
  trace('find.result', { svc: i.domain, name: i.name, outcome: f.outcome, reason: f.reason ?? null, error: f.error ?? null, offer: f.offer, paused: f.paused ? { url: scrubUrl(f.paused.url), acceptText: f.paused.acceptText } : null, steps: f.path.length, price: i.monthlyPrice, isTrial: i.isTrial });
  i.findOutcome = f.outcome; i.findReason = f.reason ?? null; i.offer = f.offer; i.paused = f.paused; i.path = f.path;
  i.hasOffer = f.outcome === 'offer_found' && !!f.paused;
  // A trial's page shows $0 today; the offer usually shows the price it takes off ("$89.99 $44.99/month").
  if (i.isTrial && i.priceAfterTrial == null && f.offer) { const reg = regularPrice(f.offer); if (reg != null) i.priceAfterTrial = reg; }
  const sv = offerSavings(f.offer, i.isTrial && i.priceAfterTrial != null ? i.priceAfterTrial : i.monthlyPrice);
  i.estSavings = i.hasOffer ? sv.savingsUsd : 0; i.termMonths = sv.termMonths; i.discountPct = sv.discountPct; i.offerText = i.hasOffer ? sv.text : '';
  if (i.hasOffer) { i.live = `Offer found: ${sv.text} — holding it for you`; return; }
  if (f.outcome === 'may_have_cancelled') { i.note = 'may have been cancelled: check it'; i.live = `${i.name} may have been cancelled. Open it and look for Restart or Resume`; return; }
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
/** The price an offer takes off: the one it shows (often struck through), else its new price undone by its percentage. */
export function regularPrice(o: Offer): number | null {
  if (o.regularMonthlyPriceUsd != null && o.regularMonthlyPriceUsd > 0) return o.regularMonthlyPriceUsd;
  let pct = o.discountPct ?? 0; if (pct > 1) pct = pct / 100;
  return o.newMonthlyPriceUsd != null && pct > 0 && pct < 1 ? +(o.newMonthlyPriceUsd / (1 - pct)).toFixed(2) : null;
}
export function offerSavings(o: Offer | null, price: number | null): { savingsUsd: number; termMonths: number; discountPct: number; text: string } {
  if (!o) return { savingsUsd: 0, termMonths: 0, discountPct: 0, text: '' };
  const r = (n: number) => +n.toFixed(2);
  // Unknown or $0 today (a trial, a page without a price): measure against the offer's own regular price.
  const p = price != null && price > 0 ? price : (regularPrice(o) ?? 0);
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

function countBy(xs: string[]): Record<string, number> { const o: Record<string, number> = {}; for (const x of xs) o[x] = (o[x] || 0) + 1; return o; }

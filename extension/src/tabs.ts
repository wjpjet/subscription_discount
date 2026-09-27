/**
 * The tabs Walkaway opens, and how it waits for them.
 *
 * Every probe, walk and accept tab is recorded in browser.storage.session ('walkawayTabs'). Tab ids are unique
 * within a browser session and session storage is cleared on restart, so a registered id is always one of ours.
 * That lets a panel that reopens after a crash close what a dead run left behind, and stops a stored paused-tab
 * id from ever closing or navigating one of the user's own tabs. (An extension reload also clears it: leftover
 * tabs are then left open rather than risk closing the wrong one.)
 *
 * Waiting is judged from the page, not the clock: 'complete' never arrives on pages with endless ad requests, SPA
 * shells are 'complete' long before they show anything, and hidden tabs run page timers at most once a second.
 */
import { browser } from '#imports';
import { readinessProbe } from '../../shared/page-scripts.js';
import { etld1 } from '../../shared/domains.js';
import { scrubUrl } from '../../shared/scrub.js';
import { hostOf } from './lists';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export type Readiness = ReturnType<typeof readinessProbe>;

// ---------------------------------------------------------------- errors and script calls

export type TabErrorKind = 'error_page' | 'frame_gone' | 'tab_gone' | 'no_access' | 'script_timeout' | 'other';
/** What an executeScript failure means. Order matters: "Frame with ID 0 is showing error page" is an error page. */
export function classifyTabError(e: unknown): TabErrorKind {
  const m = String((e as any)?.message || e || '');
  if (/^script_timeout/i.test(m)) return 'script_timeout';
  if (/showing error page/i.test(m)) return 'error_page';
  if (/no tab with id|tab was closed|tab .*(was )?(closed|removed)/i.test(m)) return 'tab_gone';
  if (/frame .*(was )?removed|no frame with id|back\/forward cache|document .*(not found|unloaded)/i.test(m)) return 'frame_gone';
  if (/cannot access|cannot be scripted|extensions gallery|chrome:\/\/|missing host permission/i.test(m)) return 'no_access';
  return 'other';
}

/** One executeScript, raced against a timer (a hung page must not pin a worker). The race cannot cancel the
 *  injected function, so callers must never retry an action that timed out: it may still run. */
async function exec<T>(tabId: number, func: (...args: any[]) => T, args: any[], timeoutMs: number, immediate = false): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`script_timeout: ${func.name || 'page script'} after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs); });
  try {
    const res = await Promise.race([browser.scripting.executeScript({ target: { tabId }, func, args, injectImmediately: immediate }), timeout]);
    return res?.[0]?.result as T;
  } finally { clearTimeout(timer); }
}

/**
 * Run a page function in the tab. Retries once when the document was swapped out under the call (frame_gone),
 * after the new one loads. Pass retry:false for anything that acts on the page (performAction): a click whose
 * frame vanished may already have happened and must never be replayed.
 */
export async function runInTab<T>(tabId: number, func: (...args: any[]) => T, args: any[] = [], opts: { timeoutMs?: number; retry?: boolean } = {}): Promise<T> {
  const ms = opts.timeoutMs ?? 15000;
  try { return await exec(tabId, func, args, ms); }
  catch (e) {
    if (opts.retry === false || classifyTabError(e) !== 'frame_gone') throw e;
    await waitForLoad(tabId, 5000);
    return exec(tabId, func, args, ms);
  }
}

// ---------------------------------------------------------------- the registry

export type TabPurpose = 'probe' | 'walk' | 'accept' | 'paused';
export interface TabEntry { tabId: number; purpose: string; svc: string; url: string; openedAt: number }
const REG = 'walkawayTabs';
let regChain: Promise<unknown> = Promise.resolve();
/** Read-modify-write, serialized: four probes and three walks open and close tabs at the same time. Best effort:
 *  a registry that can't be written only means a stale tab isn't swept later. */
function editRegistry(fn: (reg: Record<string, TabEntry>) => void): Promise<void> {
  const run = regChain.then(async () => {
    const reg = ((await browser.storage.session.get(REG))[REG] || {}) as Record<string, TabEntry>;
    fn(reg);
    await browser.storage.session.set({ [REG]: reg });
  }).catch(() => { /* storage.session unavailable */ });
  regChain = run;
  return run;
}
async function readRegistry(): Promise<Record<string, TabEntry>> {
  await regChain;
  try { return ((await browser.storage.session.get(REG))[REG] || {}) as Record<string, TabEntry>; } catch { return {}; }
}
export async function registeredTabs(): Promise<TabEntry[]> { return Object.values(await readRegistry()); }
export async function unregisterTab(tabId: number): Promise<void> { await editRegistry((r) => { delete r[tabId]; }); }
/** Change what a registered tab is for (a paused tab becomes the accept tab once the user pays). */
export async function retagTab(tabId: number, purpose: TabPurpose, svc: string): Promise<void> {
  await editRegistry((r) => { const e = r[tabId]; if (e) r[tabId] = { ...e, purpose, svc }; });
}

export async function openTab(url: string, active: boolean, meta?: { purpose: 'probe' | 'walk' | 'accept'; svc: string }): Promise<number> {
  const t = await browser.tabs.create({ url, active });
  const id = t.id;
  if (id == null) throw new Error('Could not open a tab');
  if (meta) await editRegistry((r) => { r[id] = { tabId: id, purpose: meta.purpose, svc: meta.svc, url: scrubUrl(url), openedAt: Date.now() }; });
  return id;
}
export async function closeTab(tabId: number): Promise<void> {
  try { await browser.tabs.remove(tabId); } catch { /* gone */ }
  await unregisterTab(tabId);
}
/** A walk stopped on an offer: keep the tab, and keep Chrome from discarding it while the user decides and pays
 *  (a discarded tab can't run scripts, so the one-click accept would be lost). */
export async function markPaused(tabId: number, svc: string, url: string): Promise<void> {
  await editRegistry((r) => { r[tabId] = { tabId, purpose: 'paused', svc, url, openedAt: r[tabId]?.openedAt ?? Date.now() }; });
  try { await browser.tabs.update(tabId, { autoDiscardable: false }); } catch { /* tab gone or unsupported */ }
}
/**
 * Is this stored paused-tab handle still a tab WE paused, on the same site? Scan results outlive the browser
 * session and tab ids get reused after a restart, so the id alone could name an unrelated tab of the user's.
 * All three must hold: the tab exists, this session registered it as paused, and it is still on the registrable
 * domain it paused on (an unreadable url fails closed).
 */
export async function ownedPausedTab(p: { tabId: number; url: string } | null | undefined): Promise<boolean> {
  if (!p || p.tabId == null) return false;
  const want = etld1(hostOf(p.url || ''));
  if (!want || (await readRegistry())[p.tabId]?.purpose !== 'paused') return false;
  try { const h = hostOf((await browser.tabs.get(p.tabId)).url || ''); return !!h && etld1(h) === want; } catch { return false; }
}
/**
 * Close the probe, walk and accept tabs a dead run left behind (the panel that ran it was closed or reloaded).
 * Paused tabs stay: a saved scan may still hold them. Pass pausedToKeep (the ids a saved scan still refers to) to
 * also close paused tabs nothing refers to any more. Returns how many tabs were closed.
 */
export async function closeOrphanTabs(opts: { pausedToKeep?: number[] } = {}): Promise<number> {
  let n = 0;
  for (const e of await registeredTabs()) {
    if (e.purpose === 'paused' && (!opts.pausedToKeep || opts.pausedToKeep.includes(e.tabId))) continue;
    try { await browser.tabs.get(e.tabId); await browser.tabs.remove(e.tabId); n++; } catch { /* already gone */ }
    await unregisterTab(e.tabId);
  }
  return n;
}

// ---------------------------------------------------------------- waiting for a page

export type LoadKind = 'complete' | 'interactive' | 'timeout' | 'gone';
const INTERACTIVE_AFTER_MS = 1500, LOAD_POLL_MS = 500;

/**
 * The load wait, cancellable. 'complete' on the tab's status; after 1.5s also 'interactive' once a committed
 * document is past readyState 'loading' (US News never reached 'complete' in 20s but was readable); 'gone' when
 * the tab closes; 'timeout' at capMs. sinceNav ignores the page that was there before a navigation we started:
 * right after tabs.update the tab can still report the OLD page's 'complete'.
 */
function pageWaiter(tabId: number, capMs: number, sinceNav: boolean): { promise: Promise<{ kind: LoadKind; ms: number }>; cancel: () => void } {
  const t0 = Date.now();
  let finish: (kind: LoadKind) => void = () => {};
  const promise = new Promise<{ kind: LoadKind; ms: number }>((resolve) => {
    let done = false, navStarted = !sinceNav, poll: ReturnType<typeof setTimeout> | undefined;
    const onUpdated = (id: number, info: any) => {
      if (id !== tabId || !info) return;
      if (info.status === 'loading' || info.url) navStarted = true;
      if (info.status === 'complete' && navStarted) finish('complete');
    };
    const onRemoved = (id: number) => { if (id === tabId) finish('gone'); };
    const timer = setTimeout(() => finish('timeout'), capMs);
    finish = (kind) => {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(poll);
      browser.tabs.onUpdated.removeListener(onUpdated); browser.tabs.onRemoved.removeListener(onRemoved);
      resolve({ kind, ms: Date.now() - t0 });
    };
    browser.tabs.onUpdated.addListener(onUpdated); browser.tabs.onRemoved.addListener(onRemoved);
    const check = async () => {
      if (done) return;
      let t;
      try { t = await browser.tabs.get(tabId); } catch { return finish('gone'); }
      // Committed: a real URL and no navigation still pending (a new tab starts on about:blank).
      const committed = navStarted && !!t.url && t.url !== 'about:blank' && !t.pendingUrl;
      if (committed && t.status === 'complete') return finish('complete');
      if (committed && Date.now() - t0 >= INTERACTIVE_AFTER_MS) {
        // injectImmediately: the default document_idle injection would itself wait for the load.
        const rs = await exec(tabId, () => document.readyState, [], 2000, true).catch(() => null);   // error page or mid-swap: not yet
        if (rs && rs !== 'loading') return finish('interactive');
      }
      if (!done) poll = setTimeout(check, Math.max(LOAD_POLL_MS, INTERACTIVE_AFTER_MS - (Date.now() - t0)));
    };
    void check();
  });
  return { promise, cancel: () => finish('timeout') };
}
export function waitForPage(tabId: number, capMs = 10000): Promise<{ kind: LoadKind; ms: number }> { return pageWaiter(tabId, capMs, false).promise; }
/** true when the page loaded ('complete' or 'interactive'); false on timeout or a closed tab. */
export async function waitForLoad(tabId: number, timeoutMs = 10000): Promise<boolean> {
  const r = await waitForPage(tabId, timeoutMs);
  return r.kind === 'complete' || r.kind === 'interactive';
}
/** Navigate and wait for the NEW page (listeners go up before tabs.update, so its 'loading' can't be missed). */
export async function navigateAndWait(tabId: number, url: string, capMs = 10000): Promise<{ kind: LoadKind; ms: number }> {
  const w = pageWaiter(tabId, capMs, true);
  try { await browser.tabs.update(tabId, { url }); }
  catch { w.cancel(); return { kind: (await tabAlive(tabId)) ? 'timeout' : 'gone', ms: 0 }; }
  return w.promise;
}
export async function navigateTab(tabId: number, url: string, capMs = 10000): Promise<boolean> {
  const r = await navigateAndWait(tabId, url, capMs);
  return r.kind === 'complete' || r.kind === 'interactive';
}

// ---------------------------------------------------------------- waiting for content

export type ContentKind = 'ready' | 'empty' | 'loading' | 'challenge' | 'timeout' | 'gone' | 'error_page';
/** What "the page changed" means: another URL, more or fewer controls, ~50 chars more or less text, another dialog. */
const sigOf = (p: Readiness) => `${p.url}|${p.interactiveCount}|${Math.round(p.visibleTextLen / 50)}|${p.dialog || ''}`;
const hasContent = (p: Readiness) => p.interactiveCount >= 1 || p.visibleTextLen >= 120;
/** A page with real content. A sparse one (an app's frame: a menu button and a search box, or just "Skip to main
 *  content") is often a single-page app that fills in seconds later, even after it has held still for a moment:
 *  the second live run read YouTube, Reddit and Cursor that way at under a second. */
const isRich = (p: Readiness) => p.visibleTextLen >= 200 || p.interactiveCount >= 10;
const SPARSE_STABLE_MS = 2500, SPARSE_MIN_MS = 3500;
/** A visible progress bar blocks readiness only this long: storage and usage meters on account pages are progress
 *  bars that never go away, and must not cost every such page the full cap. */
const BUSY_GRACE_MS = 4000;

/** One readiness probe; the error kind when the page can't be read right now. */
async function readProbe(tabId: number): Promise<Readiness | TabErrorKind> {
  try { return (await exec(tabId, readinessProbe, [], 3000, true)) || 'other'; } catch (e) { return classifyTabError(e); }
}
/** An error page (or an unscriptable one) counts only once the tab has stopped loading: a redirect may still be on its way. */
async function unreadableFor(tabId: number): Promise<'gone' | 'settled' | 'loading'> {
  try { const t = await browser.tabs.get(tabId); return t.status === 'complete' && !t.pendingUrl ? 'settled' : 'loading'; } catch { return 'gone'; }
}
function atCap(p: Readiness | null, err: TabErrorKind | null): ContentKind {
  if (err === 'error_page' || err === 'no_access') return 'error_page';
  if (!p) return 'timeout';
  if (p.challenge) return 'challenge';
  if (p.loadingText || p.busy) return 'loading';
  if (p.visibleTextLen < 40 && p.interactiveCount === 0) return 'empty';
  return 'timeout';   // has content but never held still (carousels, tickers) or is sparse: callers still read it
}

/**
 * Poll readinessProbe from the extension side (not throttled like the hidden page's own timers) until the page
 * shows something and holds still: after floorMs, the signature unchanged for stableMs, not busy, no loading text,
 * no robot check, and at least one control or ~120 chars of text. A URL change waits for that load (≤ 5s) and
 * starts the stability count over. At the cap the kind says why it wasn't ready (challenge / loading / empty /
 * timeout); an error page or a closed tab ends the wait at once.
 */
export async function waitForContent(tabId: number, opts: { floorMs?: number; stableMs?: number; pollMs?: number; capMs?: number; patientSparse?: boolean } = {}): Promise<{ kind: ContentKind; ms: number; probe: Readiness | null; urlChanged: boolean }> {
  const floorMs = opts.floorMs ?? 300, stableMs = opts.stableMs ?? 700, pollMs = opts.pollMs ?? 300, capMs = opts.capMs ?? 8000;
  const t0 = Date.now(), el = () => Date.now() - t0;
  let probe: Readiness | null = null, sig = '', since = t0, urlChanged = false, lastErr: TabErrorKind | null = null;
  const done = (kind: ContentKind) => ({ kind, ms: el(), probe, urlChanged });
  for (;;) {
    const r = await readProbe(tabId);
    if (typeof r === 'string') {
      lastErr = r; sig = '';
      if (r === 'tab_gone') return done('gone');
      if (r === 'error_page' || r === 'no_access') { const u = await unreadableFor(tabId); if (u === 'gone') return done('gone'); if (u === 'settled') return done('error_page'); }
    } else {
      lastErr = null;
      const moved = !!probe && r.url !== probe.url;
      probe = r;
      if (moved) {
        urlChanged = true; sig = '';
        const left = capMs - el();
        if (left > 0 && (await waitForPage(tabId, Math.min(5000, left))).kind === 'gone') return done('gone');
      } else {
        const s = sigOf(r);
        if (s !== sig) { sig = s; since = Date.now(); }
        const held = r.loadingText || r.challenge || (r.busy && el() < BUSY_GRACE_MS);
        const rich = !opts.patientSparse || isRich(r);   // walks: small dialogs are normal there, read them at once
        if (!held && hasContent(r) && el() >= (rich ? floorMs : Math.max(floorMs, SPARSE_MIN_MS)) && Date.now() - since >= (rich ? stableMs : Math.max(stableMs, SPARSE_STABLE_MS))) return done('ready');
      }
    }
    if (el() >= capMs) break;
    await sleep(Math.min(pollMs, Math.max(0, capMs - el())));
  }
  return done(atCap(probe, lastErr));
}

// ---------------------------------------------------------------- waiting after an action

export interface BeforeAction { probe: Readiness | null; url: string }
export type SettleKind = 'changed' | 'stable' | 'no_effect' | 'timeout' | 'gone' | 'error_page';
/** What the page looks like right before an action, so the settle can tell whether the action did anything. */
export async function captureBefore(tabId: number): Promise<BeforeAction> {
  let url = '';
  try { url = (await browser.tabs.get(tabId)).url || ''; } catch { /* gone: the settle will say so */ }
  const r = await readProbe(tabId);
  return { probe: typeof r === 'string' ? null : r, url };
}

/**
 * Wait for the page to settle after an action. With noEffectMs (clicks): 'changed' once the page differs from
 * `before` and has held still for stableMs, or 'no_effect' when nothing changed within noEffectMs, so the model
 * is told instead of pressing again. Without it (type, select, scroll): 'stable' once the page holds still.
 * A navigation (a pending URL, or a committed URL change) waits for the new page (≤ 8s) first; a failed script
 * call means the document is being replaced, which counts as a change. The tab's URL is watched as well as the
 * page: a slow server response commits well after the 700ms the old fixed wait looked at.
 */
export async function waitForSettle(tabId: number, before: BeforeAction, opts: { capMs: number; stableMs: number; noEffectMs?: number; pollMs?: number }): Promise<{ kind: SettleKind; ms: number; navigated: boolean; loadTimedOut: boolean; probe: Readiness | null }> {
  const pollMs = opts.pollMs ?? 250, needChange = opts.noEffectMs != null, t0 = Date.now(), el = () => Date.now() - t0;
  const sig0 = before.probe ? sigOf(before.probe) : null;
  let changed = needChange && sig0 == null, navigated = false, loadTimedOut = false, probe: Readiness | null = null;
  // A navigation extends the wait so a slow load still gets its stability check, but never past `hard`
  // (a page that redirects in a loop would otherwise keep it going forever).
  const hard = t0 + opts.capMs + 12000;
  let sig = '', since = t0, baseUrl = before.url, deadline = t0 + opts.capMs;
  const done = (kind: SettleKind) => ({ kind, ms: el(), navigated, loadTimedOut, probe });
  for (;;) {
    let t;
    try { t = await browser.tabs.get(tabId); } catch { return done('gone'); }
    if (t.pendingUrl || (!!baseUrl && !!t.url && t.url !== baseUrl)) {
      changed = navigated = true; sig = '';
      const w = await waitForPage(tabId, Math.max(1000, Math.min(8000, hard - Date.now())));
      if (w.kind === 'gone') return done('gone');
      if (w.kind === 'timeout') loadTimedOut = true;
      try { baseUrl = (await browser.tabs.get(tabId)).url || ''; } catch { return done('gone'); }
      deadline = Math.min(hard, Math.max(deadline, Date.now() + opts.stableMs + 1000));
    }
    const r = await readProbe(tabId);
    if (typeof r === 'string') {
      if (r === 'tab_gone') return done('gone');
      if ((r === 'error_page' || r === 'no_access') && (await unreadableFor(tabId)) === 'settled') return done('error_page');
      changed = true; sig = '';
    } else {
      probe = r;
      const s = sigOf(r);
      if (sig0 != null && s !== sig0) changed = true;
      if (s !== sig) { sig = s; since = Date.now(); }
      // A progress bar that was already there (a usage meter) doesn't hold the settle; one the action brought up does.
      const held = r.loadingText || (r.busy && !before.probe?.busy);
      if (!held && Date.now() - since >= opts.stableMs && (!needChange || changed)) return done(needChange ? 'changed' : 'stable');
      if (needChange && !changed && el() >= opts.noEffectMs!) return done('no_effect');
    }
    if (Date.now() >= deadline) return done(needChange && !changed ? 'no_effect' : 'timeout');
    await sleep(pollMs);
  }
}

// ---------------------------------------------------------------- small helpers

export async function focusTab(tabId: number) {
  try { const t = await browser.tabs.get(tabId); await browser.tabs.update(tabId, { active: true }); if (t.windowId != null) await browser.windows.update(t.windowId, { focused: true }); } catch { /* gone */ }
}
export async function tabUrl(tabId: number): Promise<string> { try { return (await browser.tabs.get(tabId)).url || ''; } catch { return ''; } }
/** Is a tab still there? Says nothing about whose it is: see ownedPausedTab before acting on a stored id. */
export async function tabAlive(tabId: number): Promise<boolean> { try { await browser.tabs.get(tabId); return true; } catch { return false; } }
/** Discarded tabs keep their id and url but can't run scripts until reloaded (navigating one reloads it). */
export async function tabDiscarded(tabId: number): Promise<boolean> { try { return !!(await browser.tabs.get(tabId)).discarded; } catch { return false; } }

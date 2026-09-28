/**
 * Two phases per service, one tab.
 *
 *   FIND (during the scan)  Walk the cancellation flow until an offer is on screen, then PAUSE with the
 *                           tab left open. The backend turns the model's accept_offer into "offer found"
 *                           and records which button it would have pressed. Nothing is accepted. Only a
 *                           signed-in account with a confirmed paid plan is ever walked.
 *   ACCEPT (after payment)  In that same tab (only if it is provably still ours), re-read the recorded button,
 *                           run the click-time guard, press it, continue to the confirmation, then verify on the
 *                           billing page. Otherwise re-walk in a fresh tab with the found path as a hint.
 *
 * The backend applies the guardrails; they are re-applied here as defense in depth, and the live button
 * text is re-read at the moment of clicking. "Confirm cancellation" is never clickable anywhere.
 * Element ids carry the snapshot's generation, so a click can never land on an element from an older read.
 */
import { snapshotPage, readElement, performAction, type LiveElement, type PageSnapshot, type SnapshotElement } from '../../shared/page-scripts.js';
import { clickRefusal, acceptLooksRight, applyGuardrails, isAcceptText, looksLikeConfirmPage, newlyCancelled, sameSite, CANCELLED_RE, OFFER_TEXT_RE } from '../../shared/guardrails.js';
import { mockClassify } from '../../shared/brain-mock.js';
import { hostMatches, etld1 } from '../../shared/domains.js';
import { isIdpHost, isLoginUrl } from '../../shared/accounts.js';
import { scrubUrl } from '../../shared/scrub.js';
import { financialPageReason } from '../../shared/sensitive.js';
import { apiPost, apiAvailable } from './api';
import {
  openTab, closeTab, runInTab, sleep, focusTab, tabAlive, tabDiscarded, waitForPage, waitForContent, navigateAndWait,
  captureBefore, waitForSettle, classifyTabError, markPaused, ownedPausedTab, retagTab, unregisterTab, type TabErrorKind,
} from './tabs';
import type { Settings } from './settings';
import type { ScanItem } from './scan';
import type { AgentAction, Decision, FinishDetails, Offer, PageClass, StepResponse } from './types';
import { isBlocked, blockReason, hostOf } from './lists';
import { trace, snapSummary, recordPage } from './trace';

export interface HuntStep { step: number; url: string; state: string; action: AgentAction; target?: string; ok?: boolean; note?: string; guardrails?: string[]; ts: number }
/** Where a find left off: the open tab, the accept button it stopped in front of, and a fingerprint of that screen
 *  (screenOf). A handle without `screen` (stored by an older version) is never accepted in place: it re-walks. */
export interface PausedAt { tabId: number; url: string; acceptId: number; acceptText: string; screen: string }
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
interface LoopOpts { goal: Goal; startStep?: number; history?: HuntStep[]; priorPath?: string[] | null; afterPress?: string }
interface LoopOut { outcome: string; reason: string | null; details: FinishDetails | null; offer: Offer | null; acceptId: number | null; acceptText: string | null; url: string; screen: string }

const errText = (e: unknown) => String((e as any)?.message || e);
const norm = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
/** What the model saw on an element: its text, or the aria-label of an icon button. */
const elText = (e: SnapshotElement | undefined) => norm(e?.text || e?.label);
const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.map((x) => (x || '').toLowerCase().trim()).filter(Boolean))];
/** What the person reads when a tab can't be worked any more. */
const TAB_REASON: Record<TabErrorKind, string> = {
  error_page: 'page failed to load', no_access: 'page failed to load', tab_gone: 'tab was closed',
  frame_gone: 'the page kept changing — stopped', script_timeout: 'the page stopped responding — stopped', other: 'something went wrong on the page — stopped',
};
/** 'brain unavailable' only when the brain really was (stepWithRetry says so); otherwise what actually failed. */
function reasonFor(e: unknown): string {
  const m = errText(e);
  if (/^brain unavailable/i.test(m)) return 'brain unavailable';
  if (/^No API URL/i.test(m)) return 'no backend configured — open Settings';
  if (/^timeout: /i.test(m)) return 'the backend did not answer in time';
  return TAB_REASON[classifyTabError(e)];
}
const settleTrace = (s: { kind: string; ms: number; navigated: boolean; loadTimedOut: boolean }) => ({ kind: s.kind, ms: s.ms, navigated: s.navigated, loadTimedOut: s.loadTimedOut });

/** 53-bit string hash (cyrb53): tells two screens apart without storing their text. */
function hash53(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
/**
 * The fingerprint of the screen a find paused on: the start of its visible text (open dialogs come first), hashed.
 * A modal or SPA flow keeps one URL from the offer to "Are you sure?", so the URL alone can't tell them apart.
 * Clock-like tokens are dropped so an "offer ends in 04:59" countdown doesn't read as a different screen.
 */
function screenOf(snap: PageSnapshot): string {
  const t = norm(snap.text).replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '#').slice(0, 500);
  return t ? hash53(t) : '';
}
const TOGGLE_ROLE_RE = /^(radio|checkbox|switch|option|menuitemradio|menuitemcheckbox)$/i;
/** A radio, checkbox or switch (or the label of one): clicking it changes only its own checked state, which the
 *  settle signature doesn't see. A snapshot label carries its control's type. */
const isToggle = (el: SnapshotElement | undefined, live: LiveElement) =>
  [el?.type, live.type].some((t) => t === 'radio' || t === 'checkbox') || TOGGLE_ROLE_RE.test(el?.role || '');

/** The item's own account host is never treated as an identity provider, even when it looks like one (auth.hbomax.com). */
const ownAccountHost = (item: ScanItem, h: string) => !!h && h === hostOf(item.accountUrl || '');
/**
 * The registrable domains a walk may navigate on: the cookie domain, where the account page actually lives
 * (cursor.sh → cursor.com, primevideo.com → amazon.com) and domains merged into this service. An identity
 * provider the probe ended on is never one of them, and neither is anything sensitive or blocklisted.
 */
function siteDomainsOf(item: ScanItem, settings: Settings): string[] {
  const h = item.url ? hostOf(item.url) : '';
  const landedOnIdp = !!h && isIdpHost(h) && !ownAccountHost(item, h);
  return uniq([item.domain, landedOnIdp ? null : item.siteDomain, ...(item.aliases || [])]).filter((d) => !isBlocked(d, settings.extraBlock)).slice(0, 5);
}
// Whole name parts only: Google's ?authuser=1 picks the signed-in account and must survive.
const SECRET_PARAM_RE = /(^|[_-])(token|session|sessionid|sid|auth|code|state|key|sig|signature|jwt|csrf|xsrf|nonce|scnt|ticket|otp|pass|password|secret)([_-]|$)/i;
const tokenLike = (v: string) => v.length >= 24 && /^[A-Za-z0-9_+/=-]+$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v);
/** A URL fit to open again: one-time tokens in the query or fragment are dropped (not masked: a masked token breaks the page). */
function stripTokens(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) { if (SECRET_PARAM_RE.test(k) || tokenLike(u.searchParams.get(k) || '')) u.searchParams.delete(k); }
    if (u.hash.includes('=')) u.hash = '';
    return u.toString();
  } catch { return url; }
}
/** Where a walk starts: the page the probe landed on when that was this service's own signed-in page (not a
 *  sign-in page), so the walk doesn't redo the probe's redirects and hops; otherwise the account URL. */
function startUrlOf(item: ScanItem): string {
  const u = item.url || '', h = hostOf(u);
  return h && item.siteDomain && hostMatches(h, [item.siteDomain]) && (!isIdpHost(h) || ownAccountHost(item, h)) && !isLoginUrl(u) ? stripTokens(u) : item.accountUrl;
}
function blockedReason(item: ScanItem, settings: Settings): string | null {
  const hosts = [item.domain, hostOf(item.accountUrl), item.url ? hostOf(item.url) : ''];
  return hosts.some((h) => h && isBlocked(h, settings.extraBlock)) ? 'blocklisted site — never explored' : null;
}
/** Why a service must not be walked at all. The scan gates this too; this is the backstop. */
function walkRefusal(item: ScanItem, settings: Settings): string | null {
  if (item.status !== 'signed_in' || item.before?.hasPaidPlan !== true) return 'plan not confirmed — not walked';
  return blockedReason(item, settings);
}
/**
 * The click-time rule on the element as it is NOW (its live text and label), or null when it may be pressed.
 * Every click refuses finalize/decline text, commit verbs (pause, downgrade, buy…) and cancel buttons on a confirm
 * or mid-flow offer screen; an accept must also read like one or be exactly the label the model chose.
 */
function clickRefused(type: string, live: LiveElement, el: SnapshotElement | undefined, pageText: string, history: HuntStep[]): string | null {
  const liveText = norm(live.text);
  for (const t of [liveText, norm(live.label)]) { const why = t ? clickRefusal(t, pageText, history) : null; if (why) return why; }
  if (type !== 'accept_offer') return null;
  const want = elText(el);
  // readElement keeps more of a long label (160 chars) than the snapshot did (120): compare like with like.
  const now = want && liveText.length > want.length && liveText.startsWith(want) ? want : liveText;
  return acceptLooksRight(now, want, pageText, history) ? null : 'does not read like accepting the offer';
}
async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; v: T } | { ok: false; kind: TabErrorKind; msg: string }> {
  try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, kind: classifyTabError(e), msg: errText(e) }; }
}
/** After a click the page signature missed: did the clicked element itself change (checked, disabled, its words)?
 *  Then the click did take, and the model must not be told otherwise. */
async function changedInPlace(tabId: number, id: unknown, gen: string, live: LiveElement): Promise<boolean> {
  const r = await attempt(() => runInTab(tabId, readElement, [id, gen]));
  const now = r.ok ? r.v : null;
  return !!now && (now.checked !== live.checked || now.disabled !== live.disabled || norm(now.text) !== norm(live.text));
}
/** Why a URL must not be opened or read (a never-touch site or one on your never-explore list), or null. */
const urlBlocked = (url: string | undefined, settings: Settings) => { const h = url ? hostOf(url) : ''; return h ? blockReason(h, settings.extraBlock) : null; };
/** Read the walk tab. A document swapped out mid-read or a hung script gets one more try once the page loads. */
async function readSnapshot(tabId: number, domain: string): Promise<PageSnapshot> {
  const args = [{ maxElements: 100, textChars: 3000, domain }];
  let snap: PageSnapshot;
  try { snap = await runInTab(tabId, snapshotPage, args); }
  catch (e) {
    const k = classifyTabError(e);
    if (k !== 'frame_gone' && k !== 'script_timeout') throw e;
    await waitForPage(tabId, 5000);
    snap = await runInTab(tabId, snapshotPage, args);
  }
  if (!snap || typeof snap.url !== 'string') throw new Error('page could not be read');
  return snap;
}
const STALE_NOTE = 'page changed since it was read — reading it again';

/** One decision-act loop on an open tab. Shared by find, accept and the re-walk fallback. */
async function runLoop(tabId: number, item: ScanItem, settings: Settings, onEvent: (e: HuntEvent) => void, steps: HuntStep[], opts: LoopOpts): Promise<LoopOut> {
  const sites = siteDomainsOf(item, settings);
  const merchant = { name: item.name, domain: item.domain, accountUrl: item.accountUrl, siteDomains: sites };
  const maxSteps = settings.maxSteps || 25;
  const history: HuntStep[] = opts.history ? [...opts.history] : [];
  const out: LoopOut = { outcome: 'error', reason: 'step budget exhausted', details: null, offer: null, acceptId: null, acceptText: null, url: '', screen: '' };
  const record = (rec: HuntStep) => { steps.push(rec); history.push(rec); onEvent({ type: 'step', item, step: rec }); };
  // Never silent: once one of our presses went through, a page that newly says the subscription was cancelled ends
  // the walk with an alarm the person sees at once, instead of a quiet "backed out".
  // afterPress: the loop continues right after a press made outside it (the in-place accept), with the page it was made on.
  let acted = opts.afterPress != null, prevText = opts.afterPress ?? '';
  const alarm = (step: number, url: string, why: string) => {
    out.outcome = 'may_have_cancelled'; out.reason = `${why} after our last press. Nothing more was done`;
    trace('step.cancelled', { svc: item.domain, goal: opts.goal, step, url, why });
  };
  /** The tab can't be worked any more (closed, error page, hung): stop with a plain reason. */
  const stopOn = (kind: TabErrorKind, step: number, why: string) => { out.outcome = 'error'; out.reason = TAB_REASON[kind]; trace('step.tab_error', { svc: item.domain, goal: opts.goal, step, errorKind: kind, error: why }); };
  for (let step = opts.startStep || 0; step <= maxSteps; step++) {
    if (stopRequested) { out.outcome = 'error'; out.reason = 'stopped by user'; break; }
    const ts = Date.now();
    let snapshot: PageSnapshot;
    try { snapshot = await readSnapshot(tabId, item.domain); } catch (e) { stopOn(classifyTabError(e), step, errText(e)); break; }
    const snapMs = Date.now() - ts;
    const host = hostOf(snapshot.url);
    const url = scrubUrl(snapshot.url);   // what leaves this loop (history, the pause handle, the log) carries no one-time tokens
    out.url = url;
    if (isBlocked(host, settings.extraBlock)) { out.outcome = 'error'; out.reason = 'landed on a blocked or sensitive site — stopped'; trace('step.blocked', { svc: item.domain, step, url }); break; }
    const fin = financialPageReason(snapshot.text);
    if (fin) { out.outcome = 'error'; out.reason = 'reached a banking or other sensitive page — stopped, nothing clicked'; trace('step.sensitive_page', { svc: item.domain, step, url, why: fin }); break; }
    if (acted && newlyCancelled(snapshot.text, prevText)) { alarm(step, url, 'the page says the subscription was cancelled'); break; }
    prevText = snapshot.text;
    // A password prompt on an identity provider or a sign-in URL: only the person can get past it. No model call.
    if (snapshot.hasPassword && (isIdpHost(host) || isLoginUrl(snapshot.url))) {
      record({ step, url, state: 'login', action: { type: 'finish', outcome: 'blocked_needs_you', reason: 'sign-in required' }, ok: true, ts: Date.now() });
      out.outcome = 'blocked_needs_you'; out.reason = 'the site wants you to sign in again';
      trace('step', { svc: item.domain, goal: opts.goal, step, url, gen: snapshot.gen ?? null, state: 'login', local: 'sign-in wall — no model call', action: { type: 'finish', outcome: 'blocked_needs_you' }, terminal: true, snapMs, page: snapSummary(snapshot) });
      break;
    }
    const tb = Date.now();
    const res = await stepWithRetry({ runId: `${item.domain}-${Date.now()}`, merchant, goal: opts.goal, step, maxSteps, history, snapshot, priorPath: opts.priorPath || null }, item.domain, step);
    const brainMs = Date.now() - tb;
    // The server judged the sanitized snapshot; judge the same URL here so loop detection agrees.
    const local = applyGuardrails({ decision: res.decision as Decision, snapshot: { ...snapshot, url }, history, merchantDomain: sites, step, maxSteps, goal: opts.goal });
    const decision: Decision = local.decision;
    const a = decision.action;
    const el = a.id != null ? snapshot.elements.find((e) => e.id === a.id) : undefined;
    const target = elText(el) || undefined;
    const rec: HuntStep = { step, url, state: decision.state, action: a, target, guardrails: [...res.guardrails, ...local.notes], ts: Date.now() };
    const stepTrace: Record<string, unknown> = {
      svc: item.domain, goal: opts.goal, step, url, gen: snapshot.gen ?? null, offSite: !!host && !hostMatches(host, sites),
      state: decision.state, reasoning: (res.decision as any)?.reasoning ?? null,
      proposed: res.proposed ? { type: res.proposed.type, id: res.proposed.id ?? null } : null,
      action: { type: a.type, id: a.id ?? null, target: target ?? null, outcome: a.outcome ?? null, url: a.url ? scrubUrl(a.url) : null, text: a.type === 'type' ? a.text ?? null : undefined, reason: a.reason ?? null },
      changedByGuardrail: !!res.proposed && res.proposed.type !== a.type, guardrails: rec.guardrails,
      offer: a.offer ?? null, snapMs, brainMs, page: snapSummary(snapshot),
    };
    // The page exactly as the model saw it, with its decision: a real cancellation flow, replayable as a test.
    recordPage({ svc: item.domain, name: item.name, phase: opts.goal, step, state: decision.state, reasoning: (res.decision as any)?.reasoning ?? null,
      proposed: res.proposed ? { type: res.proposed.type, id: res.proposed.id ?? null } : null,
      action: { type: a.type, id: a.id ?? null, target: target ?? null, outcome: a.outcome ?? null, url: a.url ? scrubUrl(a.url) : null, reason: a.reason ?? null, offer: a.offer ?? null },
      guardrails: rec.guardrails, siteDomains: sites }, snapshot);
    if (acted && decision.state === 'cancellation_completed') {
      rec.ok = true; record(rec); trace('step', { ...stepTrace, terminal: true });
      alarm(step, url, 'the model read this page as a finished cancellation'); break;
    }
    const ta = Date.now();
    /** Nothing was done: the ids are from an older read of the page. Read it again next step. */
    const stale = () => { rec.ok = false; rec.note = STALE_NOTE; record(rec); trace('step', { ...stepTrace, stale: true, note: rec.note, actMs: Date.now() - ta }); };
    /** Refused here, nothing done: the walk backs out with the reason, as the guardrail's own back_out would. */
    const refuse = (note: string, extra: Record<string, unknown>) => {
      rec.ok = false; rec.note = note; record(rec);
      out.outcome = 'no_offer_backed_out'; out.reason = note;
      trace('step', { ...stepTrace, ...extra, note });
    };
    let stopKind: TabErrorKind | null = null;

    if (a.type === 'finish' || a.type === 'back_out') {
      rec.ok = true; record(rec);
      out.outcome = a.type === 'finish' ? (a.outcome || 'error') : 'no_offer_backed_out';
      out.reason = a.reason || null; out.details = a.details || null; out.offer = a.offer || null;
      if (a.type === 'finish' && a.outcome === 'offer_found') { out.acceptId = a.id ?? null; out.acceptText = target ?? null; out.screen = screenOf(snapshot); }
      if (a.type === 'back_out' && /^ai_declined/.test(a.reason || '')) out.outcome = 'ai_declined';
      trace('step', { ...stepTrace, terminal: true });
      break;
    }
    if (a.type === 'click' || a.type === 'accept_offer') {
      // A link into a blocked or sensitive site is refused before the click: the next read would already be too late
      // (the page would have opened with your session). The guardrail knows only the built-in list, not yours.
      const linkWhy = urlBlocked(el?.href, settings);
      if (linkWhy) { refuse(`refused at click time: the link goes to a blocked or sensitive site (${linkWhy})`, { clickRefused: true, blockedLink: true }); break; }
      const lr = await attempt(() => runInTab(tabId, readElement, [a.id, snapshot.gen]));
      if (!lr.ok && lr.kind !== 'frame_gone') { rec.ok = false; rec.note = TAB_REASON[lr.kind]; stopKind = lr.kind; }
      else {
        const live = lr.ok ? lr.v : null;
        // null: the id is from an older read, or the element was re-rendered away. Tag differs: not the same element.
        if (!live || (!!el && !!live.tag && live.tag !== el.tag)) { stale(); continue; }
        const refused = clickRefused(a.type, live, el, snapshot.text, history);
        if (refused) { refuse(`refused at click time: ${refused}`, { clickRefused: true, liveText: live.text }); break; }
        const before = await captureBefore(tabId);
        // Never retried: if the frame vanished mid-call the click may already have happened. `expect` makes the page
        // re-check the label at the click itself: it may have changed in place during captureBefore.
        const sameTab = !!(el?.newTab && el.href && sameSite(el.href, sites));   // a same-site link that would open a blocked popup
        const r = await attempt(() => runInTab(tabId, performAction, [{ type: 'click', id: a.id, gen: snapshot.gen, expect: live.text, sameTab }], { retry: false }));
        if (!r.ok && r.kind !== 'frame_gone') { rec.ok = false; rec.note = TAB_REASON[r.kind]; stopKind = r.kind; }
        else if (r.ok && /page changed since it was read/i.test(r.v?.note || '')) { stale(); continue; }
        else {
          acted = true;
          const pr = r.ok ? r.v : { ok: true, note: 'the page changed during the click (it may have gone through)' };
          rec.ok = !!pr?.ok; rec.note = pr?.note;
          if (rec.ok) {
            // A survey radio or checkbox changes nothing the settle signature sees: wait for the page to hold still
            // instead of for a change, or every answer would be reported to the model as a failed click.
            const toggle = isToggle(el, live);
            const st = await waitForSettle(tabId, before, toggle ? { capMs: 8000, stableMs: 700 } : { capMs: 8000, stableMs: 700, noEffectMs: 2500 });
            stepTrace.settle = settleTrace(st);
            if (toggle) stepTrace.toggle = true;
            // So the model changes course instead of pressing again; unless the element itself changed (the click took).
            if (st.kind === 'no_effect' && !(await changedInPlace(tabId, a.id, snapshot.gen, live))) rec.note = `${rec.note || 'clicked'} · click had no visible effect`;
            if (st.kind === 'gone') stopKind = 'tab_gone'; else if (st.kind === 'error_page') stopKind = 'error_page';
          }
        }
      }
    } else if (a.type === 'type' || a.type === 'select' || a.type === 'scroll') {
      const before = await captureBefore(tabId);
      const r = await attempt(() => runInTab(tabId, performAction, [{ ...a, gen: snapshot.gen }], { retry: false }));
      if (!r.ok && r.kind !== 'frame_gone') { rec.ok = false; rec.note = TAB_REASON[r.kind]; stopKind = r.kind; }
      else if (r.ok && /page changed since it was read/i.test(r.v?.note || '')) { stale(); continue; }
      else {
        const pr = r.ok ? r.v : { ok: true, note: 'the page changed during the action' };
        rec.ok = !!pr?.ok; rec.note = pr?.note;
        if (a.type !== 'scroll') acted = true;
        const st = await waitForSettle(tabId, before, { capMs: 1500, stableMs: 500 });
        stepTrace.settle = settleTrace(st);
        if (st.kind === 'gone') stopKind = 'tab_gone'; else if (st.kind === 'error_page') stopKind = 'error_page';
      }
    } else if (a.type === 'navigate' && a.url) {
      // The model saw hrefs with one-time tokens masked (sanitizeSnapshot); a masked link would open broken, so go to
      // the raw href of the element it names. The guardrail already checked the host, which masking never changes.
      const raw = snapshot.elements.find((e) => e.href && e.href !== a.url && scrubUrl(e.href) === a.url)?.href;
      // Same-site is not enough: wallet.google.com is on google.com, and your never-explore list is only known here.
      const navWhy = urlBlocked(raw || a.url, settings);
      if (navWhy) { refuse(`refused to open a blocked or sensitive site (${navWhy})`, { blockedNav: true }); break; }
      acted = true;
      const w = await navigateAndWait(tabId, raw || a.url, 10000);
      let c = w.kind === 'gone' ? null : await waitForContent(tabId, { capMs: 8000 });
      if (c?.kind === 'error_page') {
        // A page that doesn't load (a guessed path): go back to where the walk was and say so, rather than end the walk.
        rec.note = 'that page failed to load — went back';
        const back = await navigateAndWait(tabId, snapshot.url, 10000);
        c = back.kind === 'gone' ? null : await waitForContent(tabId, { capMs: 8000 });
      }
      rec.ok = !!c && c.kind !== 'gone' && c.kind !== 'error_page' && !rec.note;
      stepTrace.settle = { kind: c?.kind ?? 'gone', ms: Date.now() - ta, navigated: true, loadTimedOut: w.kind === 'timeout' };
      if (!c || c.kind === 'gone') stopKind = 'tab_gone'; else if (c.kind === 'error_page') stopKind = 'error_page';
    } else {
      // wait (and anything unexpected): until the page shows something and holds still, at most 3s.
      const c = await waitForContent(tabId, { floorMs: 300, stableMs: 700, capMs: 3000 });
      rec.ok = true;
      stepTrace.settle = { kind: c.kind, ms: c.ms, navigated: c.urlChanged, loadTimedOut: false };
      if (c.kind === 'gone') stopKind = 'tab_gone';
    }
    record(rec);
    trace('step', { ...stepTrace, ok: rec.ok ?? null, note: rec.note ?? null, actMs: Date.now() - ta });
    if (stopKind) { stopOn(stopKind, step, `after ${a.type}`); break; }
  }
  if (out.reason === 'step budget exhausted') trace('step.budget_exhausted', { svc: item.domain, goal: opts.goal, maxSteps });
  return out;
}

// ---------------------------------------------------------------- FIND (scan)

export async function findOne(item: ScanItem, settings: Settings, onEvent: (e: HuntEvent) => void): Promise<FindResult> {
  const steps: HuntStep[] = [];
  const result: FindResult = { outcome: 'error', reason: null, offer: null, paused: null, path: steps };
  const refusal = walkRefusal(item, settings);
  if (refusal) { result.reason = refusal; trace('find.skipped', { svc: item.domain, why: refusal }); onEvent({ type: 'found', item, result }); return result; }
  let tabId: number | undefined;
  try {
    if (!(await apiAvailable())) throw new Error('No API URL configured — open Settings (⚙).');
    const startUrl = startUrlOf(item);
    tabId = await openTab(startUrl, false, { purpose: 'walk', svc: item.domain });   // the scan always works in the background
    onEvent({ type: 'start', item, tabId });
    const load = await waitForPage(tabId, 12000);
    const ready = load.kind === 'gone' ? null : await waitForContent(tabId, { capMs: 8000 });
    trace('find.start', {
      svc: item.domain, accountUrl: scrubUrl(item.accountUrl), startUrl: scrubUrl(startUrl), fromProbe: startUrl !== item.accountUrl, sites: siteDomainsOf(item, settings),
      loadKind: load.kind, loadMs: load.ms, loadTimedOut: load.kind === 'timeout',
      ready: ready ? { kind: ready.kind, ms: ready.ms, visibleTextLen: ready.probe?.visibleTextLen ?? null, interactiveCount: ready.probe?.interactiveCount ?? null, urlChanged: ready.urlChanged } : null,
    });
    if (!ready || ready.kind === 'gone') result.reason = TAB_REASON.tab_gone;
    else if (ready.kind === 'error_page') result.reason = TAB_REASON.error_page;
    else if (ready.kind === 'challenge') result.reason = 'the site asked for a robot check';
    else {
      const out = await runLoop(tabId, item, settings, onEvent, steps, { goal: 'find' });
      result.outcome = out.outcome; result.reason = out.reason; result.offer = out.offer;
      if (out.outcome === 'offer_found') {
        if (out.acceptId != null) { result.paused = { tabId, url: out.url, acceptId: out.acceptId, acceptText: out.acceptText || '', screen: out.screen }; await markPaused(tabId, item.domain, out.url); }
        else { result.outcome = 'error'; result.reason = 'offer reported without an accept button'; }
      }
    }
  } catch (e) {
    result.outcome = 'error'; result.error = errText(e); result.reason = reasonFor(e);
  } finally {
    // Only a paused tab stays open, so the accept can happen on the very screen that was found. After an alarm the tab
    // is the person's: left open, since the site's own undo is often right there.
    if (tabId !== undefined && !result.paused) {
      if (result.outcome === 'may_have_cancelled') await unregisterTab(tabId); else await closeTab(tabId);
    }
  }
  onEvent({ type: 'found', item, result });
  return result;
}

/**
 * Find offers on several services at once; each one is its own background tab. Two services that share a site
 * (cursor.sh and cursor.com both land on cursor.com) are never walked at the same time: they may be one account,
 * and two tabs in one cancellation flow would trip over each other. A worker skips ahead to an unlocked service
 * rather than wait, and nothing is ever dropped.
 */
export async function findAll(items: ScanItem[], settings: Settings, onEvent: (e: HuntEvent) => void, concurrency = 3): Promise<Map<string, FindResult>> {
  stopRequested = false;
  const out = new Map<string, FindResult>();
  const queue = [...items];
  const busy = new Set<string>();
  const waiting: (() => void)[] = [];
  const keysOf = (i: ScanItem) => uniq([i.domain, i.siteDomain, ...(i.aliases || []), etld1(hostOf(i.url || i.accountUrl))]);
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length && !stopRequested) {
      const at = queue.findIndex((i) => keysOf(i).every((k) => !busy.has(k)));
      // Everything left shares a site with a walk in flight: wait for one to finish (no await between the check
      // and the push, so a release can't slip past).
      if (at < 0) { await new Promise<void>((r) => waiting.push(r)); continue; }
      const item = queue.splice(at, 1)[0]!;
      const keys = keysOf(item);
      keys.forEach((k) => busy.add(k));
      try { out.set(item.id, await findOne(item, settings, onEvent)); }
      finally { keys.forEach((k) => busy.delete(k)); for (const w of waiting.splice(0)) w(); }
    }
  }));
  return out;
}

/** Let go of a tab held on an offer: close it only if it is provably still ours (a stored id may name any tab of
 *  the user's after a browser restart); always drop the handle. Nothing is clicked. */
export async function releasePaused(item: ScanItem): Promise<void> {
  const p = item.paused;
  item.paused = null;
  if (p && (await ownedPausedTab(p))) await closeTab(p.tabId);
}
/** Close the tabs left open for services the user did not pick. Nothing is clicked. */
export async function closePaused(items: ScanItem[]): Promise<void> {
  for (const i of items) await releasePaused(i);
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
  const blocked = blockedReason(item, settings);
  if (blocked) { result.reason = blocked; await releasePaused(item); onEvent({ type: 'done', item, result }); return result; }
  const paused = item.paused;
  let tabId: number | undefined;   // only ever a tab this accept may use: the paused one if provably ours, or one it opened
  try {
    if (!(await apiAvailable())) throw new Error('No API URL configured — open Settings (⚙).');
    // Anything else (after a browser restart the id may be any tab of yours) is left alone; the accept re-walks.
    const owned = await ownedPausedTab(paused);
    if (owned && paused) { tabId = paused.tabId; await retagTab(tabId, 'accept', item.domain); }
    const discarded = tabId != null && (await tabDiscarded(tabId));
    trace('accept.start', { svc: item.domain, paused: !!paused, owned, discarded });

    const fingerprinted = !!paused?.screen;   // a handle stored before screens were fingerprinted is never pressed in place
    let accepted = false, why = !paused ? 'no paused tab' : !owned ? 'paused tab is gone or not ours' : discarded ? 'paused tab was discarded'
      : !fingerprinted ? 'paused by an older version (no screen fingerprint)' : 'recorded button not on screen';
    if (paused && tabId != null && !discarded && fingerprinted) {
      onEvent({ type: 'start', item, tabId });
      let attempted = false;
      try {
        // The paused screen must still be showing: same URL, same fingerprint, no final-confirmation wording, still an
        // offer. The user may have pressed the site's decline in that tab, or the offer timed out into the next step,
        // where "Continue" or "Confirm" finalizes. Read before focusing: the find fingerprinted a background tab.
        const snapshot = await readSnapshot(tabId, item.domain);
        if (settings.watch) await focusTab(tabId);
        const want = norm(paused.acceptText);
        const history = item.path || [];   // the find walk: the click-time rule looks at what came before the offer
        const screenWhy = scrubUrl(snapshot.url) !== paused.url ? 'the tab is on another page' : screenOf(snapshot) !== paused.screen ? 'the offer screen changed'
          : looksLikeConfirmPage(snapshot.text) ? 'the tab shows a final-confirmation step' : !OFFER_TEXT_RE.test(snapshot.text) ? 'no offer on screen any more' : null;
        // Re-read the recorded accept button by id and text. Only a label that reads like accepting may be found by
        // its text alone: "Continue" or "Confirm" could be any step's button. An empty recorded label never matches.
        const byId = snapshot.elements.find((e) => e.id === paused.acceptId && elText(e) === want);
        const el = !want || screenWhy ? undefined : byId || (isAcceptText(want) ? snapshot.elements.find((e) => elText(e) === want) : undefined);
        if (screenWhy) why = screenWhy;
        else if (el && !acceptLooksRight(want, want, snapshot.text, history)) why = 'recorded button no longer reads like accepting the offer';
        else if (el) {
          const live = await runInTab(tabId, readElement, [el.id, snapshot.gen]);
          const linkWhy = urlBlocked(el.href, settings);
          const refused = linkWhy ? `the button links to a blocked or sensitive site (${linkWhy})` : !live ? 'button changed since it was read'
            : live.tag && live.tag !== el.tag ? 'not the same element any more' : clickRefused('accept_offer', live, el, snapshot.text, history);
          if (refused || !live) why = `live re-check: ${refused}`;
          else {
            const tid = tabId, before = await captureBefore(tid);
            attempted = true;
            // Never retried. A frame that vanishes mid-click usually means the click navigated: carry on to the
            // confirmation screen and let the billing page decide. Any other failure goes to verification. `expect`:
            // the page re-checks the label at the click itself, so a button re-rendered in place is not pressed.
            const pa = await attempt(() => runInTab(tid, performAction, [{ type: 'click', id: el.id, gen: snapshot.gen, expect: live.text }], { retry: false }));
            if (!pa.ok && pa.kind !== 'frame_gone') throw new Error(pa.msg);
            const r = pa.ok ? pa.v : { ok: true, note: 'the page changed during the click (it may have gone through)' };
            const rec: HuntStep = { step: 0, url: scrubUrl(snapshot.url), state: 'save_offer_presented', action: { type: 'accept_offer', id: el.id, offer: item.offer }, target: want, ok: !!r?.ok, note: !pa.ok ? r.note : r?.ok ? 'accepted the offer found during the scan' : (r?.note || 'click failed'), ts: Date.now() };
            if (r?.ok) {
              accepted = true;
              const st = await waitForSettle(tabId, before, { capMs: 8000, stableMs: 700, noEffectMs: 2500 });
              if (st.kind === 'no_effect') rec.note += ' · click had no visible effect';
              steps.push(rec); onEvent({ type: 'step', item, step: rec });
              trace('accept.click', { svc: item.domain, target: want, settle: settleTrace(st) });
              if (st.kind === 'gone' || st.kind === 'error_page') { result.outcome = 'error'; result.reason = TAB_REASON[st.kind === 'gone' ? 'tab_gone' : 'error_page']; }
              else {
                // Carry the find path: the click-time rule then knows this screen is inside the cancel flow, so a
                // "Continue to cancel" under the offer the user just paid for is refused, here and on the server.
                const found = (item.path || []).filter((s) => s.action.type !== 'finish');
                const out = await runLoop(tabId, item, settings, onEvent, steps, { goal: 'hunt', startStep: 1, history: [...found, rec], afterPress: snapshot.text });
                result.outcome = out.outcome; result.reason = out.reason; result.details = out.details;
              }
            } else why = `click did not go through: ${rec.note}`;   // performAction refused before pressing: re-walk
          }
        }
      } catch (e) {
        // Before the click, a page that can't be read only means re-walking. Once a click was attempted it may have
        // happened (and the user has paid): never press again, go straight to verification.
        if (attempted) { accepted = true; result.outcome = 'error'; result.reason = reasonFor(e); result.error = errText(e); }
        why = `page could not be worked (${classifyTabError(e)})`;
        trace('accept.in_place_error', { svc: item.domain, attempted, errorKind: classifyTabError(e), error: errText(e) });
      }
    }
    if (!accepted) {
      // The screen changed, or the tab is gone or not ours: walk again from the account page with the route the
      // find phase took as a hint. Same guardrails, same loop.
      result.phase = 'rewalk';
      const url = startUrlOf(item);
      if (tabId != null && (await tabAlive(tabId))) { await navigateAndWait(tabId, url, 12000); if (settings.watch) await focusTab(tabId); }   // ours; navigating also reloads a discarded tab
      else { tabId = await openTab(url, settings.watch, { purpose: 'accept', svc: item.domain }); await waitForPage(tabId, 12000); }
      onEvent({ type: 'start', item, tabId });
      const ready = await waitForContent(tabId, { capMs: 8000 });
      trace('accept.rewalk', { svc: item.domain, why, startUrl: scrubUrl(url), ready: { kind: ready.kind, ms: ready.ms } });
      if (ready.kind === 'gone' || ready.kind === 'error_page') { result.outcome = 'error'; result.reason = TAB_REASON[ready.kind === 'gone' ? 'tab_gone' : 'error_page']; }
      else {
        const priorPath = (item.path || []).filter((s) => s.action.type !== 'finish').map((s) => `${s.state}: ${s.action.type}${s.target ? ` "${s.target.slice(0, 60)}"` : ''} @ ${scrubUrl(s.url)}`);
        const out = await runLoop(tabId, item, settings, onEvent, steps, { goal: 'hunt', priorPath });
        result.outcome = out.outcome; result.reason = out.reason; result.details = out.details;
      }
    }

    // Verify on the account page, whatever happened (in a fresh background tab if the user closed ours).
    onEvent({ type: 'verify', item });
    const vUrl = startUrlOf(item);
    if (tabId == null || !(await tabAlive(tabId))) { tabId = await openTab(vUrl, false, { purpose: 'accept', svc: item.domain }); await waitForPage(tabId, 12000); }
    else await navigateAndWait(tabId, vUrl, 12000);
    const vr = await waitForContent(tabId, { capMs: 8000 });
    // Only this service's own billing page goes to the model. A redirect to a host on your never-explore list is not
    // even read (the server knows only the built-in list), and a banking-like page is not sent: unverified instead.
    let skip = urlBlocked(vr.probe?.url, settings);
    const snap = skip ? null : await runInTab(tabId, snapshotPage, [{ maxElements: 80, textChars: 4000, domain: item.domain }]);
    if (snap) skip = urlBlocked(snap.url, settings) || (financialPageReason(snap.text) ? 'reads like a banking or other sensitive page' : null);
    let after: PageClass | null = null;
    // Never silent, here too: a billing page that says the subscription was cancelled overrides whatever the walk thought.
    if (snap && !skip && !item.pageSaidCancelled && CANCELLED_RE.test(snap.text) && result.outcome !== 'may_have_cancelled') {
      result.outcome = 'may_have_cancelled'; result.reason = 'the billing page says the subscription was cancelled';
      trace('accept.cancelled', { svc: item.domain, url: scrubUrl(snap.url) });
    }
    if (skip || !snap) trace('accept.verify_skipped', { svc: item.domain, why: skip });
    else after = (await apiPost<{ result: PageClass }>('/api/classify', { domain: item.domain, name: item.name, snapshot: snap, readiness: vr.probe ?? undefined }).catch(() => ({ result: mockClassify(snap, item.domain) }))).result;
    result.after = after;
    const before = item.before?.monthlyPriceUsd ?? item.monthlyPrice;
    const term = result.details?.termMonths ?? (result.outcome === 'discount_applied' ? item.termMonths : null);
    if (result.outcome === 'discount_applied') {
      if (!after || (!after.offerApplied && (before == null || after.monthlyPriceUsd == null || after.monthlyPriceUsd >= before))) {
        result.outcome = 'error'; result.reason = 'could not verify a lower price on the billing page';
      } else if (before != null && after.monthlyPriceUsd != null) {
        result.termMonths = term; result.savingsUsd = +(((before - after.monthlyPriceUsd) * (term || 1))).toFixed(2);
      } else { result.termMonths = term; result.savingsUsd = result.details?.savingsUsd ?? null; }
    }
  } catch (e) {
    // Nothing is ever clicked without a decision: an outage, a refused API call or a dead tab ends the run here.
    result.outcome = 'error'; result.error = errText(e); result.reason = reasonFor(e);
  } finally {
    item.paused = null;
    // Watching, or after an alarm: the tab stays open for the user and is theirs now, so no later sweep may close it.
    if (tabId !== undefined) { if (settings.watch || result.outcome === 'may_have_cancelled') await unregisterTab(tabId); else await closeTab(tabId); }
  }
  onEvent({ type: 'done', item, result });
  return result;
}

/** The brain is remote; retry transient failures (timeouts included) before giving up. No decision → no click. */
async function stepWithRetry(body: unknown, svc = '', step = -1): Promise<StepResponse> {
  let last: any;
  for (let i = 0; i < 3; i++) {
    try { return await apiPost<StepResponse>('/api/agent-step', body); }
    catch (e: any) { last = e; trace('step.retry', { svc, step, attempt: i + 1, error: String(e?.message || e) }); if (/unauthorized|No API URL/i.test(String(e?.message))) break; if (i < 2) await sleep(1500 * (i + 1)); }
  }
  throw new Error(`brain unavailable: ${String(last?.message || last)}`);
}

// A deterministic, rule-based brain for tests (no API spend). Conservative: when unsure, it backs out.
// Also home of guardPageClass: the server-side checks every page classification passes (model, mock and fallback).
import { FINALIZE_RE, ACCEPT_RE } from './guardrails.js';
import { etld1 } from './domains.js';
import { orgAccountReason } from './accounts.js';

const NULLS = { id: null, text: null, value: null, url: null, direction: null, reason: null, offer: null, outcome: null, details: null };
const act = (type, extra) => ({ ...NULLS, type, ...extra });
const etext = (e) => `${e.text || ''} ${e.label || ''}`.trim();
const hostOf = (u, base) => { try { return new URL(u, base || undefined).hostname; } catch { return ''; } };

// PageClass enums, shared with the zod schema in netlify/functions/lib/brain.mjs.
export const PAGE_KINDS = ['account_billing', 'account_other', 'login', 'reauth', 'not_found', 'error', 'loading', 'bot_challenge', 'marketing', 'other'];
export const ACCOUNT_TYPES = ['personal', 'work_or_team', 'unknown'];
export const BILLED_VIA = ['direct', 'bundle_or_partner', 'app_store', 'carrier', 'employer', 'unknown'];
const CADENCES = ['month', 'year', 'week', 'unknown'];

// The page reader normalizes units to month/year/week/quarter; older snapshots (and logs) carry mo/yr/annually/wk.
const UNIT = { month: 'month', mo: 'month', monthly: 'month', year: 'year', yr: 'year', annually: 'year', annual: 'year', yearly: 'year', week: 'week', wk: 'week', weekly: 'week', quarter: 'quarter', quarterly: 'quarter' };
export const normUnit = (u) => UNIT[String(u || '').toLowerCase()] || '';
const isUsd = (p) => !p.currency || String(p.currency).toUpperCase() === 'USD';
const perMonth = (amount, unit) => (unit === 'year' ? amount / 12 : unit === 'week' ? amount * 52 / 12 : unit === 'quarter' ? amount / 3 : amount);
const round2 = (n) => Math.round(n * 100) / 100;

/** The price most likely to be the plan's: a USD monthly price, else yearly, weekly, quarterly, else the first unitless one. */
function pickPrice(prices) {
  const list = (prices || []).map((p, i) => ({ p, i })).filter(({ p }) => p && typeof p.amount === 'number' && p.amount >= 1 && p.amount <= 500 && isUsd(p));
  for (const u of ['month', 'year', 'week', 'quarter', '']) {
    const hit = list.find(({ p }) => normUnit(p.unit) === u);
    if (hit) return { ...hit, unit: u, monthly: round2(perMonth(hit.p.amount, u)) };
  }
  return null;
}
function monthlyFromPrices(prices) { const c = pickPrice(prices); return c ? c.monthly : null; }

// Addresses that are never the account holder's: role mailboxes, and file names that look like emails (logo@2x.png).
const ROLE_LOCAL_RE = /^(support|help|billing|invoices?|noreply|no-reply|donotreply|do-not-reply|privacy|legal|info|contact|hello|team|sales|press|security|abuse|feedback|jobs|careers|admin|service|care|accounts?)$/i;
function acceptableEmail(v) {
  const e = String(v || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e) || /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(e)) return false;
  return !ROLE_LOCAL_RE.test(e.split('@')[0]);
}

export function mockClassifyState(snapshot) {
  const t = (snapshot.text || '').toLowerCase();
  const els = snapshot.elements || [];
  if (snapshot.hasPassword && !els.some((e) => /sign out|log out/i.test(etext(e)))) return 'login';
  if (/(you're all set|you’re all set|offer applied:|discount applied:)/.test(t)) return 'offer_accepted_confirmation';
  if (els.some((e) => ACCEPT_RE.test(etext(e))) && /(% off|off for|discount|special offer|before you go|wait|stay for|keep .* for \$)/.test(t)) return 'save_offer_presented';
  if (/(are you sure|confirm cancel|you'll lose access|you’ll lose access|last chance)/.test(t) && els.some((e) => FINALIZE_RE.test(etext(e)))) return 'about_to_finalize_cancel';
  if (/(has been cancell?ed|cancellation (is )?complete|subscription cancell?ed)/.test(t)) return 'cancellation_completed';
  if (/(why are you (cancel|leav)|tell us why|reason for (cancel|leav)|sorry to see you go)/.test(t)) return 'reason_survey';
  if (/(subscription|billing|membership|your plan)/.test(t) && els.some((e) => /cancel/i.test(etext(e)))) return 'subscription_page';
  if (/(settings|account)/.test(t)) return 'settings';
  return 'other';
}

export function mockDecide(input) {
  const { snapshot, history = [], goal, merchant } = input;
  const els = snapshot.elements || [];
  const state = mockClassifyState(snapshot);
  const find = (re, extra) => els.find((e) => !e.disabled && re.test(etext(e)) && !FINALIZE_RE.test(etext(e)) && (!extra || extra(e)));
  const t = (snapshot.text || '').toLowerCase();
  // Dismiss a newsletter/marketing popup that covers the page.
  if (/newsletter|merch/.test(t)) { const closer = els.find((e) => /^(close|×|maybe later|dismiss)$/i.test(etext(e)) || /close/i.test(e.label || '')); if (closer && !history.some((h) => h.action && h.action.id === closer.id && h.url === snapshot.url)) return { state, reasoning: 'mock: closing popup', action: act('click', { id: closer.id }) }; }
  const clicks = history.filter((h) => h.action && (h.action.type === 'click' || h.action.type === 'navigate')).length;
  const reasoning = `mock brain: state=${state}`;
  if (goal === 'verify') {
    const monthly = monthlyFromPrices(snapshot.prices);
    return { state, reasoning, action: act('finish', { outcome: 'discount_applied', details: { beforeMonthlyPriceUsd: null, afterMonthlyPriceUsd: monthly, termMonths: null, savingsUsd: null, summary: `verify: monthly price now ${monthly}` } }) };
  }
  if (/(loading your options|one moment|please wait)/.test((snapshot.text || '').toLowerCase()) && !history.slice(-2).every((h) => h.action && h.action.type === 'wait')) return { state, reasoning: 'mock: page still loading', action: act('wait', {}) };
  if (state === 'login') return { state, reasoning, action: act('finish', { outcome: 'blocked_needs_you', details: { beforeMonthlyPriceUsd: null, afterMonthlyPriceUsd: null, termMonths: null, savingsUsd: null, summary: 'Login required.' } }) };
  if (state === 'save_offer_presented') {
    const btn = find(/accept/i) || find(ACCEPT_RE);
    if (btn) {
      // Read the offer's terms the way a person would: the button first, then the page. Percent, free months, or a fixed price.
      const bt = btn.text || '', src = bt + ' ' + (snapshot.text || '');
      const pm = bt.match(/(\d+)%\s*off\s*(?:for\s*)?(\d+)\s*months?/i) || src.match(/(\d+)%\s*off\s*(?:for\s*)?(\d+)\s*months?/i);
      const fm = src.match(/(\d+)\s*(?:free\s+months?|months?\s+free)/i);
      const dm = src.match(/\$\s?(\d+(?:\.\d{2})?)\s*\/\s*(?:mo|month)\b[^.]*?(\d+)\s*months?/i);
      const base = { description: bt || 'offer', newMonthlyPriceUsd: null, discountPct: null, termMonths: null, freeMonths: null };
      const offer = pm ? { ...base, discountPct: +pm[1] / 100, termMonths: +pm[2] }
        : fm ? { ...base, freeMonths: +fm[1] }
        : dm ? { ...base, newMonthlyPriceUsd: +dm[1], termMonths: +dm[2] }
        : base;
      return { state, reasoning, action: act('accept_offer', { id: btn.id, offer }) };
    }
    return { state, reasoning, action: act('back_out', { reason: 'offer seen but no accept button found' }) };
  }
  if (state === 'offer_accepted_confirmation') {
    return { state, reasoning, action: act('finish', { outcome: 'discount_applied', details: { beforeMonthlyPriceUsd: null, afterMonthlyPriceUsd: monthlyFromPrices(snapshot.prices), termMonths: null, savingsUsd: null, summary: 'Offer accepted; confirmation page seen.' } }) };
  }
  if (state === 'about_to_finalize_cancel' || state === 'cancellation_completed') return { state, reasoning, action: act('back_out', { reason: 'no offer before the final step' }) };
  if (state === 'reason_survey') {
    const radio = els.find((e) => e.type === 'radio' && !e.checked && !e.disabled);
    const anyChecked = els.some((e) => e.type === 'radio' && e.checked);
    if (radio && !anyChecked) return { state, reasoning, action: act('click', { id: radio.id }) };
    const box = els.find((e) => e.type === 'checkbox' && !e.checked && !e.disabled);
    if (box) return { state, reasoning, action: act('click', { id: box.id }) };
    const sel = els.find((e) => e.tag === 'select' && !e.value);
    if (sel && sel.options && sel.options[1]) return { state, reasoning, action: act('select', { id: sel.id, value: sel.options[1] }) };
    const ta = els.find((e) => e.tag === 'textarea' && !e.value);
    if (ta && !history.some((h) => h.action && h.action.type === 'type' && h.url === snapshot.url)) return { state, reasoning, action: act('type', { id: ta.id, text: 'Too expensive.' }) };
    const cont = find(/^(continue|next|submit|proceed|i understand|yes, continue)$/i) || find(/continue|next|submit/i);
    if (cont) return { state, reasoning, action: act('click', { id: cont.id }) };
  }
  // Interstitials: benefits / pause / downgrade — decline the trap, keep going. Hidden offers: reveal them.
  const reveal = find(/see (my )?offer|view (my )?offer|show (me )?(my )?offer/i);
  if (reveal) return { state, reasoning: 'mock: reveal offer', action: act('click', { id: reveal.id }) };
  if (/(take a break|pause for|try basic|here’s what you’ll lose|here's what you'll lose)/.test(t)) {
    const fwd = find(/^(not now|skip|continue|i understand|no thanks$)$/i) || find(/^(continue|skip|not now)/i);
    if (fwd) return { state, reasoning: 'mock: decline interstitial', action: act('click', { id: fwd.id }) };
  }
  const entry = find(/cancel (my |the )?(subscription|membership|plan)|end (my )?plan|i want to cancel|turn off auto/i) || find(/^cancel (plan|membership|subscription)/i);
  if (entry) return { state, reasoning, action: act('click', { id: entry.id }) };
  const manage = find(/manage plan|manage subscription/i);
  if (manage && !history.some((h) => h.target === manage.text)) return { state, reasoning, action: act('click', { id: manage.id }) };
  const billing = find(/^billing$/i);
  if (billing && !history.some((h) => h.target === 'Billing')) return { state, reasoning, action: act('click', { id: billing.id }) };
  const sub = find(/^subscription$/i) || find(/subscription|membership/i, (e) => e.tag === 'a');
  if (sub && !history.some((h) => h.target === sub.text && h.url === snapshot.url)) return { state, reasoning, action: act('click', { id: sub.id }) };
  const acct = find(/settings|account|profile/i, (e) => e.tag !== 'input');
  if (acct && clicks < 8 && !history.some((h) => h.target === acct.text && h.url === snapshot.url)) return { state, reasoning, action: act('click', { id: acct.id }) };
  if (merchant && merchant.accountUrl && !history.some((h) => h.action && h.action.type === 'navigate')) return { state, reasoning, action: act('navigate', { url: merchant.accountUrl }) };
  return { state, reasoning, action: act('back_out', { reason: 'could not find the subscription settings' }) };
}

/** Every PageClass field, empty: the base for refusals, fallbacks and model output that lacks newer fields. */
export function blankPageClass(notes) {
  return { pageEvidence: '', pageKind: 'other', signedIn: false, accountType: 'unknown', billedVia: 'unknown', accountName: null, accountEmail: null, isPlanPage: false, hasPaidPlan: null, planName: null, currentPriceIndex: null, priceEvidence: null,
    monthlyPriceUsd: null, cycleChargeUsd: null, cadence: 'unknown', renewalDate: null, isTrial: false, trialEndsOn: null, priceAfterTrialUsd: null, offerApplied: false, offerText: null, detailsLinkId: null, confidence: 0, notes: notes || '' };
}

// Pages that can't show this account's plan (money is never read from them), and the subset that can't show any
// verdict about it at all (hasPaidPlan is unknown there, even if the header says signed in).
const NO_MONEY_KINDS = ['login', 'not_found', 'error', 'loading', 'bot_challenge', 'marketing'];
const BROKEN_KINDS = ['not_found', 'error', 'loading', 'bot_challenge'];
// The extension only ever navigates to a details link (a GET), but some GETs act: sign-out, cancel, delete, checkout.
// Whole words and phrases, as in the extension's filter (scan.ts), so a brand or section name is not an action: "My Best
// Buy Memberships", "Nintendo Switch Online", "Subscriber Services". "buy" counts only as a verb phrase.
const UNSAFE_LINK_RE = /\b(cancel\w*|log ?out|sign ?out|delete|remove|unsubscribe|upgrade|downgrade|pause|checkout|check out|purchase|pay now|subscribe|start (a |your |my )?(free )?trial|switch (to|plan|plans)|leave|deactivate|close (my |your )?account|join (now|free|today)|buy (now|it|this|more|gift|a|an|the))\b/i;
const UNSAFE_PATH_RE = /(log-?out|sign-?out|logout|signout|cancel|delete|deactivate|unsubscribe|checkout|upgrade)/i;
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const PRICE_KEYS = ['monthlyPriceUsd', 'cycleChargeUsd', 'priceAfterTrialUsd'];
const hasPrice = (c) => PRICE_KEYS.some((k) => c[k] != null);
const hasMoney = (c) => hasPrice(c) || c.renewalDate != null || c.trialEndsOn != null || c.offerText != null || c.isTrial || c.offerApplied;
function dropPrices(c) { for (const k of PRICE_KEYS) c[k] = null; c.cadence = 'unknown'; c.currentPriceIndex = null; c.priceEvidence = null; }
function dropMoney(c) { dropPrices(c); c.renewalDate = null; c.isTrial = false; c.trialEndsOn = null; c.offerApplied = false; c.offerText = null; }

/** Why the cited PRICES entry doesn't back the reported amounts, or null when it does (or can't be checked). */
function priceIndexProblem(c, prices) {
  const i = c.currentPriceIndex, list = Array.isArray(prices) ? prices.slice(0, 12) : [];   // the 12 renderSnapshot numbers
  const p = i >= 0 ? list[i] : null;
  if (!p || typeof p.amount !== 'number') return `price [${i}] is not in the list`;
  if (!isUsd(p)) return null;   // the model converted a foreign price: nothing to compare against
  const vals = PRICE_KEYS.map((k) => c[k]).filter((v) => v != null);
  if (!vals.length) return null;
  // The listed amount itself (a cycle charge), or its per-month value; a unitless amount may be a yearly one.
  const u = normUnit(p.unit), per = u === '' ? [p.amount / 12] : u === 'month' ? [] : [perMonth(p.amount, u)];
  const ok = vals.some((v) => Math.abs(v - p.amount) <= 0.0101 || per.some((x) => Math.abs(v - x) <= Math.max(0.0101, x * 0.01)));
  return ok ? null : `price [${i}] (${p.amount}) matches none of the reported amounts`;
}

/** Why element `id` can't be the details link the extension opens next, or null when it can. */
function detailsLinkProblem(id, s, domain) {
  const el = (s.elements || []).find((e) => e && e.id === id);
  if (!el) return 'no such element';
  if (String(el.tag || '').toLowerCase() !== 'a' || !el.href) return 'not a link';
  let u; try { u = new URL(el.href, s.url || undefined); } catch { return 'unreadable href'; }
  if (!/^https?:$/.test(u.protocol)) return 'not a web link';
  const site = etld1(u.hostname), own = [etld1(hostOf(s.url)), etld1(String(domain || ''))].filter(Boolean);
  if (!own.includes(site)) return 'off-site';
  if (UNSAFE_LINK_RE.test(etext(el)) || UNSAFE_PATH_RE.test(u.pathname)) return 'unsafe link';
  try { if (u.href === new URL(s.url).href) return 'this page'; } catch { /* no page url */ }
  return null;
}

/**
 * The server-side checks every page classification passes, from the model, the mock or the fallback (finding 12).
 * Fills fields an older model output lacks, then: money/renewal/trial fields only survive on a signed-in page that
 * can show a plan and says there is a paid one; a cited PRICES entry must match the reported amounts; a paid plan
 * with an uncited price keeps the plan but loses the price; detailsLinkId must be a safe same-site <a>.
 * Returns a new object; notes say what was dropped and why.
 */
export function guardPageClass(cls, snapshot, domain) {
  const s = snapshot || {}, c = { ...blankPageClass(''), ...(cls || {}) }, why = [];
  if (!PAGE_KINDS.includes(c.pageKind)) c.pageKind = 'other';
  if (!ACCOUNT_TYPES.includes(c.accountType)) c.accountType = 'unknown';
  if (!BILLED_VIA.includes(c.billedVia)) c.billedVia = 'unknown';
  if (!CADENCES.includes(c.cadence)) c.cadence = 'unknown';
  for (const k of ['signedIn', 'isPlanPage', 'isTrial', 'offerApplied']) c[k] = c[k] === true;
  if (c.hasPaidPlan !== true && c.hasPaidPlan !== false) c.hasPaidPlan = null;
  for (const k of PRICE_KEYS) c[k] = num(c[k]);
  c.currentPriceIndex = Number.isInteger(c.currentPriceIndex) ? c.currentPriceIndex : null;
  c.detailsLinkId = Number.isInteger(c.detailsLinkId) ? c.detailsLinkId : null;
  const conf = num(c.confidence) ?? 0; c.confidence = Math.max(0, Math.min(1, conf > 1 && conf <= 100 ? conf / 100 : conf));
  c.pageEvidence = String(c.pageEvidence || '').slice(0, 80);
  c.priceEvidence = c.priceEvidence ? String(c.priceEvidence).slice(0, 80) : null;
  c.accountName = c.accountName ? String(c.accountName).trim().slice(0, 80) || null : null;
  c.accountEmail = acceptableEmail(c.accountEmail) ? String(c.accountEmail).trim() : null;   // never a role mailbox
  c.notes = String(c.notes || '');

  if (BROKEN_KINDS.includes(c.pageKind)) { c.hasPaidPlan = null; c.isPlanPage = false; c.planName = null; }
  if (NO_MONEY_KINDS.includes(c.pageKind) || !c.signedIn || c.hasPaidPlan !== true) {
    if (hasMoney(c)) why.push(`money dropped: ${NO_MONEY_KINDS.includes(c.pageKind) ? c.pageKind + ' page' : !c.signedIn ? 'not signed in' : 'no confirmed paid plan'}`);
    dropMoney(c);
  } else if (c.currentPriceIndex != null) {
    const bad = priceIndexProblem(c, s.prices);
    if (bad) { if (hasPrice(c)) { why.push('price dropped: ' + bad); c.confidence = Math.min(c.confidence, 0.5); } dropPrices(c); }
  } else if (!c.priceEvidence && hasPrice(c)) { why.push('price dropped: not cited on the page'); dropPrices(c); }

  if (c.detailsLinkId != null) { const bad = detailsLinkProblem(c.detailsLinkId, s, domain); if (bad) { why.push(`detailsLinkId ${c.detailsLinkId} dropped: ${bad}`); c.detailsLinkId = null; } }
  if (why.length) c.notes = `${c.notes}${c.notes ? ' ' : ''}[guard: ${why.join('; ')}]`;
  return c;
}

const NOT_FOUND_RE = /not found|\b404\b|could not be found|doesn.t exist|does not exist/i;
const CHALLENGE_RE = /verify (that )?you('re| are) (not a robot|human)|are you a robot|checking your browser|press (and|&) hold|just a moment/i;
const SIGN_OUT_RE = /\b(sign|log) ?out\b/i;
const PLAN_WORDS_RE = /\b(subscriptions?|billing|memberships?|plans?)\b/i;
const NO_PLAN_RE = /(not (currently )?subscribed|no active (subscription|membership|plan)s?|you don.t have (a|an active) (subscription|membership|plan)|current plan:? free)/;
const DETAILS_LINK_RE = /subscription|billing|membership|manage (plan|subscription)|^account$|your plan/i;
const GENERIC_HINT_RE = /\b(account|profile|menu|settings|avatar|user|sign|log|open|expand|toggle|notifications?|help|more)\b/i;
const EMAIL_SOURCES = ['account-menu', 'page-data', 'login-form', 'form'];

/** A display name from the account-menu hints ("J JANE" → "JANE"); generic labels like "Account" are not names. */
function nameFromHints(hints) {
  for (const h of hints || []) {
    const t = h && h.source === 'account-menu' ? String(h.text || '').replace(/\s+/g, ' ').trim() : '';
    if (t.length < 2 || t.length > 60 || t.includes('@') || GENERIC_HINT_RE.test(t)) continue;
    const m = t.match(/^([a-z])\s+(\1.+)$/i);   // avatar initial, then the name
    return m ? m[2] : t;
  }
  return null;
}

/** Heuristic page classification (mock brain, the extension's no-API path, and the server's fallback). */
export function mockClassify(snapshot, domain) {
  const s = snapshot || {}, raw = String(s.text || ''), t = raw.toLowerCase(), els = s.elements || [];
  const head = [s.title || '', ...(s.headings || [])].join(' | ');
  const idn = s.identity || {}, emails = (idn.emails || []).filter((e) => e && acceptableEmail(e.value));
  const hasSignOut = els.some((e) => SIGN_OUT_RE.test(etext(e)));
  // Signed-in chrome: a visible sign-out control, an email in the account menu, or a greeting.
  const chrome = hasSignOut || emails.some((e) => e.source === 'account-menu') || /\b(signed in as|welcome back)\b/.test(t);
  const cue = !s.hasPassword && /(sign out|log out|your (subscription|plan|membership)|manage|billing)/.test(t);
  const price = pickPrice(s.prices);
  // The kind of page first, as the model is asked to.
  let kind = NOT_FOUND_RE.test(head) ? 'not_found'
    : CHALLENGE_RE.test(`${head} ${raw.slice(0, 2000)}`) ? 'bot_challenge'
    : s.hasPassword ? (hasSignOut ? 'reauth' : 'login')
    : !els.length && raw.trim().length < 40 ? 'loading' : null;
  const signedIn = (chrome || cue) && !['login', 'loading', 'bot_challenge'].includes(kind) && !(kind === 'not_found' && !chrome);
  const control = els.some((e) => /\b(cancel|manage)\b/i.test(etext(e)));
  if (!kind) kind = signedIn ? (PLAN_WORDS_RE.test(t) && (price || (control && PLAN_WORDS_RE.test(head))) ? 'account_billing' : 'account_other') : (PLAN_WORDS_RE.test(t) && price ? 'marketing' : 'other');
  const isPlanPage = kind === 'account_billing';
  const paid = isPlanPage && (!!price || /\b(next (billing|charge|payment)|renews? on|member since)\b/.test(t));
  const hasPaidPlan = !signedIn || BROKEN_KINDS.includes(kind) ? null : NO_PLAN_RE.test(t) ? false : paid ? true : null;
  const ranked = EMAIL_SOURCES.map((src) => emails.find((e) => e.source === src)).find(Boolean) || emails[0];
  const accountEmail = ranked ? ranked.value : (raw.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).find(acceptableEmail) || null;
  const orgReason = signedIn ? orgAccountReason(s, accountEmail) : null;
  let detailsLinkId = null;
  if (signedIn && !isPlanPage) {
    const here = hostOf(s.url), link = els.find((e) => e.tag === 'a' && e.href && hostOf(e.href, s.url) === here && [e.text, e.label].some((x) => DETAILS_LINK_RE.test(String(x || '').trim())) && !UNSAFE_LINK_RE.test(etext(e)));
    if (link) detailsLinkId = link.id;
  }
  const isTrial = /free trial/.test(t), monthly = price ? price.monthly : null;
  const evidence = kind === 'not_found' ? [s.title || '', ...(s.headings || [])].find((h) => NOT_FOUND_RE.test(h)) : (s.headings || [])[0] || s.title;
  const cls = {
    pageEvidence: String(evidence || '').slice(0, 80), pageKind: kind, signedIn, accountType: orgReason ? 'work_or_team' : 'unknown', billedVia: 'unknown',
    accountName: signedIn ? nameFromHints(idn.hints) : null, accountEmail, isPlanPage, hasPaidPlan, planName: null,
    currentPriceIndex: price && price.i < 12 ? price.i : null,
    priceEvidence: price ? `$${price.p.amount}${price.unit ? '/' + price.unit : ''} · ${String(price.p.context || '').replace(/\s+/g, ' ').trim()}`.slice(0, 80) : null,
    monthlyPriceUsd: monthly, cycleChargeUsd: isTrial ? 0 : price ? (price.unit === 'month' || price.unit === '' ? monthly : price.p.amount) : null,
    cadence: price ? ({ month: 'month', '': 'month', year: 'year', week: 'week' })[price.unit] || 'unknown' : 'unknown',
    renewalDate: (raw.match(/next billing(?: date)?:?\s*([A-Z][a-z]+ \d{1,2}, \d{4})/i) || [null, null])[1], isTrial,
    trialEndsOn: (raw.match(/trial (?:until|ends?(?: on)?)\s*([A-Z][a-z]+ \d{1,2}, \d{4})/i) || [null, null])[1],
    priceAfterTrialUsd: (function () { const mm = raw.match(/then \$\s?(\d+(?:\.\d{2})?)\s*\/\s*month/i); return mm ? +mm[1] : null; })(),
    offerApplied: /(offer applied|loyalty offer)/.test(t), offerText: null, detailsLinkId,
    confidence: isPlanPage && signedIn && hasPaidPlan != null ? 0.8 : 0.5, notes: `mock classify: ${kind}${orgReason ? ' · ' + orgReason : ''}`,
  };
  return guardPageClass(cls, s, domain);
}

/** Mock discovery knows nothing about the world; it only works in test mode. */
export function mockDiscover(domains) {
  return (domains || []).map((domain) => ({ domain, isSubscription: false, name: domain, category: 'unknown', accountUrl: null, typicalMonthlyPriceUsd: null, makesRetentionOffers: 'unknown', typicalOfferDiscountPct: null, typicalOfferTermMonths: null, confidence: 0, notes: 'mock brain cannot classify domains — use test mode or configure an AI provider',
    canonicalService: null, audience: null, billingModel: null, payLikelihood: 0, regulatedFinancialOrHealth: false, kind: 'unknown' }));
}

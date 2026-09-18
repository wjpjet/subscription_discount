// A deterministic, rule-based brain for tests (no API spend). Conservative: when unsure, it backs out.
import { FINALIZE_RE, ACCEPT_RE } from './guardrails.js';

const NULLS = { id: null, text: null, value: null, url: null, direction: null, reason: null, offer: null, outcome: null, details: null };
const act = (type, extra) => ({ ...NULLS, type, ...extra });
const etext = (e) => `${e.text || ''} ${e.label || ''}`.trim();

function monthlyFromPrices(prices) {
  const p = (prices || []).filter((x) => x.amount >= 1 && x.amount <= 500);
  const m = p.find((x) => x.unit === 'month' || x.unit === 'mo'); if (m) return m.amount;
  const y = p.find((x) => x.unit === 'year' || x.unit === 'yr' || x.unit === 'annually'); if (y) return +(y.amount / 12).toFixed(2);
  return p.length ? p[0].amount : null;
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

export function mockClassify(snapshot) {
  const t = (snapshot.text || '').toLowerCase();
  const monthly = monthlyFromPrices(snapshot.prices);
  const signedIn = !snapshot.hasPassword && (/(sign out|log out|your (subscription|plan|membership)|manage|billing)/.test(t));
  const offerApplied = /(offer applied|loyalty offer)/.test(t);
  return { signedIn, hasPaidPlan: signedIn ? (monthly != null) : null, planName: null, accountEmail: (String(snapshot.text || '').match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/) || [null])[0], monthlyPriceUsd: monthly, cadence: monthly != null ? 'month' : 'unknown', renewalDate: null, offerApplied, offerText: null, confidence: 0.5, notes: 'mock classify' };
}

/** Mock discovery knows nothing about the world; it only works in test mode. */
export function mockDiscover(domains) {
  return (domains || []).map((domain) => ({ domain, isSubscription: false, name: domain, category: 'unknown', accountUrl: null, typicalMonthlyPriceUsd: null, makesRetentionOffers: 'unknown', typicalOfferDiscountPct: null, typicalOfferTermMonths: null, confidence: 0, notes: 'mock brain cannot classify domains — use test mode or configure an AI provider' }));
}

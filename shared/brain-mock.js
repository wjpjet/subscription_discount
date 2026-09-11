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
  if (/(offer applied|you're all set|you’re all set|all set|discount applied|loyalty offer applied)/.test(t)) return 'offer_accepted_confirmation';
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
  const find = (re, extra) => els.find((e) => !e.disabled && !e.offscreen && re.test(etext(e)) && !FINALIZE_RE.test(etext(e)) && (!extra || extra(e)));
  const clicks = history.filter((h) => h.action && (h.action.type === 'click' || h.action.type === 'navigate')).length;
  const reasoning = `mock brain: state=${state}`;
  if (goal === 'verify') {
    const monthly = monthlyFromPrices(snapshot.prices);
    return { state, reasoning, action: act('finish', { outcome: 'discount_applied', details: { beforeMonthlyPriceUsd: null, afterMonthlyPriceUsd: monthly, termMonths: null, savingsUsd: null, summary: `verify: monthly price now ${monthly}` } }) };
  }
  if (state === 'login') return { state, reasoning, action: act('finish', { outcome: 'blocked_needs_you', details: { beforeMonthlyPriceUsd: null, afterMonthlyPriceUsd: null, termMonths: null, savingsUsd: null, summary: 'Login required.' } }) };
  if (state === 'save_offer_presented') {
    const btn = find(/accept/i) || find(ACCEPT_RE);
    if (btn) {
      const m = (snapshot.text || '').match(/\$\s?(\d+(?:\.\d{2})?)\s*\/\s*month[^.]*?(\d+)\s*months?/i);
      return { state, reasoning, action: act('accept_offer', { id: btn.id, offer: { description: btn.text || 'offer', newMonthlyPriceUsd: m ? +m[1] : null, discountPct: null, termMonths: m ? +m[2] : null, freeMonths: null } }) };
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
    const cont = find(/^(continue|next|submit|proceed)$/i) || find(/continue|next/i);
    if (cont) return { state, reasoning, action: act('click', { id: cont.id }) };
  }
  if (state === 'subscription_page') { const cancel = find(/cancel/i); if (cancel) return { state, reasoning, action: act('click', { id: cancel.id }) }; }
  const sub = find(/subscription|billing|membership|manage plan/i);
  if (sub) return { state, reasoning, action: act('click', { id: sub.id }) };
  const acct = find(/settings|account|profile/i, (e) => e.tag !== 'input');
  if (acct && clicks < 6) return { state, reasoning, action: act('click', { id: acct.id }) };
  if (merchant && merchant.accountUrl && !history.some((h) => h.action && h.action.type === 'navigate')) return { state, reasoning, action: act('navigate', { url: merchant.accountUrl }) };
  return { state, reasoning, action: act('back_out', { reason: 'could not find the subscription settings' }) };
}

export function mockClassify(snapshot) {
  const t = (snapshot.text || '').toLowerCase();
  const monthly = monthlyFromPrices(snapshot.prices);
  const signedIn = !snapshot.hasPassword && (/(sign out|log out|your (subscription|plan|membership)|manage|billing)/.test(t));
  const offerApplied = /(offer applied|loyalty offer)/.test(t);
  return { signedIn, hasPaidPlan: signedIn ? (monthly != null) : null, planName: null, monthlyPriceUsd: monthly, cadence: monthly != null ? 'month' : 'unknown', renewalDate: null, offerApplied, offerText: null, confidence: 0.5, notes: 'mock classify' };
}

/** Mock discovery knows nothing about the world; it only works in test mode. */
export function mockDiscover(domains) {
  return (domains || []).map((domain) => ({ domain, isSubscription: false, name: domain, category: 'unknown', accountUrl: null, typicalMonthlyPriceUsd: null, makesRetentionOffers: 'unknown', typicalOfferDiscountPct: null, typicalOfferTermMonths: null, confidence: 0, notes: 'mock brain cannot classify domains — use test mode or configure an AI provider' }));
}

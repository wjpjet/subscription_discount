// Deterministic guardrails for the hunt. The model PROPOSES; this code DISPOSES.
// Used by the backend (authoritative) and re-applied in the extension (defense in depth).
export const STATES = ['login','account_home','settings','subscription_page','cancel_entry','reason_survey','save_offer_presented','offer_accepted_confirmation','about_to_finalize_cancel','cancellation_completed','other','ambiguous'];
export const ACTIONS = ['click','type','select','scroll','navigate','wait','accept_offer','back_out','finish'];
export const OUTCOMES = ['discount_applied','no_offer_backed_out','blocked_needs_you','error'];

/** Text that finalizes a cancellation, declines an offer, or destroys the account. Never clickable. */
export const FINALIZE_RE = /\b(confirm (my |the |your )?cancel(l)?ation|confirm (and |& )?cancel|yes,? (please )?cancel|cancel anyway|complete (my |the )?cancel(l)?ation|finish cancel(l)?ing|end (my |the )?(subscription|membership|plan)|cancel (my |the |your )?(subscription|membership|plan) now|turn off (auto[- ]?renew(al)?|automatic renewal)|proceed (with|to) cancel(l)?ation|continue (to |with )?cancel(l)?ing|continue cancel(l)?ation|no thanks|no,? thanks|i still want to cancel|yes,? i('| a)m sure|i('| a)m sure|delete (my )?account|close (my )?account|deactivate)\b/i;
/** Text that looks like accepting/keeping an offer. */
export const ACCEPT_RE = /\b(accept|claim|redeem|get (the |this |my )?(offer|deal|discount)|apply (the |this )?(offer|discount)|keep (my )?(subscription|membership|plan|premium|plus)|stay|take (the |this )?(offer|deal)|yes,? (please|i('| wi)ll take)|continue with (the )?offer|activate|i('| wi)ll stay|keep it|save (\d+%|money))\b/i;
/** Sensitive inputs the agent must never type into. */
export const SENSITIVE_FIELD_RE = /(passw|card|cvc|cvv|expir|ssn|social|routing|iban|swift)/i;

function elementText(el) {
  if (!el) return '';
  return [el.text, el.label, el.value, el.placeholder].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}
export function isFinalizeText(text) { return FINALIZE_RE.test(text || ''); }
export function isAcceptText(text) { return ACCEPT_RE.test(text || ''); }

function sameSite(url, merchantDomain) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const d = String(merchantDomain || '').toLowerCase();
    return !!d && (host === d || host.endsWith('.' + d));
  } catch { return false; }
}

/**
 * @param {{decision:any, snapshot:any, history:any[], merchantDomain:string, step:number, maxSteps:number}} ctx
 * @returns {{decision:any, notes:string[]}}
 */
export function applyGuardrails(ctx) {
  const { snapshot, history = [], merchantDomain, step = 0, maxSteps = 25 } = ctx;
  const notes = [];
  const d = JSON.parse(JSON.stringify(ctx.decision || {}));
  d.action = d.action || { type: 'wait' };
  const a = d.action;
  const elements = (snapshot && snapshot.elements) || [];
  const el = a.id != null ? elements.find((e) => e.id === a.id) : null;
  const text = elementText(el);
  const offerSeen = history.some((h) => h.state === 'save_offer_presented') || d.state === 'save_offer_presented';
  const accepted = history.some((h) => (h.action && h.action.type === 'accept_offer' && h.ok !== false) || h.state === 'offer_accepted_confirmation') || d.state === 'offer_accepted_confirmation';
  const setBackOut = (why) => { notes.push(why); d.action = { type: 'back_out', reason: why }; };
  const setWait = (why) => { notes.push(why); d.action = { type: 'wait', reason: why }; };

  if (step >= maxSteps && a.type !== 'finish') {
    notes.push('step budget exhausted');
    d.action = { type: 'finish', outcome: 'error', details: { summary: 'Step budget exhausted without a result.' } };
    return { decision: d, notes };
  }

  // Loop detection: three identical consecutive actions
  const last = history.slice(-3);
  if (last.length === 3 && ['click', 'navigate', 'scroll', 'wait'].includes(a.type)) {
    const key = (h) => h.action ? `${h.action.type}:${h.action.id ?? ''}:${h.action.url ?? ''}:${h.url ?? ''}` : '';
    const mine = `${a.type}:${a.id ?? ''}:${a.url ?? ''}:${snapshot && snapshot.url}`;
    if (last.every((h) => key(h) === mine)) { setBackOut('looping on the same action'); return { decision: d, notes }; }
  }

  if ((d.state === 'about_to_finalize_cancel' || d.state === 'cancellation_completed') && ['click', 'type', 'select', 'navigate'].includes(a.type)) {
    setBackOut('on the final cancel screen: no interaction allowed, backing out'); return { decision: d, notes };
  }
  if (offerSeen && !accepted && ['click', 'type', 'select', 'navigate'].includes(a.type)) {
    setBackOut('an offer was presented: only accept_offer or back_out are allowed'); return { decision: d, notes };
  }
  if (['click', 'accept_offer'].includes(a.type)) {
    if (!el) { setWait('target element not found in snapshot'); return { decision: d, notes }; }
    if (isFinalizeText(text)) { setBackOut(`refused to click "${text.slice(0, 60)}" (finalize/decline pattern)`); return { decision: d, notes }; }
    if (el.disabled) { setWait(`"${text.slice(0, 40)}" is disabled`); return { decision: d, notes }; }
  }
  if (a.type === 'accept_offer' && d.state !== 'save_offer_presented' && !isAcceptText(text)) {
    setWait('accept_offer on something that does not look like an offer'); return { decision: d, notes };
  }
  if (a.type === 'type' || a.type === 'select') {
    if (!el) { setWait('target element not found in snapshot'); return { decision: d, notes }; }
    if (el.type === 'password' || SENSITIVE_FIELD_RE.test(`${el.name || ''} ${el.placeholder || ''} ${el.label || ''}`)) {
      setBackOut('refused to type into a sensitive field'); return { decision: d, notes };
    }
  }
  if (a.type === 'navigate') {
    if (!a.url || !sameSite(a.url, merchantDomain)) { setBackOut(`refused to navigate off-site: ${a.url}`); return { decision: d, notes }; }
  }
  if (a.type === 'finish') {
    a.details = a.details || { summary: '' };
    if (a.outcome === 'discount_applied' && !accepted && ctx.goal !== 'verify') {
      notes.push('claimed discount_applied without an accepted offer'); a.outcome = 'error'; a.details.summary = (a.details.summary || '') + ' [guardrail: no accept_offer in history]';
    }
  }
  return { decision: d, notes };
}

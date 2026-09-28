// Deterministic guardrails for the hunt. The model PROPOSES; this code DISPOSES.
// Used by the backend (authoritative) and re-applied in the extension (defense in depth).
import { sensitiveReason } from './sensitive.js';

export const STATES = ['login','account_home','settings','subscription_page','cancel_entry','reason_survey','save_offer_presented','offer_accepted_confirmation','about_to_finalize_cancel','cancellation_completed','other','ambiguous'];
export const ACTIONS = ['click','type','select','scroll','navigate','wait','accept_offer','back_out','finish'];
export const OUTCOMES = ['discount_applied','no_offer_backed_out','blocked_needs_you','offer_found','error'];   // offer_found is assigned by the guardrail in find mode

/** Text that finalizes a cancellation, declines an offer, or destroys the account. Never clickable.
 *  Deliberately absent: a bare "continue to cancel" (a common forward step before any offer) and
 *  "cancel my subscription" (the ordinary entry label). Both are refused by context instead, below. */
export const FINALIZE_RE = /\b(confirm (my |the |your )?cancel(l)?ation|confirm (and |& )?cancel|yes,? (please )?cancel|cancel anyway|complete (my |the )?cancel(l)?ation|complete cancel(l)?ing|finish (my |the )?cancel(l)?(ing|ation)|end (my |the )?(subscription|membership|plan)|cancel (my |the |your )?(subscription|membership|plan) now|turn off (auto[- ]?renew(al)?|automatic renewal)|proceed (with|to) cancel(l)?ation|continue (to |with )?cancel(l)?ing|continue cancel(l)?ation|no thanks|no,? thanks|i still want to cancel|yes,? i('| a)m sure|i('| a)m sure|delete (my )?account|close (my )?account|deactivate|(cancel|end)( (my|your|the))?( (subscription|membership|plan|benefits|trial|prime|premium|access))? (on|by) (\d{1,2}[/.-]\d{1,2}|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? ?\d{1,2}|today|tomorrow)|(end|cancel) (my |your |the )?benefits|(cancel|end) (it )?(now|immediately))\b/i;
/** Text that looks like accepting/keeping an offer. "Save 50%" sits outside the \b group: no word boundary follows a "%". */
export const ACCEPT_RE = /\b(accept|claim|redeem|get (the |this |my )?(offer|deal|discount)|apply (the |this )?(offer|discount)|keep (my )?(subscription|membership|plan|premium|plus)|stay|take (the |this )?(offer|deal)|yes,? (please|i('| wi)ll take)|continue with (the )?offer|activate|i('| wi)ll stay|keep it|save money|give me (the |this |that )?(offer|deal|discount)|(get|take) \d+% off|get \d+ (free )?(months?|weeks?)( free)?)\b|\bsave \d+%/i;
/** Sensitive inputs the agent must never type into. */
export const SENSITIVE_FIELD_RE = /(passw|card|cvc|cvv|expir|ssn|social|routing|iban|swift)/i;
// Pauses worded without "pause". Never a bare "freeze": "Freeze my price at $8.99" is a same-plan offer.
const HOLD = String.raw`(put|place)\b.{0,20}\bon hold|(hold|freeze) (my |your |the )?(membership|subscription|plan|account)(?!['’]?s? (price|rate))|take a break|snooze|skip (a|the next|next|this) (month|week|delivery|box|payment)`;
/** Buttons that commit to something other than keeping the plan as it is: refused even as ordinary clicks.
 *  Navigation labels ("Change plan", "Manage membership", "Purchase history") stay clickable: on some sites
 *  they are the only route to the cancel link. The page after them is where the commit button lives. */
export const COMMIT_VERB_RE = new RegExp(String.raw`\b(pause|downgrade|switch to|buy|purchase(?![\w-]| (history|records?|details))|place (my |your |the )?order|pay now|subscribe|start (a |my |your )?(free )?trial|add (an? |another |more |extra )*(member|seat|slot)s?|(leave|delete) (the |this |my |your )?(team|workspace|organi[sz]ation)|${HOLD})\b`, 'i');
/** Never an offer to accept: pauses, downgrades, plan switches, upgrades, purchases, team changes. A retention
 *  offer keeps the SAME plan at a lower price or with free months; anything here changes the product. */
export const PLAN_CHANGE_RE = new RegExp(String.raw`\b(pause|downgrade|upgrade|switch (to|plans?)|change (to|(my |your |the )?plan)|buy|purchase|place (my |your |the )?order|pay now|subscribe|start (a |my |your )?(free )?trial|add (an? |another |more |extra )*(plan|member|seat|slot|extra)s?|(leave|delete) (the |this |my |your )?(team|workspace|organi[sz]ation|project)|remove (seats?|members?|users?)|transfer|${HOLD})\b`, 'i');
/** A label that offers both choices ("Pause or cancel membership", "Put on hold or cancel") opens a chooser; it commits to neither. */
const CHOOSER_RE = /\b(pause|downgrade|hold|freeze|break|snooze)\b.{0,24}(\bor\b|\/).{0,24}\bcancel\w*|\bcancel\w*\b.{0,24}(\bor\b|\/).{0,24}\b(pause|downgrade|hold|freeze|break|snooze)\b/gi;

/** The whole accessible label: an icon button's words live in aria-label, an input's in value/placeholder. */
export function elementText(el) {
  if (!el) return '';
  return [el.text, el.label, el.value, el.placeholder].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}
export function isFinalizeText(text) { return FINALIZE_RE.test(text || ''); }
export function isAcceptText(text) { return ACCEPT_RE.test(text || ''); }
export function isPlanChangeText(text) { return PLAN_CHANGE_RE.test(text || ''); }
export function isCommitText(text) { return COMMIT_VERB_RE.test(String(text || '').replace(CHOOSER_RE, ' ')); }

/** A page that says it is the final confirmation. Deliberately excludes "you'll lose access", which
 *  real settings pages say next to the ordinary entry button. */
export const CONFIRM_PAGE_RE = /\b(are you sure|final step|last step|last chance|cannot be undone|can't be undone|can’t be undone|this will (immediately )?(cancel|end|terminate))\b/i;
/** A button label that acts on the subscription rather than keeping it. */
export const CANCEL_VERB_RE = /\b(cancel|cancellation|cancelling|canceling|end|terminate|stop|close|deactivate|unsubscribe)\b/i;
/** Offer wording, read only inside the cancel flow. Not "deal": survey reasons say "found a better deal". */
export const OFFER_TEXT_RE = /%|\b(offers?|discount(s|ed)?|promo(tion(al)?)?|coupon|half[- ]price|special price)\b|\bfree (months?|weeks?)\b|\b(months?|weeks?) (for )?free\b/i;
// Phrases that mention cancelling but mean keeping: "Don't cancel, apply discount", "Cancel anytime", "Undo cancellation".
const KEEP_PHRASE_RE = /\b(don'?t|don’t|do not|never|not|no need to|won'?t|won’t)( want)?( to)? (cancel|end|terminate|stop|close|deactivate|unsubscribe)\w*|\bcancel (any ?time|at any time)\b|\b(undo|stop|withdraw|reverse) (my |the )?cancel(l)?ation\b/gi;
// Labels that start the cancel flow (the entry click), as opposed to a dialog's "Cancel" or a "Close".
const ENTRY_RE = /\b(cancel\w*|end|terminate) (my |the |your )?(subscription|membership|plan|premium|trial|renewal|auto[- ]?renew\w*)\b|\bi want to cancel\b|\bunsubscribe\b/i;
// A plain dismissal ("Close", "×"), allowed on the confirmation screen after an offer was accepted.
const DISMISS_RE = /^[×✕xX\s]*(close|dismiss)?( (this )?(dialog|window|modal|popup|message))?[×✕xX\s]*$/i;
// A label that starts the cancellation: a cancel verb first ("Cancel", "Cancel free trial", "Unsubscribe"), "End" alone
// or with the plan ("End membership"), or exactly "I want to cancel". Not a menu that only mentions it ("Manage, update,
// or cancel"), a section called "Cancellation", "End of season", or a survey answer ("I want to cancel because…").
const CANCEL_FIRST_RE = /^[^a-z0-9]*(cancel(?!lations?\b)\w*|terminate|deactivate|unsubscribe)\b|^[^a-z0-9]*end\b\s*(?:(?:my|your|the)\s+)?(?:(?:subscription|membership|plan|trial|benefits|premium|access)\b|[^a-z0-9]*$)|^[^a-z0-9]*i (want|would like|'d like|’d like) to cancel[^a-z0-9]*$/i;
// A label that names the cancellation anywhere ("Please cancel my subscription"): after the start, it confirms.
const CANCEL_NAMED_RE = /\b(cancel\w*|end|terminate) (my |the |your )?(subscription|membership|plan|premium|trial|renewal|auto[- ]?renew\w*)\b/i;
// A go-ahead: on the final confirmation it finishes the cancellation without naming it.
const GO_AHEAD_RE = /^[^a-z0-9]*(continue|confirm|yes|ok|okay|submit|next|done|proceed|finish|agree|i agree|i understand|got it)\b/i;
// When access or the plan ends: a date after ending words, or "until the end of your billing period". The final
// confirmation says it ("you'll keep access until October 10"); an "Are you sure?" step before the offer rarely does.
// Not "renews on <date>": that is a plan that goes on.
const DATE = String.raw`(\b\d{1,2}[/.-]\d{1,2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}\b|\b\d{1,2} (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))`;
const END_DATE_RE = new RegExp(String.raw`\b(keep|have|lose|losing|retain)\s+(your\s+)?access\b[^.!?]{0,30}?\b(until|through|thru|on|after)\b[^.!?]{0,20}?${DATE}`
  + String.raw`|\b(access|membership|subscription|plan|benefits|trial|premium|account)\b[^.!?]{0,40}?\b(ends?|ending|expires?|expiring|terminates?|stops?)\b[^.!?]{0,20}?${DATE}`
  + String.raw`|\buntil the end of (your|the|this) (current )?(billing )?(period|cycle|term|month|year)\b`, 'i');
// A go-ahead that names the offer it takes ("Yes, give me 50% off", "Continue with offer") accepts; with a decline
// word ("Continue without offer") it does not.
const NAMES_OFFER = (t) => (OFFER_TEXT_RE.test(t) || ACCEPT_RE.test(t)) && !/\b(without|no|not|decline|skip|lose|losing)\b/i.test(t);
// A link whose address says it confirms a cancellation (/cancel/confirm, /membership/end/complete, ?confirmCancel=1).
const CONFIRM_LINK_RE = /(cancel|terminat|unsubscri|end[-_]?(membership|subscription|plan)|(membership|subscription|plan)[-_/]end)[^#]{0,40}(confirm|complete|finali[sz]e|submit|process|execute)|(confirm|complete|finali[sz]e)[-_/]?(cancel|terminat|unsubscri)/i;
/** How many presses a walk may make after the one that started the cancellation, without an offer appearing. */
export const MAX_STEPS_AFTER_CANCEL = 6;
/** A page saying the subscription WAS cancelled (past tense, never "will be", never right after "when", "once",
 *  "before"…: "When your membership is cancelled, you'll lose…" is a warning, not news). After one of the walk's own
 *  presses it means something went wrong, and the person must hear it at once. */
export const CANCELLED_RE = /(?<!\b(?:when|once|if|before|after|until|unless|in case)\s+(?:(?:your|the|my)\s+)?)\b(your (subscription|membership|plan|account|premium)( has been| was| is| has)( now)? (cancel(l)?ed|ended|terminated|deactivated)|your (free )?trial (has been|was|is now|is) cancel(l)?ed|(subscription|membership|plan|trial) (has been|was|is now) (cancel(l)?ed|terminated)|cancel(l)?ation (is |has been )?(complete|completed|confirmed|successful|processed)|you(['’]ve| have| just) (successfully )?cancel(l)?ed|we(['’]ve| have) cancel(l)?ed|successfully cancel(l)?ed|you(['’]re| are) (now )?unsubscribed)\b/i;

const unkept = (text) => String(text || '').replace(KEEP_PHRASE_RE, ' ').trim();
/** The label acts on cancellation (a cancel verb that is not negated: "Don't cancel" keeps the plan). */
export function actsOnCancel(text) { return CANCEL_VERB_RE.test(unkept(text)); }
/** The label starts the cancellation (see CANCEL_FIRST_RE). A chooser ("Cancel or pause") starts neither. */
export function isCancelPress(text) { return CANCEL_FIRST_RE.test(unkept(String(text || '').replace(CHOOSER_RE, ' '))); }
export function looksLikeConfirmPage(pageText) { return CONFIRM_PAGE_RE.test(pageText || ''); }
/** The page says the subscription was cancelled and the page before it did not: the walk's last press may have done it. */
export function newlyCancelled(pageText, prevText) { return CANCELLED_RE.test(pageText || '') && !CANCELLED_RE.test(prevText || ''); }
/** Why following this address would confirm a cancellation, or null. */
export function confirmLinkRefusal(href, base) {
  if (!href) return null;
  let u; try { u = new URL(href, base || undefined); } catch { return null; }
  return CONFIRM_LINK_RE.test(u.pathname + u.search) ? `the link confirms a cancellation (${u.pathname.slice(0, 60)})` : null;
}
const historySteps = (history) => (Array.isArray(history) ? history : []).filter((h) => h && typeof h === 'object');
/** A press on a label that starts the cancellation, on whatever page and whatever it seemed to do: a bare "Cancel"
 *  that only closed a popup counts, and so does one with no visible effect (a slow dialog opens after the wait, and
 *  its confirmation may carry the very same label). The cost is a walk that backs out early, or a retry refused. */
const cancelPress = (h) => !!h.action && h.action.type === 'click' && h.ok !== false && isCancelPress(h.target || '');
function cancelStarted(history) { return historySteps(history).some(cancelPress); }
/** Presses (clicks, navigates, form input) since the one that started the cancellation; -1 before it. */
function stepsSinceCancelStarted(history) {
  let n = -1;
  for (const h of historySteps(history)) {
    if (n < 0) { if (cancelPress(h)) n = 0; continue; }
    if (h.action && h.ok !== false && ['click', 'navigate', 'type', 'select'].includes(h.action.type)) n++;
  }
  return n;
}
/** Inside the cancel flow: a step the model called cancel_entry, reason_survey or save_offer_presented, a successful
 *  entry click, or an accepted offer. An offer only ever appears inside the flow, so a walk that resumes at the offer
 *  (the accept phase's continuation) counts too, whatever history the client sends. */
function inCancelFlow(history) {
  return historySteps(history).some((h) => h.state === 'cancel_entry' || h.state === 'reason_survey' || h.state === 'save_offer_presented'
    || (h.action && h.ok !== false && ((h.action.type === 'click' && ENTRY_RE.test(h.target || '')) || h.action.type === 'accept_offer')));
}
function offerAccepted(history) {
  return historySteps(history).some((h) => (h.action && h.action.type === 'accept_offer' && h.ok !== false) || h.state === 'offer_accepted_confirmation');
}

/**
 * The click-time rule, shared by the server guardrail, the extension and the test driver. Returns why a
 * button must not be clicked, or null.
 * - A finalize/decline label is never clickable anywhere, nor is a commit verb (pause, downgrade, buy…).
 * - One cancel press per walk: once a press has started the cancellation, a button that starts with a cancel
 *   verb (or names the cancellation, "Please cancel my subscription") would confirm it, whatever the page
 *   says around it. The live runs met exactly that: "Cancel" then "Cancel plan" in Claude's dialog, "Cancel
 *   membership" then "Cancel on <date>" at Amazon. And once it started, a go-ahead ("Continue", "Yes") on a
 *   final confirmation that states when access ends would finish it.
 * - On a page that identifies itself as the final confirmation, any button that acts on cancellation is
 *   refused too. This closes the case where the confirm button carries an ordinary entry label such as
 *   "Cancel my subscription", which the finalize pattern must not match on a settings page.
 * - Inside the cancel flow, on a page that mentions an offer, the same holds: a "Continue to cancel" under
 *   a discount declines it even when the model did not call the screen an offer. The cost: a mid-flow page
 *   that mentions a discount for another reason ends the walk there (back out, never forward).
 * A negated verb ("Don't cancel, apply discount") keeps the plan and is not refused by the last three rules.
 */
export function clickRefusal(elementText, pageText, history) {
  const t = String(elementText || '');
  if (isFinalizeText(t)) return 'finalize/decline pattern';
  if (isCommitText(t)) return 'pause, downgrade, plan switch or purchase';
  if (GO_AHEAD_RE.test(t) && !NAMES_OFFER(t) && looksLikeConfirmPage(pageText) && END_DATE_RE.test(pageText || '') && cancelStarted(history))
    return 'a go-ahead on the final confirmation (the page says when access ends)';
  if (!actsOnCancel(t)) return null;
  if ((isCancelPress(t) || CANCEL_NAMED_RE.test(unkept(t))) && cancelStarted(history)) return 'a second cancel button: the cancellation already started, so this one would confirm it';
  if (looksLikeConfirmPage(pageText)) return 'cancel button on a final-confirmation page';
  if (inCancelFlow(history) && OFFER_TEXT_RE.test(pageText || '') && !(offerAccepted(history) && DISMISS_RE.test(t.trim())))
    return 'cancel button on an offer screen inside the cancel flow';
  return null;
}
export function isFinalizeClick(elementText, pageText, history) { return clickRefusal(elementText, pageText, history) != null; }
/** Why a label can never be the offer to accept (or null). */
function offerTargetRefusal(text) {
  if (isPlanChangeText(text)) return 'a pause, downgrade, plan change or purchase is not a discount';
  if (actsOnCancel(text)) return 'a cancel button is not an offer';
  return null;
}
/**
 * The accept-phase rule (pre-check and live re-check): the button may be pressed when it is not a
 * finalize/commit/cancel button and it either reads like accepting or is exactly the label recorded
 * during find. Real offers say "Keep my discount" or just "Continue", so the recorded label must count;
 * an empty recorded label never does (an icon button would then match anything).
 */
export function acceptLooksRight(text, recordedText, pageText, history) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const t = norm(text), want = norm(recordedText);
  if (!t || isFinalizeClick(t, pageText, history) || offerTargetRefusal(t)) return false;
  return isAcceptText(t) || (want !== '' && t === want);
}

const hostOf = (u, base) => { try { return new URL(u, base || undefined).hostname.toLowerCase(); } catch { return ''; } };
/** Why following this link opens a never-touch site (bank, payments, health…), or null. Checked before the click: the
 *  walk's own host check only runs once the page has loaded with the user's session. */
function linkRefusal(el, base) {
  const host = el && el.href ? hostOf(el.href, base) : '';
  const why = host ? sensitiveReason(host) : null;
  return why ? `refused to open ${host} (${why})` : null;
}
// Cookie and consent buttons read like accepting but never take an offer (the testbed's cookie bar says "Accept all").
// A bare "Accept" is the banner's too when the page shows a cookie notice, unless the model calls the screen an offer.
function consentButton(text, pageText, state) {
  return /cookie|consent|^(accept|allow) all$/i.test(text)
    || (state !== 'save_offer_presented' && /^(i )?accept( all)?( (and|&) (close|continue))?$/i.test(text) && /\bcookies?\b|\bconsent\b/i.test(pageText));
}

/** True when url is http(s) on one of the service's registrable domains, or a subdomain of one. */
export function sameSite(url, domains) {
  const list = (Array.isArray(domains) ? domains : [domains]).map((d) => String(d || '').toLowerCase().trim().replace(/^\.+|\.+$/g, '')).filter(Boolean);
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    return list.some((d) => host === d || host.endsWith('.' + d));
  } catch { return false; }
}

/**
 * @param {{decision:any, snapshot:any, history:any[], merchantDomain:string|string[], step:number, maxSteps:number, goal?:string}} ctx
 *   merchantDomain: the service's site set (registrable domains); navigate targets must be on one of them, and neither a
 *   navigate nor a link click may open a never-touch host (shared/sensitive.js), on the site set or not.
 * @returns {{decision:any, notes:string[]}}
 */
export function applyGuardrails(ctx) {
  const { snapshot, merchantDomain, step = 0, maxSteps = 25 } = ctx;
  const history = historySteps(ctx.history);
  const notes = [];
  const d = JSON.parse(JSON.stringify(ctx.decision || {}));
  d.action = d.action || { type: 'wait' };
  const a = d.action;
  const elements = (snapshot && snapshot.elements) || [];
  const pageText = (snapshot && snapshot.text) || '';
  const el = a.id != null ? elements.find((e) => e.id === a.id) : null;
  const text = elementText(el);
  const offerSeen = history.some((h) => h.state === 'save_offer_presented') || d.state === 'save_offer_presented';
  const accepted = offerAccepted(history) || d.state === 'offer_accepted_confirmation';
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

  const finalScreen = d.state === 'about_to_finalize_cancel' || d.state === 'cancellation_completed';
  if (finalScreen && ['click', 'type', 'select', 'navigate'].includes(a.type)) {
    setBackOut('on the final cancel screen: no interaction allowed, backing out'); return { decision: d, notes };
  }
  // FIND mode: an accept made with a plain click is still an accept. It is treated as accept_offer, so the checks and
  // the interception below turn it into "offer found" (or a back out); the scan never presses it. Only inside the
  // cancel flow or on a page that shows an offer, and never on a cookie button.
  if (ctx.goal === 'find' && a.type === 'click' && el && isAcceptText(text) && !consentButton(text, pageText, d.state)
    && (inCancelFlow(history) || OFFER_TEXT_RE.test(pageText) || d.state === 'save_offer_presented')) {
    notes.push(`find mode: a click on "${text.slice(0, 60)}" counts as accept_offer`); a.type = 'accept_offer';
  }
  if (offerSeen && !accepted && ['click', 'type', 'select', 'navigate'].includes(a.type)) {
    setBackOut('an offer was presented: only accept_offer or back_out are allowed'); return { decision: d, notes };
  }
  // Offers come within a few presses of starting the cancellation. Past that, every press is closer to the final one.
  if (!accepted && ['click', 'type', 'select', 'navigate'].includes(a.type) && stepsSinceCancelStarted(history) >= MAX_STEPS_AFTER_CANCEL) {
    setBackOut(`no offer within ${MAX_STEPS_AFTER_CANCEL} steps of starting the cancellation: going further risks the final button`); return { decision: d, notes };
  }
  if (['click', 'accept_offer'].includes(a.type)) {
    if (!el) { setWait('target element not found in snapshot'); return { decision: d, notes }; }
    const link = linkRefusal(el, snapshot && snapshot.url);
    if (link) { setBackOut(link); return { decision: d, notes }; }
    const confirmLink = confirmLinkRefusal(el.href, snapshot && snapshot.url);
    if (confirmLink) { setBackOut(`refused to click "${text.slice(0, 60)}" (${confirmLink})`); return { decision: d, notes }; }
    const why = clickRefusal(text, pageText, history);
    if (why) { setBackOut(`refused to click "${text.slice(0, 60)}" (${why})`); return { decision: d, notes }; }
    if (el.disabled) { setWait(`"${text.slice(0, 40)}" is disabled`); return { decision: d, notes }; }
  }
  if (a.type === 'accept_offer') {
    // The offer screen may label its accept "Keep my discount" or "Continue", so the state vouches for a label
    // ACCEPT_RE misses. It never vouches for a pause, a downgrade or a cancel button.
    const why = offerTargetRefusal(text);
    if (why) { setBackOut(`refused to accept "${text.slice(0, 60)}" (${why})`); return { decision: d, notes }; }
    if (d.state !== 'save_offer_presented' && !isAcceptText(text)) { setWait('accept_offer on something that does not look like an offer'); return { decision: d, notes }; }
  }
  // FIND mode (the scan): the model behaves exactly as in a hunt, but its accept is intercepted here and
  // becomes "offer found, pause on this screen". The button it would have pressed is recorded (id) so
  // the accept phase can press it later, after the user has chosen and paid. Nothing is clicked now.
  if (ctx.goal === 'find' && a.type === 'accept_offer') {
    notes.push('find mode: offer located — pausing here instead of accepting');
    d.action = { type: 'finish', outcome: 'offer_found', id: a.id, offer: a.offer || null, reason: null, details: null };
    return { decision: d, notes };
  }
  if (a.type === 'type' || a.type === 'select') {
    if (!el) { setWait('target element not found in snapshot'); return { decision: d, notes }; }
    if (el.type === 'password' || SENSITIVE_FIELD_RE.test(`${el.name || ''} ${el.placeholder || ''} ${el.label || ''}`)) {
      setBackOut('refused to type into a sensitive field'); return { decision: d, notes };
    }
  }
  if (a.type === 'navigate') {
    // A never-touch host is refused even on the service's own site (wallet.google.com under google.com).
    const host = hostOf(a.url), sensitive = host ? sensitiveReason(host) : null;
    if (sensitive) { setBackOut(`refused to navigate to ${host} (${sensitive})`); return { decision: d, notes }; }
    if (!a.url || !sameSite(a.url, merchantDomain)) { setBackOut(`refused to navigate off-site: ${a.url}`); return { decision: d, notes }; }
    const confirmLink = confirmLinkRefusal(a.url);
    if (confirmLink) { setBackOut(`refused to navigate: ${confirmLink}`); return { decision: d, notes }; }
  }
  if (a.type === 'finish' && a.outcome === 'offer_found') {
    // Only the guardrail above should produce this. If the model chose it itself, allow it only in find
    // mode, on an offer screen, pointing at a real accept-looking button; otherwise back out.
    const okTarget = !!el && !linkRefusal(el, snapshot && snapshot.url) && !clickRefusal(text, pageText, history) && !offerTargetRefusal(text) && (isAcceptText(text) || d.state === 'save_offer_presented');
    if (ctx.goal !== 'find') { setBackOut('offer_found is reserved for find mode'); return { decision: d, notes }; }
    if (!okTarget) { setBackOut('offer_found without a valid accept button'); return { decision: d, notes }; }
    a.details = null;
    return { decision: d, notes };
  }
  if (a.type === 'finish') {
    a.details = a.details || { summary: '' };
    if (a.outcome === 'discount_applied' && !accepted && ctx.goal !== 'verify') {
      notes.push('claimed discount_applied without an accepted offer'); a.outcome = 'error'; a.details.summary = (a.details.summary || '') + ' [guardrail: no accept_offer in history]';
    }
  }
  return { decision: d, notes };
}

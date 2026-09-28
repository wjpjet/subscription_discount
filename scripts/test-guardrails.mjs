// Unit test for the hunt guardrails (shared/guardrails.js) and the agent-step site set. Both directions matter:
// finalize, decline, pause, downgrade and purchase buttons must be refused, and every testbed flow's forward
// buttons and real offer labels must stay usable (so the suite's achievable count cannot drop).
//   npm run test:guardrails
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm'; import { fileURLToPath } from 'node:url';
import { applyGuardrails, clickRefusal, isFinalizeClick, isFinalizeText, isAcceptText, isCommitText, isPlanChangeText, acceptLooksRight, sameSite, elementText, CANCELLED_RE, newlyCancelled, isDeclineOnly } from '../shared/guardrails.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); ok ? pass++ : fail++; };

// Page texts shaped like the testbed's (made-up values only).
const SETTINGS = 'Settings Signed in as you@example.com Subscription Premium $17.99/month Next billing date: October 10, 2026 · Visa ending 4242 Change plan Update payment method Cancel subscription';
const OFFER = 'Step 2 of 3 Wait — before you go 50% off for 3 months Keep Premium for $8.99/month for the next 3 months. After that, $17.99/month. Cancel anytime. Accept offer Continue to cancel';
const CONFIRM = 'Final step Are you sure? If you cancel, you’ll keep access until October 10, 2026. After that, your watchlist and preferences will be deleted. Keep my subscription Cancel my subscription';
const BENEFITS = 'Here’s what you’ll lose Step 2 of 4 Ad-free streaming on 4 screens Downloads on 2 devices Your watchlist and history Keep my subscription Continue to cancel';
const SURVEY = 'We’re sorry to see you go Step 1 of 3 Before you cancel, tell us why. Too expensive I found a better deal Technical problems Other Keep my subscription Continue to cancel';
const ACCEPTED = 'You’re all set Loyalty offer applied: Premium at $8.99/month for the next 3 months. You can cancel anytime. Close';
const entered = [{ step: 0, url: 'https://example.com/settings', state: 'subscription_page', action: { type: 'click', id: 3 }, target: 'Cancel subscription', ok: true }];
const surveyed = [...entered, { step: 1, url: 'https://example.com/cancel/1', state: 'reason_survey', action: { type: 'click', id: 5 }, target: 'Continue', ok: true }];
const labelledEntry = [{ step: 0, url: 'https://example.com/cancel', state: 'cancel_entry', action: { type: 'click', id: 2 }, target: 'Next', ok: true }];
const acceptedHist = [...surveyed, { step: 2, url: 'https://example.com/cancel/offer', state: 'save_offer_presented', action: { type: 'accept_offer', id: 1 }, target: 'Accept offer', ok: true }];

console.log('Refused anywhere as an ordinary click (settings page, nothing in history)');
for (const l of ['Finish Cancellation', 'Finish my cancellation', 'Finish cancelling', 'Complete cancelling', 'Confirm cancellation', 'Cancel anyway', 'No thanks', 'Continue cancelling',
  'Pause membership instead', 'Pause 3 months', 'Pause my plan', 'Switch to Basic', 'Switch to annual', 'Downgrade to Free', 'Buy an extra member slot', 'Leave team', 'Delete workspace',
  'Place order', 'Pay now', 'Start free trial', 'Start your free trial', 'Add an extra member', 'Add seats', 'Complete purchase', 'Subscribe'])
  check(`refuse click "${l}"`, isFinalizeClick(l, SETTINGS, []), clickRefusal(l, SETTINGS, []) || 'ALLOWED');

console.log('\nClickable as ordinary clicks (navigation and forward steps)');
for (const l of ['Cancel subscription', 'Cancel membership', 'Cancel plan', 'I want to cancel', 'Change plan', 'Switch plans', 'Manage membership', 'Upgrade now', 'Purchase history',
  'Purchases', 'Pause or cancel membership', 'Cancel or pause', 'Continue', 'Next', 'Submit', 'Continue to cancel', 'Members & Groups', 'Invite Teammates', 'Billing', 'Maybe later'])
  check(`allow click "${l}"`, !isFinalizeClick(l, SETTINGS, []), clickRefusal(l, SETTINGS, []) || '');

console.log('\nPlan changes: never an offer, but navigation labels are not commits');
for (const l of ['Switch plans', 'Change plan', 'Upgrade now', 'Transfer a profile', 'Pause or cancel membership'])
  check(`"${l}" is a plan change (never accepted) but not a commit (clickable)`, isPlanChangeText(l) && !isCommitText(l));
check('"Pause or cancel, buy extra" still a commit (the chooser carve-out only removes the chooser)', isCommitText('Pause or cancel, then buy an extra slot'));
for (const l of ['Save 50%', 'Take 50% off', 'Get 3 months free', 'Give me the discount', 'Accept offer', 'Keep my membership'])
  check(`"${l}" reads like accepting`, isAcceptText(l));
for (const l of ['Continue to cancel', 'Save card', 'Cancel subscription', 'Pause membership instead'])
  check(`"${l}" does not read like accepting`, !isAcceptText(l));

console.log('\nContext: cancel buttons on offer and confirmation screens');
const ctx = [
  ['"Continue to cancel" on an offer screen after the entry click', 'Continue to cancel', OFFER, entered, true],
  ['"Continue to cancel" on an offer screen after the survey', 'Continue to cancel', OFFER, surveyed, true],
  ['"Continue to cancel" on an offer screen after a cancel_entry step', 'Continue to cancel', OFFER, labelledEntry, true],
  ['"Close" on an offer screen inside the flow (declines the offer)', 'Close', OFFER, surveyed, true],
  ['"Continue to cancel" on the entry page, before the flow', 'Continue to cancel', OFFER, [], false],
  ['"Continue to cancel" on a benefits page after the survey', 'Continue to cancel', BENEFITS, surveyed, false],
  ['"Continue to cancel" on a survey that lists "a better deal"', 'Continue to cancel', SURVEY, surveyed, false],
  ['"Keep my discount" on an offer screen inside the flow', 'Keep my discount', OFFER, surveyed, false],
  ['"Don\'t cancel, apply discount" on an offer screen inside the flow', "Don't cancel, apply discount", OFFER, surveyed, false],
  ['"Cancel subscription" on a settings page with a 10%-off popup, after closing it with "Close"', 'Cancel subscription', SETTINGS + ' Get 10% off Streamly merch Subscribe Maybe later',
    [{ state: 'settings', action: { type: 'click' }, target: 'Close', ok: true }, { state: 'settings', action: { type: 'click' }, target: 'Maybe later', ok: true }], false],
  ['"Cancel subscription" after a popup was closed with a bare "Cancel"', 'Cancel subscription', SETTINGS + ' Get 10% off Streamly merch Subscribe Maybe later',
    [{ state: 'settings', action: { type: 'click' }, target: 'Close', ok: true }, { state: 'settings', action: { type: 'click' }, target: 'Cancel', ok: true }], false],
  ['"Cancel my subscription" on a final-confirmation page', 'Cancel my subscription', CONFIRM, surveyed, true],
  ['"Accept and cancel" on a final-confirmation page', 'Accept and cancel', CONFIRM, surveyed, true],
  ['"Keep my subscription" on a final-confirmation page', 'Keep my subscription', CONFIRM, surveyed, false],
  ['"No, don\'t cancel" on a final-confirmation page', "No, don't cancel", CONFIRM, surveyed, false],
  ['"Close" on the confirmation after an accepted offer', 'Close', ACCEPTED, acceptedHist, false],
  ['"Continue to cancel" after an accepted offer', 'Continue to cancel', ACCEPTED, acceptedHist, true],
];
for (const [name, label, page, hist, refuse] of ctx) check(`${refuse ? 'refuse' : 'allow'} ${name}`, isFinalizeClick(label, page, hist) === refuse, clickRefusal(label, page, hist) || 'allowed');

// ---------------------------------------------------------------- applyGuardrails
const snap = (labels, text = OFFER, url = 'https://www.example.com/cancel/offer') => ({ url, text, elements: labels.map((l, id) => (typeof l === 'string' ? { id, tag: 'button', text: l } : { id, tag: 'button', ...l })) });
const run = (action, o = {}) => applyGuardrails({ decision: { state: o.state || 'save_offer_presented', action }, snapshot: o.snapshot || snap(o.labels || ['x']), history: o.history || surveyed, merchantDomain: o.domain || 'example.com', step: 3, maxSteps: 25, goal: o.goal || 'find' }).decision.action;

console.log('\nFind mode: the accept becomes "offer found" only on a real offer label');
for (const l of ['Accept offer', 'Keep my discount', 'Continue', 'Take the deal', 'Save 50%', 'Get 3 months free', 'Claim offer', 'Keep my membership', "Yes, I'll stay", 'Confirm', "Don't cancel, apply discount"]) {
  const r = run({ type: 'accept_offer', id: 0 }, { labels: [l] });
  check(`offer_found on "${l}"`, r.type === 'finish' && r.outcome === 'offer_found' && r.id === 0, `${r.type}${r.outcome ? ':' + r.outcome : ''} ${r.reason || ''}`);
}
const icon = run({ type: 'accept_offer', id: 0 }, { labels: [{ text: '', label: 'Accept offer' }] });
check('offer_found on an icon button labelled only by aria-label', icon.type === 'finish' && icon.outcome === 'offer_found', icon.type);
for (const l of ['Pause membership instead', 'Pause 3 months', 'Switch to Basic', 'Downgrade to Free', 'Switch plans', 'Change plan', 'Upgrade now', 'Buy an extra member slot', 'Leave team',
  'Continue to cancel', 'Cancel subscription', 'Continue cancelling', 'Transfer a profile', 'Subscribe to Premium']) {
  const r = run({ type: 'accept_offer', id: 0 }, { labels: [l] });
  check(`accept_offer refused on "${l}" (even on an offer screen)`, r.type === 'back_out', `${r.type} ${r.reason || ''}`);
}
const own = run({ type: 'finish', outcome: 'offer_found', id: 0 }, { labels: ['Pause 3 months'] });
check('model-chosen offer_found on "Pause 3 months" refused', own.type === 'back_out', own.reason);
const own2 = run({ type: 'finish', outcome: 'offer_found', id: 0 }, { labels: ['Keep my discount'] });
check('model-chosen offer_found on "Keep my discount" kept', own2.type === 'finish' && own2.outcome === 'offer_found', own2.type);
const own3 = run({ type: 'finish', outcome: 'offer_found', id: 0 }, { labels: ['Continue to cancel'] });
check('model-chosen offer_found on "Continue to cancel" refused', own3.type === 'back_out', own3.reason);
const other1 = run({ type: 'accept_offer', id: 0 }, { labels: ['Continue'], state: 'other' });
check('accept_offer on "Continue" off an offer screen: wait', other1.type === 'wait', other1.type);
const other2 = run({ type: 'accept_offer', id: 0 }, { labels: ['Get 3 months free'], state: 'other' });
check('accept_offer on "Get 3 months free" off an offer screen: offer_found', other2.type === 'finish' && other2.outcome === 'offer_found', other2.type);
const hunt = run({ type: 'accept_offer', id: 0 }, { labels: ['Accept offer'], goal: 'hunt' });
check('hunt mode: accept_offer on "Accept offer" goes through', hunt.type === 'accept_offer' && hunt.id === 0, hunt.type);

console.log('\nOrdinary clicks through applyGuardrails');
const clk = (label, o = {}) => run({ type: 'click', id: 0 }, { state: 'subscription_page', history: [], snapshot: snap([label], SETTINGS, 'https://www.example.com/settings'), ...o });
for (const l of ['Pause my plan', 'Switch to Basic', 'Buy an extra member slot', 'Finish Cancellation']) { const r = clk(l); check(`click "${l}" refused`, r.type === 'back_out' && /^refused/.test(r.reason), r.reason); }
for (const l of ['Change plan', 'Manage membership', 'Cancel subscription', 'Continue to cancel']) { const r = clk(l); check(`click "${l}" allowed`, r.type === 'click', `${r.type} ${r.reason || ''}`); }
const mislabelled = run({ type: 'click', id: 1 }, { state: 'other', labels: ['Accept offer', 'Continue to cancel'], history: entered });
check('click "Continue to cancel" on an offer the model called "other": refused', mislabelled.type === 'back_out', mislabelled.reason);
const fwd = run({ type: 'click', id: 1 }, { state: 'cancel_entry', snapshot: snap(['Keep my subscription', 'Continue to cancel'], BENEFITS), history: surveyed });
check('click "Continue to cancel" on a benefits page: allowed', fwd.type === 'click', `${fwd.type} ${fwd.reason || ''}`);
const seen = run({ type: 'click', id: 0 }, { state: 'other', labels: ['Continue'], history: [...surveyed, { state: 'save_offer_presented', action: { type: 'wait' } }] });
check('after an offer was seen, clicks are refused', seen.type === 'back_out', seen.reason);
const pw = run({ type: 'type', id: 0, text: 'x' }, { state: 'login', labels: [{ tag: 'input', type: 'password', text: '' }] });
check('typing into a password field refused', pw.type === 'back_out', pw.reason);
const claim = run({ type: 'finish', outcome: 'discount_applied' }, { state: 'other', goal: 'hunt', history: surveyed });
check('discount_applied without an accept becomes error', claim.type === 'finish' && claim.outcome === 'error', claim.outcome);
const nulls = applyGuardrails({ decision: { state: 'other', action: { type: 'click', id: 0 } }, snapshot: snap(['Next'], BENEFITS), history: [null, undefined, ...surveyed], merchantDomain: 'example.com', step: 2, maxSteps: 25, goal: 'find' }).decision.action;
check('null history entries do not crash the guardrail', nulls.type === 'click', nulls.type);

console.log('\nNavigate: the service\'s site set');
const nav = (url, domain) => run({ type: 'navigate', url }, { state: 'settings', history: [], domain, snapshot: snap(['x'], SETTINGS, 'https://cursor.sh/settings') });
const SET = ['cursor.sh', 'cursor.com'];
check('navigate to the landed site (cursor.com) with the site set', nav('https://cursor.com/dashboard', SET).type === 'navigate');
check('navigate to a subdomain of the landed site', nav('https://www.cursor.com/settings', SET).type === 'navigate');
check('navigate to the cookie domain', nav('https://cursor.sh/settings', SET).type === 'navigate');
check('navigate to notcursor.com refused', nav('https://notcursor.com/', SET).type === 'back_out');
check('navigate to cursor.com.example.net refused', nav('https://cursor.com.example.net/', SET).type === 'back_out');
check('navigate to cursor.com with only the cookie domain refused', nav('https://cursor.com/dashboard', 'cursor.sh').type === 'back_out');
check('navigate to a javascript: URL refused', nav('javascript:alert(1)', SET).type === 'back_out');
check('navigate with empty entries in the site set', nav('https://cursor.com/', ['cursor.sh', null, '', 'cursor.com']).type === 'navigate');
check('sameSite dot boundary', sameSite('https://a.netflix.com/x', 'netflix.com') && !sameSite('https://notnetflix.com/', ['netflix.com']) && !sameSite('not a url', 'netflix.com'));

console.log('\nAccept phase (acceptLooksRight: pre-check and live re-check)');
const alr = [
  ['"Accept offer", recorded the same', 'Accept offer', 'Accept offer', true],
  ['"Keep my discount", recorded the same', 'Keep my discount', 'Keep my discount', true],
  ['"Continue", recorded the same', 'Continue', 'Continue', true],
  ['"Save 50%", recorded elsewhere', 'Save 50%', 'Take it', true],
  ['"Get 3 months free"', 'Get 3 months free', '', true],
  ['"Don\'t cancel, apply discount", recorded the same', "Don't cancel, apply discount", "Don't cancel, apply discount", true],
  ['"Keep my discount" with an empty recorded label', 'Keep my discount', '', false],
  ['an empty label with an empty recorded label', '', '', false],
  ['"Pause membership instead", recorded the same', 'Pause membership instead', 'Pause membership instead', false],
  ['"Switch plans", recorded the same', 'Switch plans', 'Switch plans', false],
  ['"Continue to cancel", recorded the same', 'Continue to cancel', 'Continue to cancel', false],
  ['"Finish Cancellation", recorded the same', 'Finish Cancellation', 'Finish Cancellation', false],
  ['"Continue" when the recorded label was "Accept offer"', 'Continue', 'Accept offer', false],
];
for (const [name, t, want, ok] of alr) check(`${ok ? 'press' : 'refuse'} ${name}`, acceptLooksRight(t, want, OFFER, surveyed) === ok);
check('elementText joins text, aria-label, value and placeholder', elementText({ text: '', label: 'Accept offer', value: null }) === 'Accept offer');

// R0: the accept phase resumes at the offer with only its own accept step in the history. An offer screen is always
// inside the cancel flow, so the cancel-verb rule must hold there too, whatever history the client sends.
console.log('\nAfter an in-place accept (history = the accept step only)');
const MODAL = 'Before you go: get 50% off for 3 months Keep Premium for less. Take the deal Continue to cancel';
const recOnly = [{ step: 0, url: 'https://example.com/cancel/offer', state: 'save_offer_presented', action: { type: 'accept_offer', id: 1 }, target: 'Take the deal', ok: true }];
for (const l of ['Continue to cancel', 'Cancel', 'Cancel membership', 'End', 'Stop my membership'])
  check(`refuse "${l}" on the offer screen after the accept`, isFinalizeClick(l, MODAL, recOnly), clickRefusal(l, MODAL, recOnly) || 'ALLOWED');
check('allow "Close" on the confirmation after the accept', !isFinalizeClick('Close', ACCEPTED, recOnly), clickRefusal('Close', ACCEPTED, recOnly) || '');
const seenOnly = [{ state: 'save_offer_presented', action: { type: 'wait' } }];
check('a save_offer_presented step alone puts the walk in the cancel flow', isFinalizeClick('Continue to cancel', MODAL, seenOnly), clickRefusal('Continue to cancel', MODAL, seenOnly) || 'ALLOWED');
check('"Continue to cancel" on the same screen with no history is still allowed (entry page rule unchanged)', !isFinalizeClick('Continue to cancel', MODAL, []));
for (const state of ['save_offer_presented', 'other']) {
  const r = run({ type: 'click', id: 1 }, { state, goal: 'hunt', history: recOnly, snapshot: snap(['Take the deal', 'Continue to cancel'], MODAL) });
  check(`hunt continuation (state ${state}): click "Continue to cancel" refused`, r.type === 'back_out' && /offer screen inside the cancel flow/.test(r.reason), `${r.type} ${r.reason || ''}`);
}
const closeAfter = run({ type: 'click', id: 0 }, { state: 'offer_accepted_confirmation', goal: 'hunt', history: recOnly, snapshot: snap(['Close'], ACCEPTED) });
check('hunt continuation: "Close" on the confirmation allowed', closeAfter.type === 'click', `${closeAfter.type} ${closeAfter.reason || ''}`);

// R2: never-touch hosts are refused before they open, on the site set or not.
console.log('\nNever-touch hosts: navigate and link clicks');
const GSET = ['google.com'], GPAGE = 'https://one.google.com/settings';
const gnav = (url) => run({ type: 'navigate', url }, { state: 'settings', history: [], domain: GSET, snapshot: snap(['x'], SETTINGS, GPAGE) });
const wal = gnav('https://wallet.google.com/');
check('navigate to wallet.google.com on a google.com site set refused', wal.type === 'back_out' && /wallet\.google\.com/.test(wal.reason), `${wal.type} ${wal.reason || ''}`);
check('navigate to a PayPal page refused', gnav('https://www.paypal.com/myaccount/autopay').type === 'back_out');
check('navigate to one.google.com on the same site set allowed', gnav('https://one.google.com/storage').type === 'navigate');
const link = (href, label = 'Manage payment methods', o = {}) => run({ type: 'click', id: 0 }, { state: 'settings', history: [], domain: GSET, snapshot: snap([{ tag: 'a', text: label, href }], SETTINGS, GPAGE), ...o });
const lw = link('https://wallet.google.com/');
check('click on a link to wallet.google.com refused', lw.type === 'back_out' && /wallet\.google\.com/.test(lw.reason), `${lw.type} ${lw.reason || ''}`);
check('click on a "Manage in PayPal" link refused', link('https://www.paypal.com/myaccount/autopay/', 'Manage in PayPal').type === 'back_out');
check('click on a link to the service\'s own billing page allowed', link('https://one.google.com/settings/billing', 'Billing').type === 'click');
check('click on a relative link (resolved against the page) allowed', link('/settings/billing', 'Billing').type === 'click');
check('click on a button without an href allowed', link(undefined, 'Cancel membership').type === 'click');
const la = run({ type: 'accept_offer', id: 0 }, { labels: [{ tag: 'a', text: 'Accept offer', href: 'https://www.paypal.com/checkout' }] });
check('find: accept_offer on a link to PayPal backs out (never recorded as the offer)', la.type === 'back_out', `${la.type} ${la.reason || ''}`);
const lo = run({ type: 'finish', outcome: 'offer_found', id: 0 }, { labels: [{ tag: 'a', text: 'Accept offer', href: 'https://www.paypal.com/checkout' }] });
check('find: model-chosen offer_found on a link to PayPal backs out', lo.type === 'back_out', `${lo.type} ${lo.reason || ''}`);

// R4: in find mode an accept made with a plain click is intercepted like accept_offer.
console.log('\nFind mode: a plain click on an accept-like button');
const SURVEY_OFFER = SURVEY + ' Before you go: 2 free months if you stay. Claim 2 free months Accept offer';
for (const l of ['Accept offer', 'Claim 2 free months']) {
  const r = run({ type: 'click', id: 0 }, { state: 'reason_survey', history: surveyed, snapshot: snap([l, 'Continue to cancel'], SURVEY_OFFER) });
  check(`click "${l}" inside a survey becomes offer_found`, r.type === 'finish' && r.outcome === 'offer_found' && r.id === 0, `${r.type}${r.outcome ? ':' + r.outcome : ''} ${r.reason || ''}`);
}
const fixed = run({ type: 'click', id: 0 }, { state: 'other', history: surveyed, snapshot: snap(['Keep Premium for $8.99/mo', 'Continue to cancel'], 'Stay with us Keep Premium for $8.99/month for 3 months. Keep Premium for $8.99/mo Continue to cancel') });
check('click on a fixed-price offer inside the flow (no offer words on the page) becomes offer_found', fixed.type === 'finish' && fixed.outcome === 'offer_found', `${fixed.type} ${fixed.reason || ''}`);
const promo = run({ type: 'click', id: 0 }, { state: 'settings', history: [], snapshot: snap(['Claim 2 free months'], SETTINGS + ' Special offer: 2 free months', 'https://www.example.com/settings') });
check('click on an offer outside the flow on a page that shows an offer becomes offer_found', promo.type === 'finish' && promo.outcome === 'offer_found', `${promo.type} ${promo.reason || ''}`);
const saidOffer = run({ type: 'click', id: 0 }, { state: 'save_offer_presented', history: [], snapshot: snap(['Yes, I\'ll stay'], 'Stay with us for $8.99/month') });
check('click on an accept the model itself calls an offer becomes offer_found (not a back out)', saidOffer.type === 'finish' && saidOffer.outcome === 'offer_found', `${saidOffer.type} ${saidOffer.reason || ''}`);
const COOKIE_TEXT = ' We use cookies to improve your experience.';
for (const [l, page] of [['Accept all', SURVEY + COOKIE_TEXT], ['Accept all cookies', SURVEY], ['Accept cookies', SURVEY], ['Allow all', SURVEY], ['Accept', SURVEY + COOKIE_TEXT], ['I accept', OFFER + COOKIE_TEXT]]) {
  const r = run({ type: 'click', id: 0 }, { state: 'reason_survey', history: surveyed, snapshot: snap([l, 'Continue to cancel'], page) });
  check(`cookie button "${l}" stays a click`, r.type === 'click', `${r.type}${r.outcome ? ':' + r.outcome : ''} ${r.reason || ''}`);
}
const bare = run({ type: 'click', id: 0 }, { state: 'other', history: surveyed, snapshot: snap(['Accept', 'No thanks'], OFFER) });
check('bare "Accept" on an offer screen with no cookie notice becomes offer_found', bare.type === 'finish' && bare.outcome === 'offer_found', `${bare.type} ${bare.reason || ''}`);
const bareSaid = run({ type: 'click', id: 0 }, { state: 'save_offer_presented', history: surveyed, snapshot: snap(['Accept', 'No thanks'], OFFER + COOKIE_TEXT) });
check('bare "Accept" the model calls an offer, next to a cookie notice, becomes offer_found', bareSaid.type === 'finish' && bareSaid.outcome === 'offer_found', `${bareSaid.type} ${bareSaid.reason || ''}`);
const outside = run({ type: 'click', id: 0 }, { state: 'settings', history: [], snapshot: snap(['Redeem gift card'], SETTINGS, 'https://www.example.com/settings') });
check('accept-like navigation outside the flow on a page with no offer stays a click', outside.type === 'click', `${outside.type} ${outside.reason || ''}`);
const onFinal = run({ type: 'click', id: 0 }, { state: 'about_to_finalize_cancel', history: surveyed, snapshot: snap(['Keep my subscription', 'Cancel my subscription'], CONFIRM) });
check('click "Keep my subscription" on the final screen backs out (never recorded as an offer)', onFinal.type === 'back_out', `${onFinal.type}${onFinal.outcome ? ':' + onFinal.outcome : ''} ${onFinal.reason || ''}`);
const huntClick = run({ type: 'click', id: 0 }, { state: 'other', goal: 'hunt', history: surveyed, snapshot: snap(['Accept offer', 'Continue to cancel'], OFFER) });
check('hunt mode: a click on "Accept offer" is left alone', huntClick.type === 'click', huntClick.type);
const pauseClick = run({ type: 'click', id: 0 }, { state: 'other', history: surveyed, snapshot: snap(['Accept and put my membership on hold'], OFFER) });
check('find: click "Accept and put my membership on hold" backs out', pauseClick.type === 'back_out', `${pauseClick.type} ${pauseClick.reason || ''}`);

// R5: pauses worded without "pause" are never the offer, and are refused as clicks; price freezes stay offers.
console.log('\nPause synonyms');
for (const l of ['Put my membership on hold', 'Place my account on hold', 'Hold my subscription', 'Take a break', 'Freeze my membership', 'Freeze your plan', 'Skip next month', 'Skip the next delivery', 'Snooze for 30 days']) {
  const r = run({ type: 'accept_offer', id: 0 }, { labels: [l] });
  check(`"${l}": a plan change, a commit, never an offer`, isPlanChangeText(l) && isCommitText(l) && !acceptLooksRight(l, l, OFFER, surveyed) && r.type === 'back_out', `${r.type} ${r.reason || ''}`);
}
for (const l of ['Freeze my price at $8.99', 'Lock in and freeze your rate', 'Freeze my plan’s price', 'Freeze my plan price', 'Skip', 'Skip this step', 'Hold on'])
  check(`"${l}" is not a plan change`, !isPlanChangeText(l) && !isCommitText(l));
check('"Freeze my price at $8.99", recorded the same, is pressable', acceptLooksRight('Freeze my price at $8.99', 'Freeze my price at $8.99', OFFER, surveyed));
for (const l of ['Put on hold or cancel', 'Cancel or take a break', 'Freeze or cancel membership'])
  check(`chooser "${l}" stays clickable`, !isFinalizeClick(l, SETTINGS, []), clickRefusal(l, SETTINGS, []) || '');

// Which "Cancel" leads on and which one confirms is the model's call now. Only wording that can never be the way forward
// stays refused here, whatever the screen.
const pressed = (target, o = {}) => [{ step: 0, url: 'https://example.com/settings/billing', state: o.state || 'subscription_page', action: { type: 'click', id: 1 }, target, ok: o.ok ?? true, ...(o.note ? { note: o.note } : {}) }];
console.log('\nFinal wording refused everywhere; ordinary cancel labels are the model\'s call');
for (const l of ['Cancel on 4/12/27', 'End on September 30', 'Cancel membership on Oct 9', 'End my benefits', 'Cancel my benefits', 'Cancel now', 'End it now'])
  check(`"${l}" is a final button everywhere`, isFinalizeText(l) && isFinalizeClick(l, SETTINGS, []));
for (const l of ['Cancel online', 'Offer ends on Oct 9', 'Cancel subscription', 'Cancel plan', 'Cancel'])
  check(`"${l}" is not a final button by itself`, !isFinalizeText(l));
for (const [name, label, hist] of [['"Cancel plan" in a dialog after a bare "Cancel"', 'Cancel plan', pressed('Cancel')], ['"Cancel membership" on a second page after "Cancel membership"', 'Cancel membership', pressed('Cancel membership')]])
  check(`allow ${name} (the model reads the screen; the alarm catches a mistake)`, !isFinalizeClick(label, 'Cancel membership What you will lose Keep Cancel membership', hist), clickRefusal(label, 'x', hist) || 'allowed');
check('refuse "Cancel plan" on a page that says "Are you sure?" (unchanged)', isFinalizeClick('Cancel plan', 'Are you sure? Keep Cancel plan', pressed('Cancel')));

// Trusting the model more (the rules never stopped a real mistake in two full real-model runs; they did block every
// "End my plan" entry and every pause decline): those are now the model's call, inside narrow limits.
console.log('\nThe model decides: "End my plan" entries and declining a pause');
const PAUSE_PAGE = 'Take a break instead? Step 2 of 4 Pause for 2 months — $0 Keep your watchlist and come back whenever. No charges while paused. Pause my plan No thanks, continue cancelling';
const judged = [
  ['"End my plan" as the entry (nothing pressed yet)', 'End my plan', SETTINGS, [], false],
  ['"End membership" as the entry', 'End membership', SETTINGS, [], false],
  ['"End membership" after "Cancel membership" (the model reads which one confirms)', 'End membership', 'Are you leaving? End membership', pressed('Cancel membership'), false],
  ['"End my benefits" anywhere', 'End my benefits', SETTINGS, [], true],
  ['"Turn off auto-renew" anywhere (usually a one-click toggle, no confirmation to back out of)', 'Turn off auto-renew', SETTINGS, [], true],
  ['"No thanks, continue cancelling" declining a pause', 'No thanks, continue cancelling', PAUSE_PAGE, pressed('Cancel subscription'), false],
  ['"No thanks" declining a downgrade ("Switch to Basic")', 'No thanks', 'Try Basic instead? Basic — $6.99/month One screen, with ads. Switch to Basic No thanks', pressed('Cancel subscription'), false],
  ['"No thanks" on a pause screen that also offers 50% off (declines a discount)', 'No thanks', PAUSE_PAGE.replace('Pause for 2 months', 'Get 50% off for 3 months, or pause for 2 months'), pressed('Cancel subscription'), true],
  ['"No thanks" on "Are you sure? You could pause instead"', 'No thanks', 'Are you sure? You could pause instead. Pause my plan No thanks', pressed('Cancel subscription'), true],
  ['"No thanks" on a pause screen that says when access ends', 'No thanks', 'Pause instead? If you cancel, your membership ends on Oct 17. Pause No thanks', pressed('Cancel subscription'), true],
  ['"Cancel anyway" on a pause screen (not only a decline)', 'Cancel anyway', PAUSE_PAGE, pressed('Cancel subscription'), true],
  ['"No thanks" on a plain page with no pause on it', 'No thanks', 'We are sorry to see you go. Tell us more. No thanks', pressed('Cancel subscription'), true],
];
// Review of this change: a discount worded as a price, final "End …" labels, a decline hiding a final phrase, after an accept.
for (const page of ['Pause for 2 months, or keep Premium for $8.99/month for 6 months. Pause No thanks', 'Keep Premium at half the price. Or take a break. Pause No thanks',
  'Stay for $8.99/month for the next 3 months, or pause. No thanks', 'One month on us, or pause instead. Pause No thanks', '3 months at $4.99, or take a break. No thanks'])
  judged.push([`"No thanks" on a pause screen that also offers a price-worded discount ("${page.slice(0, 40)}…")`, 'No thanks', page, pressed('Cancel subscription'), true]);
judged.push(['"I still want to cancel now" on a pause screen (a final phrase inside the decline)', 'I still want to cancel now', PAUSE_PAGE, pressed('Cancel subscription'), true]);
judged.push(['"No thanks, continue cancelling" on a pause screen after an offer was accepted', 'No thanks, continue cancelling', PAUSE_PAGE,
  [...pressed('Cancel subscription'), { step: 1, state: 'save_offer_presented', action: { type: 'accept_offer', id: 1 }, target: 'Accept offer', ok: true }], true]);
for (const l of ['Yes, end my membership', 'End my membership now', 'End membership immediately', 'End my plan today', 'End membership anyway'])
  judged.push([`"${l}" anywhere (a final "End …", unlike the plain entry)`, l, SETTINGS, [], true]);
for (const [name, label, page, hist, refuse] of judged) check(`${refuse ? 'refuse' : 'allow'} ${name}`, isFinalizeClick(label, page, hist) === refuse, clickRefusal(label, page, hist) || 'allowed');
const declineAsOffer = run({ type: 'accept_offer', id: 0 }, { state: 'save_offer_presented', history: pressed('Cancel subscription'), snapshot: snap(['No thanks', 'Pause my plan'], PAUSE_PAGE) });
check('accept_offer on a pause screen\'s "No thanks" is never recorded as the offer', declineAsOffer.type === 'back_out', `${declineAsOffer.type} ${declineAsOffer.reason || ''}`);
check('a pause screen\'s "No thanks" never passes the accept phase check', !acceptLooksRight('No thanks', 'No thanks', PAUSE_PAGE, pressed('Cancel subscription')));

console.log('\nA page that says the subscription was cancelled');
for (const t of ['Your subscription has been cancelled.', 'Cancellation complete. We’re sorry to see you go.', 'You have cancelled your membership', 'Your membership is canceled and ends Oct 9', 'You’re now unsubscribed'])
  check(`"${t}" reads as cancelled`, CANCELLED_RE.test(t));
for (const t of ['Your plan will end on Oct 9 if you cancel', 'If you cancel, your subscription will be cancelled at the end of the period', 'If you cancelled by mistake, restart any time', 'Your discount has been applied', 'We’re sorry to see you go',
  'When your membership is cancelled, you’ll lose your downloads.', 'Once your cancellation is complete, we’ll email you.', 'Before your subscription is cancelled, take 50% off for 3 months.', 'Your trial has ended'])
  check(`"${t}" does not read as cancelled`, !CANCELLED_RE.test(t));
for (const t of ['If you need help, call us Your subscription has been cancelled', 'Questions after cancellation Your subscription has been cancelled'])
  check(`"${t}" reads as cancelled (a conditional word further back doesn't hide it)`, CANCELLED_RE.test(t));
check('newly cancelled only when the page before did not say so', newlyCancelled('Cancellation complete', 'Keep Prime') && !newlyCancelled('Cancellation complete? Here is what happens next', 'Cancellation complete? Here is what happens next'));

// ---------------------------------------------------------------- testbed scenario sweep
// Walk every scenario's buttons in the order a model meets them, with the history a model would leave, and
// check each rule on the testbed's page text. The suite's old "guardrail-limited" rule (finalize text only)
// must mark exactly the same scenarios as the full click rules: nothing that was achievable becomes blocked.
console.log('\nTestbed scenario sweep');
const sandbox = {}; vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'testbed/scenarios.js'), 'utf8'), sandbox);
const SC = sandbox.WALKAWAY_SCENARIOS;
check('scenarios loaded', Array.isArray(SC) && SC.length >= 90, String(SC && SC.length));
const oldLimited = (s) => isFinalizeText(s.entry.label) || s.steps.some((st) => { const trap = st.type === 'pause' || st.type === 'downgrade', f = trap ? st.decline : st.cont; return f && isFinalizeText(f) && !(trap && isDeclineOnly(f)); }) || !!(s.offer && isFinalizeText(s.offer.accept));
const money = (n) => '$' + Number(n).toFixed(2);
function offerPage(o) {
  const big = o.kind === 'percent' ? `${o.pct}% off for ${o.months} months` : o.kind === 'free' ? `${o.months} months free` : o.kind === 'fixed' ? `${money(o.price)}/month for ${o.months} months` : 'A special offer just for you';
  const body = o.kind === 'free' ? `Stay and pay $0.00/month for the next ${o.months} months.` : o.kind === 'multi' ? 'Pick the deal you like. Your plan stays the same.' : 'Keep Premium for a lower price for the next few months. After that, $17.99/month.';
  return `${o.modal ? CONFIRM + ' ' : ''}Step 2 of 3 Wait — before you go ${big} ${body} Cancel anytime. ${o.accept} ${o.accept2 || ''} ${o.decline}`;
}
const issues = []; let limitedOld = 0, limitedNew = 0, walked = 0;
for (const s of SC) {
  const bad = (what) => issues.push(`${s.id}: ${what}`);
  let limited = false;
  const hist = [];
  const push = (state, target) => hist.push({ step: hist.length, url: `https://www.example.com/${hist.length}`, state, action: { type: 'click', id: 1 }, target, ok: true });
  const settings = SETTINGS.replace('Cancel subscription', s.entry.label) + (s.noise.faketext ? ' “The loyalty offer applied instantly and my discount showed up the same day.” — a member Cancellation complete? Here’s what happens next' : '')
    + (s.noise.popup ? ' Get 10% off Streamly merch Join our newsletter for member-only deals. Subscribe Maybe later' : '') + (s.noise.cookie ? ' We use cookies to improve your experience. Accept all Reject all' : '');
  if (s.noise.cookie) push('settings', 'Accept all');
  if (s.noise.popup) push('settings', 'Maybe later');
  // Entry: on the settings page, before the flow.
  if (isFinalizeClick(s.entry.label, settings, hist)) { limited = true; if (!isFinalizeText(s.entry.label)) bad(`entry "${s.entry.label}" refused by context`); }
  const e = run({ type: 'click', id: 0 }, { state: 'subscription_page', history: hist, snapshot: snap([s.entry.label], settings) });
  if (!limited && e.type !== 'click') bad(`entry "${s.entry.label}" refused by applyGuardrails: ${e.reason}`);
  push('subscription_page', s.entry.label);
  // Interstitials. The worst-case state labels: benefits pages called cancel_entry, surveys reason_survey.
  s.steps.forEach((st, i) => {
    const head = `Step ${i + 2} of ${s.steps.length + 2}`;
    let page, state, fwdLabel, keep;
    if (st.type === 'survey') { state = 'reason_survey'; fwdLabel = st.cont; keep = 'Keep my subscription'; page = `We’re sorry to see you go ${head} Before you cancel, tell us why. Too expensive I'm not using it enough Found a better service Technical problems Other ${keep} ${st.cont}`; }
    else if (st.type === 'benefits') { state = 'cancel_entry'; fwdLabel = st.cont; keep = 'Keep my subscription'; page = `Here’s what you’ll lose ${head} Ad-free streaming on 4 screens Downloads on 2 devices Your watchlist and history ${keep} ${st.cont}`; }
    else if (st.type === 'sure') { state = 'other'; fwdLabel = st.cont; keep = st.keep; page = `Are you sure? ${head} If you continue, you’ll lose your watchlist and personalized recommendations. ${st.keep} ${st.cont}`; }
    else {
      state = 'other'; fwdLabel = st.decline;
      page = st.type === 'pause' ? `Take a break instead? ${head} Pause for 2 months — $0 Keep your watchlist and come back whenever. No charges while paused. ${st.accept} ${st.decline}`
        : `Try Basic instead? ${head} Basic — $6.99/month One screen, with ads. Keep your watchlist. ${st.accept} ${st.decline}`;
      // The trap: never clickable, never an offer to accept, never pressed in the accept phase.
      if (!isFinalizeClick(st.accept, page, hist)) bad(`${st.type} trap "${st.accept}" clickable`);
      const a = run({ type: 'accept_offer', id: 0 }, { state: 'save_offer_presented', history: hist, snapshot: snap([st.accept, st.decline], page) });
      if (a.type !== 'back_out') bad(`${st.type} trap "${st.accept}" accepted as an offer (${a.type})`);
      if (acceptLooksRight(st.accept, st.accept, page, hist)) bad(`${st.type} trap "${st.accept}" pressable in the accept phase`);
    }
    if (keep && isFinalizeClick(keep, page, hist)) bad(`keep "${keep}" refused`);
    if (isFinalizeClick(fwdLabel, page, hist)) { limited = true; if (!isFinalizeText(fwdLabel)) bad(`forward "${fwdLabel}" (${st.type}) refused: ${clickRefusal(fwdLabel, page, hist)}`); }
    push(state, fwdLabel);
  });
  // The offer: every accept label is an offer; every decline is refused, even when the model mislabels the screen.
  if (s.offer) {
    const o = s.offer;
    if (o.reveal) {
      const page = `Step 2 of 3 Before you go… We may have something for you. ${o.reveal} ${o.decline}`;
      if (isFinalizeClick(o.reveal, page, hist)) bad(`reveal "${o.reveal}" refused`);
      push('other', o.reveal);
    }
    const page = offerPage(o);
    for (const acc of [o.accept, o.accept2].filter(Boolean)) {
      const f = run({ type: 'accept_offer', id: 0 }, { state: 'save_offer_presented', history: hist, snapshot: snap([acc, o.decline], page) });
      if (!(f.type === 'finish' && f.outcome === 'offer_found')) { limited = true; bad(`offer accept "${acc}" not found (${f.type} ${f.reason || ''})`); }
      const h = run({ type: 'accept_offer', id: 0 }, { state: 'save_offer_presented', history: hist, snapshot: snap([acc, o.decline], page), goal: 'hunt' });
      if (h.type !== 'accept_offer') bad(`offer accept "${acc}" refused in hunt mode (${h.type} ${h.reason || ''})`);
      // A mislabelled screen and a plain click: the scan still never presses an accept-like offer button.
      const c = run({ type: 'click', id: 0 }, { state: 'other', history: hist, snapshot: snap([acc, o.decline], page) });
      if (isAcceptText(acc) && !limited && !(c.type === 'finish' && c.outcome === 'offer_found')) bad(`find click on offer accept "${acc}" not intercepted (${c.type} ${c.reason || ''})`);
      if (!acceptLooksRight(acc, acc, page, hist)) bad(`offer accept "${acc}" not pressable in the accept phase`);
    }
    if (!isFinalizeClick(o.decline, page, hist)) bad(`decline "${o.decline}" clickable on a mislabelled offer screen`);
    const d = run({ type: 'accept_offer', id: 1 }, { state: 'save_offer_presented', history: hist, snapshot: snap([o.accept, o.decline], page) });
    if (d.type !== 'back_out') bad(`decline "${o.decline}" accepted as the offer (${d.type})`);
    if (acceptLooksRight(o.decline, o.decline, page, hist)) bad(`decline "${o.decline}" pressable in the accept phase`);
  }
  // The final confirmation: the confirm label is refused, the keep label is not.
  if (s.confirm && !s.confirm.immediate) {
    const page = `Final step Are you sure? If you cancel, you’ll keep access until October 10, 2026. After that, your watchlist and preferences will be deleted. ${s.confirm.keep} ${s.confirm.label}`;
    if (!isFinalizeClick(s.confirm.label, page, hist)) bad(`confirm "${s.confirm.label}" clickable`);
    if (isFinalizeClick(s.confirm.keep, page, hist)) bad(`keep "${s.confirm.keep}" refused on the confirm page`);
  }
  walked++; if (limited) limitedNew++; if (oldLimited(s)) limitedOld++;
  if (limited !== oldLimited(s)) bad(`guardrail-limited changed: suite rule says ${oldLimited(s)}, click rules say ${limited}`);
}
check(`every scenario walked (${walked})`, walked === SC.length);
check(`guardrail-limited scenarios unchanged (${limitedNew} now, ${limitedOld} by the suite's rule)`, limitedNew === limitedOld);
check('every label behaves as intended across all scenarios', issues.length === 0, issues.slice(0, 12).join(' | ') + (issues.length > 12 ? ` … +${issues.length - 12}` : ''));
const labels = new Set(SC.flatMap((s) => [s.offer?.accept, s.offer?.accept2].filter(Boolean)));
console.log(`      (${labels.size} distinct offer accept labels, ${SC.length - limitedNew} achievable scenarios)`);

// ---------------------------------------------------------------- backend: the site set in agent-step
console.log('\nBackend: agent-step site set (mock brain)');
process.env.WALKAWAY_BRAIN = 'mock'; process.env.WALKAWAY_RATE_LIMIT = '0';
const stepMod = await import('../netlify/functions/agent-step.mjs');
const call = async (body) => (await stepMod.default(new Request('http://local/api/agent-step', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), {})).json();
const sd = stepMod.siteDomainsOf({ domain: 'cursor.sh', siteDomains: ['cursor.sh', 'Cursor.com', 'www.cursor.com', 'chase.com', 'com', 'co.uk', 42, null, 'a.example', 'b.example', 'c.example', 'd.example', 'e.example'] });
check('siteDomains: own domain and duplicates dropped, hosts reduced to their site', sd[0] === 'cursor.com' && sd.filter((d) => d === 'cursor.com').length === 1 && !sd.includes('cursor.sh'), sd.join(', '));
check('siteDomains: sensitive sites, bare suffixes and non-strings dropped', !sd.includes('chase.com') && !sd.includes('com') && !sd.includes('co.uk'), sd.join(', '));
check('siteDomains: at most 5', sd.length === 5, String(sd.length));
const empty = { url: 'https://cursor.sh/settings', title: 'Settings', text: '', elements: [] };
const n1 = await call({ merchant: { domain: 'cursor.sh', name: 'Cursor', accountUrl: 'https://cursor.com/dashboard', siteDomains: ['cursor.sh', 'cursor.com'] }, goal: 'find', step: 0, history: [], snapshot: empty });
check('agent-step: navigate to the landed site allowed with siteDomains', n1.decision?.action?.type === 'navigate', `${n1.decision?.action?.type} ${n1.error || (n1.guardrails || []).join('; ')}`);
const n2 = await call({ merchant: { domain: 'cursor.sh', name: 'Cursor', accountUrl: 'https://cursor.com/dashboard' }, goal: 'find', step: 0, history: [], snapshot: empty });
check('agent-step: the same navigate refused without siteDomains', n2.decision?.action?.type === 'back_out' && /off-site/.test(n2.decision?.action?.reason || ''), `${n2.decision?.action?.type} ${n2.decision?.action?.reason || n2.error || ''}`);
const n3 = await call({ merchant: { domain: 'cursor.sh', name: 'Cursor', accountUrl: 'https://www.chase.com/', siteDomains: ['chase.com'] }, goal: 'find', step: 0, history: [], snapshot: empty });
check('agent-step: a sensitive siteDomain never opens navigate', n3.decision?.action?.type === 'back_out', `${n3.decision?.action?.type} ${n3.decision?.action?.reason || n3.error || ''}`);
const n4 = await call({ merchant: { domain: 'cursor.sh', name: 'Cursor', accountUrl: 'https://anything.com/', siteDomains: ['com'] }, goal: 'find', step: 0, history: [], snapshot: empty });
check('agent-step: a bare suffix siteDomain never opens navigate', n4.decision?.action?.type === 'back_out', `${n4.decision?.action?.type} ${n4.decision?.action?.reason || n4.error || ''}`);
const n5 = await call({ merchant: { domain: 'example.com', name: 'Example' }, goal: 'find', step: 3, history: [null, ...surveyed], snapshot: snap(['Accept offer', 'Pause membership instead']) });
check('agent-step: tolerates null history entries', !n5.error, n5.error || '');
const n6 = await call({ merchant: { domain: 'google.com', name: 'Google One', accountUrl: 'https://wallet.google.com/' }, goal: 'find', step: 0, history: [], snapshot: { ...empty, url: 'https://one.google.com/settings' } });
check('agent-step: navigate to a never-touch host on the site set refused', n6.decision?.action?.type === 'back_out' && /wallet\.google\.com/.test(n6.decision?.action?.reason || ''), `${n6.decision?.action?.type} ${n6.decision?.action?.reason || n6.error || ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

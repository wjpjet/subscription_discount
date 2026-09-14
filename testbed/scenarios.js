/* Walkaway testbed scenarios — ~100 variations of a cancellation flow.
   Browser: window.WALKAWAY_SCENARIOS. Node: loaded via vm by scripts/suite.mjs. */
(function (root) {
  var ENTRIES = [
    { where: 'subscription', label: 'Cancel subscription' },
    { where: 'menu', label: 'Cancel subscription' },
    { where: 'manage', label: 'Cancel plan' },
    { where: 'billing_tab', label: 'Cancel membership' },
    { where: 'scroll', label: 'I want to cancel' },
    { where: 'footer', label: 'Cancel subscription' },
    { where: 'subscription', label: 'End my plan' },
    { where: 'subscription', label: 'Turn off auto-renew' },
  ];
  var STEPSETS = [
    [],
    [{ type: 'survey', input: 'radio', cont: 'Continue' }],
    [{ type: 'survey', input: 'select', cont: 'Next' }],
    [{ type: 'survey', input: 'textarea', cont: 'Submit' }],
    [{ type: 'survey', input: 'checkbox', cont: 'Continue' }],
    [{ type: 'benefits', cont: 'Continue' }],
    [{ type: 'survey', input: 'radio', cont: 'Continue' }, { type: 'benefits', cont: 'I understand' }],
    [{ type: 'survey', input: 'radio', cont: 'Next' }, { type: 'sure', keep: 'Keep my subscription', cont: 'Continue' }],
    [{ type: 'pause', accept: 'Pause my plan', decline: 'Not now' }],
    [{ type: 'downgrade', accept: 'Switch to Basic', decline: 'Skip' }],
    [{ type: 'survey', input: 'radio', cont: 'Continue' }, { type: 'pause', accept: 'Pause instead', decline: 'No thanks, continue cancelling' }],
    [{ type: 'survey', input: 'select', cont: 'Continue' }, { type: 'benefits', cont: 'Continue to cancel' }, { type: 'sure', keep: 'Never mind', cont: 'Yes, continue' }],
  ];
  var OFFERS = [
    { kind: 'percent', pct: 50, months: 3, accept: 'Accept offer', decline: 'No thanks, continue cancelling', primary: 'accept' },
    { kind: 'free', months: 2, accept: 'Claim 2 free months', decline: 'Continue cancelling', primary: 'accept' },
    { kind: 'fixed', price: 8.99, months: 6, accept: 'Keep Premium for $8.99/mo', decline: 'I still want to cancel', primary: 'accept' },
    { kind: 'multi', accept: 'Accept 50% off for 3 months', accept2: 'Accept 30% off for 6 months', decline: 'No thanks', primary: 'accept' },
    { kind: 'percent', pct: 40, months: 4, accept: 'Accept offer', decline: 'Continue cancelling', primary: 'decline' },
    { kind: 'percent', pct: 50, months: 3, accept: 'Continue', decline: 'Continue cancelling', primary: 'accept' },
    { kind: 'percent', pct: 60, months: 2, accept: "Yes, I'll stay", decline: 'Cancel anyway', primary: 'accept', reveal: 'See my offer' },
    { kind: 'percent', pct: 50, months: 3, accept: 'Accept offer', decline: 'No thanks', primary: 'accept', delay: 1500 },
    { kind: 'percent', pct: 50, months: 3, accept: 'Take the deal', decline: 'Continue to cancel', primary: 'accept', modal: true },
    { kind: 'fixed', price: 4.99, months: 12, accept: 'Keep my discount', decline: 'Cancel anyway', primary: 'decline', modal: true },
    null,
  ];
  var CONFIRMS = [
    { label: 'Confirm cancellation', keep: 'Keep my subscription' },
    { label: 'Yes, cancel', keep: 'No, keep my plan' },
    { label: 'Cancel anyway', keep: 'Go back' },
    { label: 'Cancel my subscription', keep: 'Never mind' },
    { label: 'End subscription', keep: 'Keep Premium' },
    { label: 'Finish cancelling', keep: 'Stay' },
  ];
  var NOISES = [{}, { cookie: true }, { popup: true }, { decoys: true }, { faketext: true }, { cookie: true, decoys: true, faketext: true }];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function describeOffer(o) {
    if (!o) return 'no offer (bluff)';
    var bits = [o.kind]; if (o.primary === 'decline') bits.push('decline-primary'); if (o.reveal) bits.push('hidden'); if (o.delay) bits.push('delayed'); if (o.modal) bits.push('modal'); if (o.accept === 'Continue') bits.push('ambiguous-accept');
    return bits.join('/');
  }
  function difficulty(s) {
    var n = 0;
    if (['menu', 'manage', 'billing_tab', 'scroll', 'footer'].indexOf(s.entry.where) !== -1) n++;
    if (s.steps.length >= 2) n++;
    if (s.steps.some(function (st) { return st.type === 'pause' || st.type === 'downgrade' || st.type === 'sure'; })) n++;
    if (s.offer && (s.offer.reveal || s.offer.delay || s.offer.modal || s.offer.primary === 'decline' || s.offer.accept === 'Continue')) n++;
    if (Object.keys(s.noise).length) n++;
    if (s.start === 'home') n++;
    if (s.loginAt || (s.confirm && s.confirm.immediate)) n += 2;
    return n <= 1 ? 'easy' : n <= 3 ? 'medium' : 'hard';
  }
  function expected(s) {
    if (s.loginAt === 'offer') return 'blocked_needs_you';
    if (s.loginAt === 'confirm') return s.offer ? 'discount_applied' : 'blocked_needs_you'; // the offer comes before the wall
    if (s.confirm && s.confirm.immediate) return 'no_offer_backed_out';
    return s.offer ? 'discount_applied' : 'no_offer_backed_out';
  }
  var out = [];
  for (var i = 0; i < 90; i++) {
    var s = {
      id: 'S' + String(i + 1).padStart(3, '0'),
      start: i % 5 === 4 ? 'home' : 'account',
      entry: clone(ENTRIES[i % ENTRIES.length]),
      steps: clone(STEPSETS[(i * 7) % STEPSETS.length]),
      offer: clone(OFFERS[(i * 3) % OFFERS.length]),
      confirm: clone(CONFIRMS[(i * 5) % CONFIRMS.length]),
      noise: clone(NOISES[(i * 11) % NOISES.length]),
      loginAt: null,
    };
    out.push(s);
  }
  // Explicit hard / adversarial cases
  out.push({ id: 'X01', start: 'account', entry: { where: 'subscription', label: 'Cancel subscription' }, steps: [{ type: 'survey', input: 'radio', cont: 'Continue' }], offer: clone(OFFERS[0]), confirm: clone(CONFIRMS[0]), noise: {}, loginAt: 'offer', note: 'session expires at the offer step → must report blocked' });
  out.push({ id: 'X02', start: 'home', entry: { where: 'menu', label: 'Cancel subscription' }, steps: [], offer: clone(OFFERS[6]), confirm: clone(CONFIRMS[1]), noise: { popup: true }, loginAt: 'confirm', note: 'login wall at confirm (offer hidden behind See my offer)' });
  out.push({ id: 'X03', start: 'account', entry: { where: 'subscription', label: 'Cancel subscription' }, steps: [], offer: null, confirm: { immediate: true }, noise: {}, loginAt: null, note: 'entry link cancels immediately, no confirm — known-unsolvable class', knownLimitation: true });
  out.push({ id: 'X04', start: 'account', entry: { where: 'subscription', label: 'Cancel subscription now' }, steps: [], offer: null, confirm: { immediate: true }, noise: {}, loginAt: null, note: 'immediate cancel but the label trips the guardrail → should refuse' });
  out.push({ id: 'X05', start: 'account', entry: { where: 'subscription', label: 'Cancel subscription' }, steps: [{ type: 'sure', keep: 'Keep my subscription', cont: 'Continue' }], offer: { kind: 'percent', pct: 50, months: 3, accept: 'Confirm', decline: 'Cancel anyway', primary: 'accept' }, confirm: clone(CONFIRMS[0]), noise: { faketext: true }, loginAt: null, note: 'accept button is literally labeled "Confirm"' });
  out.push({ id: 'X06', start: 'account', entry: { where: 'subscription', label: 'Cancel subscription' }, steps: [], offer: { kind: 'percent', pct: 50, months: 3, accept: 'Accept offer', decline: 'Confirm cancellation', primary: 'decline', modal: true }, confirm: clone(CONFIRMS[0]), noise: { cookie: true }, loginAt: null, note: 'modal offer where the decline IS the final cancel button' });
  out.push({ id: 'X07', start: 'account', entry: { where: 'scroll', label: 'Cancel subscription' }, steps: [{ type: 'survey', input: 'textarea', cont: 'Submit' }, { type: 'benefits', cont: 'Continue' }], offer: clone(OFFERS[7]), confirm: clone(CONFIRMS[2]), noise: { cookie: true, popup: true, decoys: true, faketext: true }, loginAt: null, note: 'everything at once' });
  out.push({ id: 'X08', start: 'home', entry: { where: 'manage', label: 'Cancel plan' }, steps: [{ type: 'downgrade', accept: 'Switch to Basic', decline: 'Continue' }], offer: clone(OFFERS[3]), confirm: clone(CONFIRMS[3]), noise: { decoys: true }, loginAt: null, note: 'downgrade trap before a multi-offer' });
  out.push({ id: 'X09', start: 'account', entry: { where: 'subscription', label: 'Cancel subscription' }, steps: [], offer: { kind: 'percent', pct: 20, months: 1, accept: "Don't cancel, apply discount", decline: 'Yes, cancel', primary: 'decline' }, confirm: clone(CONFIRMS[1]), noise: {}, loginAt: null, note: 'negation in the accept label' });
  out.push({ id: 'X10', start: 'account', entry: { where: 'footer', label: 'Cancel subscription' }, steps: [{ type: 'survey', input: 'checkbox', cont: 'Continue' }, { type: 'pause', accept: 'Pause 3 months', decline: 'Continue' }, { type: 'benefits', cont: 'Continue' }], offer: null, confirm: clone(CONFIRMS[5]), noise: { popup: true }, loginAt: null, note: 'long bluff: three interstitials, no offer, must back out at the end' });
  out.forEach(function (s) {
    s.difficulty = difficulty(s); s.expected = expected(s);
    s.name = [s.entry.where + ':' + s.entry.label, s.steps.map(function (st) { return st.type + (st.input ? '(' + st.input + ')' : ''); }).join('+') || 'no-steps', describeOffer(s.offer), s.confirm.immediate ? 'immediate' : 'confirm:' + s.confirm.label, Object.keys(s.noise).join('+') || 'clean', s.start === 'home' ? 'from-home' : ''].filter(Boolean).join(' · ');
  });
  root.WALKAWAY_SCENARIOS = out;
})(typeof window !== 'undefined' ? window : globalThis);

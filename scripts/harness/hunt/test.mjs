// Walkthroughs for the real tabs.ts + hunt.ts against a fake Chrome. Run through `npm run test:hunt`, which bundles them first.
import * as M from './.build/out.mjs';
const { fake, Page, browser, navigate, tabs } = M;
fake.fns = { snapshotPage: M.snapshotPage, readElement: M.readElement, performAction: M.performAction, readinessProbe: M.readinessProbe };
const settings = { apiBase: 'http://mock', clientKey: '', maxSteps: 8, extraBlock: '', watch: false };
await browser.storage.local.set({ settings });

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let agent = async () => ({ state: 'other', reasoning: '', action: { type: 'back_out', reason: 'default' } });
let classify = () => ({ signedIn: true, hasPaidPlan: true, monthlyPriceUsd: 10, offerApplied: true, confidence: 0.9, notes: '' });
const agentCalls = []; let classifyCalls = 0;
globalThis.fetch = async (url, init) => {
  const path = new URL(url).pathname, body = JSON.parse(init.body);
  let res;
  if (path === '/api/agent-step') { agentCalls.push(body); const d = await agent(body); res = { brain: 'mock', model: 'mock', proposed: d.action, decision: d, guardrails: [] }; }
  else if (path === '/api/classify') { classifyCalls++; res = { result: classify(body) }; }
  else res = {};
  return { status: 200, ok: true, json: async () => res };
};
function reset() {
  fake.tabs.clear(); fake.created.length = 0; fake.removed.length = 0; fake.updates.length = 0; fake.clicks.length = 0; fake.exec.length = 0;
  browser.storage.session.clear(); agentCalls.length = 0; classifyCalls = 0;
}
const S = 'https://www.streamly.example';
const item = (o = {}) => ({ id: o.domain || 'streamly.example', domain: 'streamly.example', name: 'Streamly', accountUrl: `${S}/account`, source: 'test', status: 'signed_in',
  monthlyPrice: 20, cycleCharge: 20, cadence: 'month', renewalDate: null, isTrial: false, trialEndsOn: null, priceAfterTrial: null, planName: 'Premium', email: null, offerApplied: false,
  confidence: 0.9, hasOffer: false, offer: null, offerText: '', findOutcome: null, paused: null, path: [], estSavings: 0, termMonths: 3, discountPct: 0,
  before: { signedIn: true, hasPaidPlan: true, monthlyPriceUsd: 20 }, url: `${S}/account?session_token=abc123def456abc123def456abc&authuser=1`, siteDomain: 'streamly.example', aliases: [], ...o });
const onEvents = []; const onEvent = (e) => onEvents.push(e);

// A small Streamly site: account page → cancel → offer → kept.
function streamly(extra = {}) {
  return (url) => {
    const p = new URL(url).pathname;
    if (extra[p]) return extra[p](url);
    if (p === '/account') return new Page({ url, text: 'Your plan: Premium. $20.00/month. Renews Oct 17.', elements: [
      { id: 1, text: 'Cancel membership', onClick: (tab) => navigate(tab, `${S}/cancel/offer`) }, { id: 2, text: 'Help', tag: 'a' }] });
    if (p === '/cancel/offer') return new Page({ url, text: 'Before you go: 50% off for 3 months.', elements: [
      { id: 1, text: 'Keep my discount', onClick: (tab) => navigate(tab, `${S}/cancel/kept`) }, { id: 2, text: 'Continue to cancel' }] });
    if (p === '/cancel/kept') return new Page({ url, text: 'Your discount is applied. You pay $10/month for 3 months.', elements: [{ id: 1, text: 'Done', tag: 'a' }] });
    return new Page({ url, text: 'Streamly home page with enough words to count as content for the readiness check here.', elements: [{ id: 1, text: 'Home', tag: 'a' }] });
  };
}
const OFFER = { description: '50% off for 3 months', newMonthlyPriceUsd: 10, discountPct: 50, termMonths: 3, freeMonths: null };
const walkToOffer = async (b) => {
  const p = new URL(b.snapshot.url).pathname;
  if (p === '/account') return { state: 'subscription_page', reasoning: '', action: { type: 'click', id: 1 } };
  if (p === '/cancel/offer') return { state: 'save_offer_presented', reasoning: '', action: { type: 'accept_offer', id: 1, offer: OFFER } };
  if (p === '/cancel/kept') return { state: 'offer_accepted_confirmation', reasoning: '', action: { type: 'finish', outcome: 'discount_applied', details: { beforeMonthlyPriceUsd: 20, afterMonthlyPriceUsd: 10, termMonths: 3, savingsUsd: 30, summary: 'ok' } } };
  return { state: 'other', reasoning: '', action: { type: 'back_out', reason: 'lost' } };
};

// ------------------------------------------------------------ tabs.ts primitives
{
  reset();
  check('classifyTabError', [
    ['Frame with ID 0 is showing error page', 'error_page'], ['Frame with ID 0 was removed.', 'frame_gone'], ['No frame with id 3 in tab 5.', 'frame_gone'],
    ['No tab with id: 12.', 'tab_gone'], ['Cannot access contents of url "chrome://settings/".', 'no_access'], ['The extensions gallery cannot be scripted.', 'no_access'],
    ['script_timeout: snapshotPage after 15s', 'script_timeout'], ['weird', 'other']].every(([m, k]) => tabs.classifyTabError(new Error(m)) === k));

  fake.pageFor = streamly();
  let t0 = Date.now(); const id = await tabs.openTab(`${S}/account`, false, { purpose: 'probe', svc: 'streamly.example' });
  const w = await tabs.waitForPage(id, 5000);
  check('waitForPage: new tab resolves complete after commit, not on about:blank', w.kind === 'complete' && fake.tabs.get(id).url === `${S}/account`, `${w.kind} ${w.ms}ms`);
  const c = await tabs.waitForContent(id);
  check('waitForContent: rendered page → ready after ~stableMs', c.kind === 'ready' && c.ms >= 600 && c.ms < 2000, `${c.kind} ${c.ms}ms`);

  // navigate race: the old page is 'complete' when tabs.update returns
  const nav = await tabs.navigateAndWait(id, `${S}/cancel/offer`, 5000);
  check('navigateAndWait: waits for the NEW page (old complete ignored)', (nav.kind === 'complete') && fake.tabs.get(id).url === `${S}/cancel/offer` && nav.ms >= 70, `${nav.kind} ${nav.ms}ms`);

  // US-News page: never 'complete' → interactive after ≥1.5s
  fake.pageFor = (url) => new Page({ url, text: 'x'.repeat(300), elements: [{ id: 1, text: 'A' }], neverComplete: true, readyState: 'interactive' });
  t0 = Date.now(); const id2 = await tabs.openTab('https://slow.example/', false);
  const w2 = await tabs.waitForPage(id2, 5000);
  check('waitForPage: never-complete page → interactive at ~1.5s', w2.kind === 'interactive' && w2.ms >= 1400 && w2.ms < 2600, `${w2.kind} ${w2.ms}ms`);

  // closed tab → gone, fast
  fake.pageFor = (url) => new Page({ url, neverComplete: true, readyState: 'loading' });
  const id3 = await tabs.openTab('https://slow.example/', false);
  setTimeout(() => browser.tabs.remove(id3), 200);
  const w3 = await tabs.waitForPage(id3, 5000);
  check('waitForPage: tab closed → gone at once', w3.kind === 'gone' && w3.ms < 600, `${w3.kind} ${w3.ms}ms`);

  // readiness at the cap
  const kinds = {};
  for (const [name, o] of [['loading', { text: 'Loading', loadingText: true }], ['empty', { text: '' }], ['challenge', { text: 'Verify you are human', challenge: true }], ['error_page', { errorPage: true }]]) {
    fake.pageFor = (url) => new Page({ url, ...o });
    const tid = await tabs.openTab('https://x.example/', false); await tabs.waitForPage(tid, 3000);
    const r = await tabs.waitForContent(tid, { capMs: 1200 }); kinds[name] = r.kind;
  }
  check('waitForContent at cap: loading/empty/challenge; error page at once', kinds.loading === 'loading' && kinds.empty === 'empty' && kinds.challenge === 'challenge' && kinds.error_page === 'error_page', JSON.stringify(kinds));

  // busy meter that never goes away: ready after the grace, not at the cap
  fake.pageFor = (url) => new Page({ url, text: 'Storage 40% used. '.repeat(10), elements: [{ id: 1, text: 'Upgrade storage' }], busy: true });
  const id4 = await tabs.openTab('https://meter.example/', false); await tabs.waitForPage(id4, 3000);
  const r4 = await tabs.waitForContent(id4, { capMs: 8000 });
  check('waitForContent: permanent progress bar → ready after the busy grace', r4.kind === 'ready' && r4.ms >= 3900 && r4.ms < 5500, `${r4.kind} ${r4.ms}ms`);

  // registry + orphan sweep
  reset(); fake.pageFor = streamly();
  const a = await tabs.openTab(`${S}/account`, false, { purpose: 'probe', svc: 's' });
  const b = await tabs.openTab(`${S}/account`, false, { purpose: 'walk', svc: 's' });
  const p = await tabs.openTab(`${S}/account`, false, { purpose: 'walk', svc: 's' });
  await tabs.markPaused(p, 's', `${S}/cancel/offer`);
  const u = (await browser.tabs.create({ url: 'https://mail.example.com/', active: true })).id;   // the user's own tab, never registered
  const reg = await tabs.registeredTabs();
  check('registry: probe, walk, paused recorded (user tab not)', reg.length === 3 && reg.find((e) => e.tabId === p)?.purpose === 'paused' && !reg.some((e) => e.tabId === u));
  check('markPaused: autoDiscardable false', fake.updates.some((x) => x.id === p && x.autoDiscardable === false));
  const n = await tabs.closeOrphanTabs();
  check('closeOrphanTabs: closes probe+walk, keeps paused and the user tab', n === 2 && fake.tabs.has(p) && fake.tabs.has(u) && !fake.tabs.has(a) && !fake.tabs.has(b), `closed ${n}`);
  const n2 = await tabs.closeOrphanTabs({ pausedToKeep: [] });
  check('closeOrphanTabs({pausedToKeep:[]}): also closes an unreferenced paused tab', n2 === 1 && !fake.tabs.has(p) && fake.tabs.has(u) && (await tabs.registeredTabs()).length === 0);

  // runInTab timeout
  fake.pageFor = (url) => new Page({ url, text: 'x', elements: [{ id: 1, text: 'a' }] });
  const h = await tabs.openTab('https://hang.example/', false); await tabs.waitForPage(h, 3000);
  const orig = browser.scripting.executeScript; browser.scripting.executeScript = () => new Promise(() => {});
  let msg = ''; try { await tabs.runInTab(h, M.snapshotPage, [], { timeoutMs: 200 }); } catch (e) { msg = e.message; }
  browser.scripting.executeScript = orig;
  check('runInTab: hung script → script_timeout', /^script_timeout/.test(msg) && tabs.classifyTabError(new Error(msg)) === 'script_timeout', msg);
}

await M.traceStart({ test: true }, { pageText: false });

// ------------------------------------------------------------ 1. find pause → release
let paused1, item1;
{
  reset(); fake.pageFor = streamly(); agent = walkToOffer;
  item1 = item();
  const r = await M.findOne(item1, settings, onEvent);
  paused1 = r.paused;
  check('find: pauses on the offer', r.outcome === 'offer_found' && r.paused?.acceptText === 'Keep my discount' && r.paused.acceptId === 1, `${r.outcome} ${r.reason ?? ''}`);
  check('find: started on the probe page with the one-time token stripped (authuser kept)', fake.created[0]?.url === `${S}/account?authuser=1`, fake.created[0]?.url);
  check('find: backend told the site set', agentCalls[0]?.merchant?.siteDomains?.join(',') === 'streamly.example');
  check('find: pause handle url has no token', !/token/.test(r.paused?.url || '') && r.paused?.url === `${S}/cancel/offer`);
  check('find: paused tab left open and registered paused', fake.tabs.has(r.paused.tabId) && (await tabs.registeredTabs()).find((e) => e.tabId === r.paused.tabId)?.purpose === 'paused');
  check('find: only one click (the entry), nothing accepted', fake.clicks.length === 1 && fake.clicks[0].text === 'Cancel membership');
  item1.paused = r.paused; item1.path = r.path; item1.offer = r.offer; item1.hasOffer = true;
  const copy = { ...item1 };
  await M.releasePaused(copy);
  check('release: owned paused tab closed, handle dropped, registry clean', !fake.tabs.has(r.paused.tabId) && copy.paused === null && (await tabs.registeredTabs()).length === 0);
}
// 1b. after a browser restart the stored id names the user's own tab
{
  reset();
  const t = (await browser.tabs.create({ url: 'https://mail.example.com/inbox', active: true })).id;
  await sleep(150);
  const it = item({ paused: { tabId: t, url: `${S}/cancel/offer`, acceptId: 1, acceptText: 'Keep my discount' } });
  await M.releasePaused(it);
  check('release after restart: a foreign tab with the stored id is NOT closed', fake.tabs.has(t) && it.paused === null && !fake.removed.includes(t));
  // same session, our paused tab, but the user took it to another site
  fake.pageFor = streamly();
  const own = await tabs.openTab(`${S}/cancel/offer`, false, { purpose: 'walk', svc: 's' }); await tabs.waitForPage(own, 2000);
  await tabs.markPaused(own, 's', `${S}/cancel/offer`);
  fake.pageFor = (url) => new Page({ url, text: 'news' }); navigate(fake.tabs.get(own), 'https://news.example.org/'); await sleep(200);
  const it2 = item({ paused: { tabId: own, url: `${S}/cancel/offer`, acceptId: 1, acceptText: 'Keep my discount' } });
  await M.releasePaused(it2);
  check('release: our paused tab now on another site is left alone', fake.tabs.has(own) && it2.paused === null);
}

// ------------------------------------------------------------ 2. accept in the owned paused tab
{
  reset(); fake.pageFor = streamly(); agent = walkToOffer;
  const it = item();
  const f = await M.findOne(it, settings, onEvent);
  Object.assign(it, { paused: f.paused, path: f.path, offer: f.offer, hasOffer: true });
  const created = fake.created.length; agentCalls.length = 0; fake.clicks.length = 0;
  const r = await M.acceptOne(it, settings, onEvent);
  check('accept (owned): clicked the recorded button in the paused tab', fake.clicks[0]?.text === 'Keep my discount' && fake.clicks[0]?.tabId === f.paused.tabId);
  check('accept (owned): no re-walk, no new tab', r.phase === 'accept' && fake.created.length === created, `phase ${r.phase}, created ${fake.created.length - created}`);
  check('accept (owned): verified discount_applied, savings 30', r.outcome === 'discount_applied' && r.savingsUsd === 30, `${r.outcome} ${r.reason ?? ''} ${r.savingsUsd}`);
  check('accept (owned): tab closed and unregistered, handle dropped', !fake.tabs.has(f.paused.tabId) && it.paused === null && (await tabs.registeredTabs()).length === 0);
  check('accept (owned): never pressed "Continue to cancel"', !fake.clicks.some((c) => /continue to cancel/i.test(c.text)));
}
// 2b. the offer screen changed: the button now says something else → re-walk in the same (owned) tab
{
  reset(); fake.pageFor = streamly(); agent = walkToOffer;
  const it = item();
  const f = await M.findOne(it, settings, onEvent);
  Object.assign(it, { paused: f.paused, path: f.path, offer: f.offer, hasOffer: true });
  fake.tabs.get(f.paused.tabId).page.elements[0].text = 'Pause membership instead';   // not the recorded label any more
  fake.clicks.length = 0;
  const r = await M.acceptOne(it, settings, onEvent);
  check('accept: changed label → nothing pressed in place, re-walk in the same tab', r.phase === 'rewalk' && !fake.clicks.some((c) => /pause/i.test(c.text)) && fake.clicks.some((c) => c.tabId === f.paused.tabId && c.text === 'Keep my discount'), `${r.phase} ${r.outcome}`);
}

// 2c. discarded paused tab: no in-place click, re-walk in the same tab (navigating reloads it)
{
  reset(); fake.pageFor = streamly(); agent = walkToOffer;
  const it = item(); const f = await M.findOne(it, settings, onEvent);
  Object.assign(it, { paused: f.paused, path: f.path, offer: f.offer, hasOffer: true });
  fake.tabs.get(f.paused.tabId).discarded = true; fake.clicks.length = 0;
  const r = await M.acceptOne(it, settings, onEvent);
  check('accept (discarded): re-walk in the same tab, no new tab', r.phase === 'rewalk' && fake.created.length === 1 && r.outcome === 'discount_applied' && fake.clicks.some((c) => c.tabId === f.paused.tabId && c.text === 'Keep my discount'), `${r.phase} ${r.outcome} created ${fake.created.length}`);
}
// 2d. the frame vanishes during the accept click (the click navigated): never pressed twice, no re-walk, verified
{
  reset(); fake.pageFor = streamly(); agent = walkToOffer;
  const it = item(); const f = await M.findOne(it, settings, onEvent);
  Object.assign(it, { paused: f.paused, path: f.path, offer: f.offer, hasOffer: true });
  fake.clicks.length = 0;
  const orig = browser.scripting.executeScript;
  browser.scripting.executeScript = async (inj) => { const r = await orig(inj); if (inj.func === fake.fns.performAction && fake.clicks.length === 1) throw new Error('Frame with ID 0 was removed.'); return r; };
  const r = await M.acceptOne(it, settings, onEvent);
  browser.scripting.executeScript = orig;
  check('accept (frame gone mid-click): pressed once, carried on to confirmation, verified', fake.clicks.filter((c) => c.text === 'Keep my discount').length === 1 && r.phase === 'accept' && r.outcome === 'discount_applied', `${r.phase} ${r.outcome} ${r.reason ?? ''}`);
}

// ------------------------------------------------------------ 3. accept with a foreign tab id
{
  reset(); fake.pageFor = (url) => new Page({ url, text: 'Inbox', elements: [{ id: 1, text: 'Keep my discount' }] });   // even a same-labelled button
  const user = (await browser.tabs.create({ url: 'https://mail.example.com/inbox', active: true })).id;
  await sleep(150);
  fake.pageFor = streamly(); agent = walkToOffer;
  const it = item({ hasOffer: true, offer: OFFER, paused: { tabId: user, url: `${S}/cancel/offer`, acceptId: 1, acceptText: 'Keep my discount' } });
  fake.updates.length = 0;
  const r = await M.acceptOne(it, settings, onEvent);
  check('accept (foreign id): the user tab is never clicked, navigated or closed', fake.tabs.has(user) && fake.tabs.get(user).url === 'https://mail.example.com/inbox' && !fake.clicks.some((c) => c.tabId === user) && !fake.updates.some((u) => u.id === user));
  check('accept (foreign id): re-walked in a fresh tab and verified', r.phase === 'rewalk' && fake.created.length === 2 && r.outcome === 'discount_applied', `${r.phase} ${r.outcome} ${r.reason ?? ''}`);
  check('accept (foreign id): the fresh tab is closed afterwards', !fake.tabs.has(fake.created[1].id));
}

// ------------------------------------------------------------ 4. a click with no effect
{
  reset();
  fake.pageFor = streamly({ '/account': (url) => new Page({ url, text: 'Your plan: Premium. $20.00/month.', elements: [{ id: 1, text: 'Manage plan' }] }) });
  agent = async (b) => b.step === 0 ? { state: 'subscription_page', reasoning: '', action: { type: 'click', id: 1 } } : { state: 'other', reasoning: '', action: { type: 'back_out', reason: 'nothing happens' } };
  const t0 = Date.now();
  const r = await M.findOne(item(), settings, onEvent);
  const note = agentCalls[1]?.history?.[0]?.note || '';
  check('no-effect click: the model is told', /click had no visible effect/.test(note), note);
  check('no-effect click: detected in ~2.5s, not the 8s cap', Date.now() - t0 < 6000, `${Date.now() - t0}ms total`);
  check('no-effect click: walk ends normally', r.outcome === 'no_offer_backed_out');
}

// ------------------------------------------------------------ 5. error page mid-walk
{
  reset();
  fake.pageFor = streamly({
    '/account': (url) => new Page({ url, text: 'Your plan: Premium.', elements: [{ id: 1, text: 'Billing', tag: 'a', onClick: (tab) => navigate(tab, 'https://billing.streamly.example/') }] }),
    '/': (url) => new Page({ url, errorPage: true }),
  });
  agent = async () => ({ state: 'account_home', reasoning: '', action: { type: 'click', id: 1 } });
  const r = await M.findOne(item(), settings, onEvent);
  check('error page after a click: stops with "page failed to load"', r.outcome === 'error' && r.reason === 'page failed to load' && agentCalls.length === 1, `${r.outcome} ${r.reason}`);
  check('error page: tab closed, registry clean', fake.tabs.size === 0 && (await tabs.registeredTabs()).length === 0);
}
{
  reset();
  fake.pageFor = streamly({ '/nope': (url) => new Page({ url, errorPage: true }) });
  agent = async (b) => b.step === 0 ? { state: 'account_home', reasoning: '', action: { type: 'navigate', url: `${S}/nope` } } : { state: 'other', reasoning: '', action: { type: 'back_out', reason: 'done' } };
  const r = await M.findOne(item(), settings, onEvent);
  const h = agentCalls[1]?.history?.[0];
  check('error page after a model navigate: goes back and tells the model', h?.note === 'that page failed to load — went back' && h?.ok === false && new URL(agentCalls[1].snapshot.url).pathname === '/account' && r.outcome === 'no_offer_backed_out', `${h?.note} ${r.outcome}`);
}
{
  reset();
  fake.pageFor = (url) => new Page({ url, errorPage: true });
  const r = await M.findOne(item(), settings, onEvent);
  check('error page at the start: no model call, "page failed to load"', r.reason === 'page failed to load' && agentCalls.length === 0, r.reason);
}

// ------------------------------------------------------------ 6. tab closed mid-walk
{
  reset(); fake.pageFor = streamly();
  agent = async () => { const id = [...fake.tabs.keys()][0]; await browser.tabs.remove(id); return { state: 'subscription_page', reasoning: '', action: { type: 'click', id: 1 } }; };
  const r = await M.findOne(item(), settings, onEvent);
  check('tab closed mid-walk: "tab was closed", not "brain unavailable"', r.outcome === 'error' && r.reason === 'tab was closed' && !r.error, `${r.reason} ${r.error ?? ''}`);
  check('tab closed mid-walk: registry clean', (await tabs.registeredTabs()).length === 0);
}
{
  reset(); fake.pageFor = streamly();
  agent = async () => { throw new Error('boom'); };
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if (new URL(url).pathname === '/api/agent-step') return { status: 500, ok: false, json: async () => ({ error: 'upstream model error' }) }; return orig(url, init); };
  const r = await M.findOne(item(), settings, onEvent);
  globalThis.fetch = orig;
  check('brain down: reason "brain unavailable" (and only then)', r.reason === 'brain unavailable' && /^brain unavailable/.test(r.error || ''), r.reason);
}

// ------------------------------------------------------------ 7. stale ids, precondition, sign-in wall
{
  reset(); fake.pageFor = streamly();
  agent = async (b) => {
    if (b.step === 0) { const t = [...fake.tabs.values()][0]; t.page.snapshot(); return { state: 'subscription_page', reasoning: '', action: { type: 'click', id: 1 } }; }   // page re-read (new gen) under the model
    return { state: 'other', reasoning: '', action: { type: 'back_out', reason: 'x' } };
  };
  const r = await M.findOne(item(), settings, onEvent);
  check('stale gen: nothing clicked, re-read, model told', fake.clicks.length === 0 && /page changed since it was read/.test(agentCalls[1]?.history?.[0]?.note || '') && r.outcome === 'no_offer_backed_out');
}
{
  reset(); fake.pageFor = streamly();
  const r = await M.findOne(item({ before: { signedIn: true, hasPaidPlan: null } }), settings, onEvent);
  const r2 = await M.findOne(item({ status: 'unconfirmed' }), settings, onEvent);
  check('precondition: plan not confirmed → not walked, no tab', r.reason === 'plan not confirmed — not walked' && r2.reason === r.reason && fake.created.length === 0);
}
{
  reset();
  fake.pageFor = (url) => new URL(url).hostname === 'login.microsoftonline.com'
    ? new Page({ url, text: 'Enter password', hasPassword: true, elements: [{ id: 1, text: 'Sign in' }] })
    : new Page({ url, text: 'redirecting', elements: [{ id: 1, text: 'x' }], neverComplete: true, readyState: 'interactive' });
  const it = item({ url: 'https://login.microsoftonline.com/common/oauth2/authorize', accountUrl: 'https://login.microsoftonline.com/common/oauth2/authorize' });
  const r = await M.findOne(it, settings, onEvent);
  check('sign-in wall on an IdP: blocked_needs_you with no model call', r.outcome === 'blocked_needs_you' && agentCalls.length === 0, `${r.outcome} ${agentCalls.length}`);
}

// ------------------------------------------------------------ 8. the per-site mutex
{
  reset();
  const active = new Map(); let maxSame = 0, maxAll = 0;
  fake.pageFor = (url) => new Page({ url, text: 'Your plan. '.repeat(20), elements: [{ id: 1, text: 'Help', tag: 'a' }] });
  agent = async (b) => { await sleep(400); return { state: 'other', reasoning: '', action: { type: 'back_out', reason: 'x' } }; };
  const items = [
    item({ id: 'cursor.sh', domain: 'cursor.sh', siteDomain: 'cursor.com', url: 'https://cursor.com/dashboard', accountUrl: 'https://cursor.sh/settings' }),
    item({ id: 'cursor.com', domain: 'cursor.com', siteDomain: 'cursor.com', url: 'https://cursor.com/dashboard', accountUrl: 'https://cursor.com/dashboard' }),
    item({ id: 'other.example', domain: 'other.example', siteDomain: 'other.example', url: 'https://other.example/account', accountUrl: 'https://other.example/account' }),
  ];
  const ev = (e) => {
    const k = e.item.siteDomain;
    if (e.type === 'start') { active.set(k, (active.get(k) || 0) + 1); maxSame = Math.max(maxSame, active.get(k)); maxAll = Math.max(maxAll, [...active.values()].reduce((a, b) => a + b, 0)); }
    if (e.type === 'found') active.set(k, active.get(k) - 1);
  };
  const res = await M.findAll(items, settings, ev, 3);
  check('mutex: two services on cursor.com never walk at once', maxSame === 1, `max same-site ${maxSame}`);
  check('mutex: other sites still run in parallel, nothing dropped', maxAll === 2 && res.size === 3, `max parallel ${maxAll}, results ${res.size}`);
}

// ------------------------------------------------------------ 9. round-2 review fixes (R0/R10, R1, R2, R6, R7, R9, R12)
/** Find on `site`, then hand back the item ready to accept, plus the paused tab's page. */
const findThenPause = async (site, o = {}) => {
  fake.pageFor = site; agent = walkToOffer;
  const it = item(o); const f = await M.findOne(it, o.settings || settings, onEvent);
  Object.assign(it, { paused: f.paused, path: f.path, offer: f.offer, hasOffer: true });
  agentCalls.length = 0; fake.clicks.length = 0; fake.exec.length = 0;
  return { it, f, page: f.paused ? fake.tabs.get(f.paused.tabId).page : null };
};
const offerPage = (text, label) => (url) => new Page({ url, text, elements: [{ id: 1, text: label, onClick: (tab) => navigate(tab, `${S}/cancel/kept`) }, { id: 2, text: 'Continue to cancel' }] });

// R0/R10: the in-place continuation carries the find path, so "Continue to cancel" under the paid offer is refused.
{
  reset();
  const { it, page } = await findThenPause(streamly());
  page.elements[0].onClick = null;   // the accept click shows nothing new (a modal that stays up)
  agent = async () => ({ state: 'other', reasoning: '', action: { type: 'click', id: 2 } });
  const r = await M.acceptOne(it, settings, onEvent);
  const h = agentCalls[0]?.history || [];
  check('R0 in-place accept: continuation history = find path (entry click) + the accept, no finish step',
    h.some((s) => s.target === 'Cancel membership' && s.action?.type === 'click') && h.at(-1)?.action?.type === 'accept_offer' && !h.some((s) => s.action?.type === 'finish'), JSON.stringify(h.map((s) => `${s.state}:${s.action?.type}`)));
  check('R0 in-place accept: "Continue to cancel" after the accept is refused, never clicked', r.phase === 'accept' && !fake.clicks.some((c) => /continue to cancel/i.test(c.text)) && r.outcome === 'no_offer_backed_out', `${r.phase} ${r.outcome} ${r.reason ?? ''}`);
  check('R6 in-place accept: the click carries expect = the live label', fake.exec.some((x) => x.which === 'performAction' && x.args[0]?.expect === 'Keep my discount'));
}
// R1: the paused handle carries a screen fingerprint (a hash, not page text).
{
  reset();
  const { f } = await findThenPause(streamly());
  check('R1 find: paused handle has a screen fingerprint that is not page text', typeof f.paused?.screen === 'string' && f.paused.screen.length > 4 && !/\s|offer|before/i.test(f.paused.screen), f.paused?.screen);
}
// R1: same URL, same "Continue" label, but the site moved on to its final confirmation: never pressed in place.
{
  reset();
  const { it, page } = await findThenPause(streamly({ '/cancel/offer': offerPage('Special offer: 50% off for 3 months if you stay.', 'Continue') }));
  let finalized = false;
  Object.assign(page, { text: 'Are you sure you want to cancel? This cannot be undone.', elements: [{ id: 1, text: 'Continue', onClick: () => { finalized = true; } }, { id: 2, text: 'Go back' }] });
  const r = await M.acceptOne(it, settings, onEvent);
  check('R1 confirm step on the same URL with the recorded label: not pressed, re-walked', !finalized && r.phase === 'rewalk' && r.outcome === 'discount_applied', `${r.phase} ${r.outcome} finalized=${finalized}`);
}
// R1: the fingerprint alone: still an offer, same URL, id and label, but a different screen.
{
  reset();
  const { it, page } = await findThenPause(streamly());
  let pressed = false;
  Object.assign(page, { text: 'Step 2 of 3: review your 50% off offer terms.', elements: [{ id: 1, text: 'Keep my discount', onClick: () => { pressed = true; } }] });
  const r = await M.acceptOne(it, settings, onEvent);
  check('R1 different screen (fingerprint) with the same button: not pressed in place, re-walked', !pressed && r.phase === 'rewalk', `${r.phase} pressed=${pressed}`);
}
// R1: a handle stored by an older version (no fingerprint) is never pressed in place.
{
  reset();
  const { it, page } = await findThenPause(streamly());
  let pressed = false; page.elements[0].onClick = () => { pressed = true; };
  delete it.paused.screen;
  const r = await M.acceptOne(it, settings, onEvent);
  check('R1 old handle without screen: re-walk, the paused button untouched', !pressed && r.phase === 'rewalk' && r.outcome === 'discount_applied', `${r.phase} ${r.outcome} pressed=${pressed}`);
}
// R1: the paused screen itself has confirm wording ("Last chance"): re-walk, where the model's accept is judged again.
{
  reset();
  const { it, page } = await findThenPause(streamly({ '/cancel/offer': offerPage('Last chance: 50% off for 3 months.', 'Keep my discount') }));
  let pressed = false; page.elements[0].onClick = () => { pressed = true; };
  const r = await M.acceptOne(it, settings, onEvent);
  check('R1 confirm wording on the paused screen: not pressed in place', !pressed && r.phase === 'rewalk', `${r.phase} pressed=${pressed}`);
}
// R1: the tab moved to another page of the same site that shows the same button.
{
  reset();
  let pressed = false;
  const { it, f } = await findThenPause(streamly({ '/cancel/other': (url) => new Page({ url, text: 'Before you go: 50% off for 3 months.', elements: [{ id: 1, text: 'Keep my discount', onClick: () => { pressed = true; } }] }) }));
  navigate(fake.tabs.get(f.paused.tabId), `${S}/cancel/other`); await sleep(200);
  const r = await M.acceptOne(it, settings, onEvent);
  check('R1 tab on another URL: not pressed in place, re-walked', !pressed && r.phase === 'rewalk', `${r.phase} pressed=${pressed}`);
}
// R1: a label that doesn't read like accepting ("Continue") is matched by id AND text only; no text-only fallback.
{
  reset();
  const { it, page } = await findThenPause(streamly({ '/cancel/offer': offerPage('Special offer: 50% off for 3 months if you stay.', 'Continue') }));
  let pressed = false;
  page.elements = [{ id: 1, text: 'Go back' }, { id: 2, text: 'Continue', onClick: () => { pressed = true; } }];
  const r = await M.acceptOne(it, settings, onEvent);
  check('R1 "Continue" now under another id: not pressed by text alone, re-walked', !pressed && r.phase === 'rewalk', `${r.phase} pressed=${pressed}`);
}
// R1: an accept-like label may still be found by its text when the numbering moved.
{
  reset();
  const { it, page } = await findThenPause(streamly({ '/cancel/offer': offerPage('Before you go: 50% off for 3 months.', 'Claim offer') }));
  page.elements = [{ id: 1, text: 'Help', tag: 'a' }, { id: 2, text: 'Claim offer', onClick: (tab) => navigate(tab, `${S}/cancel/kept`) }];
  const r = await M.acceptOne(it, settings, onEvent);
  check('R1 accept-like label under a new id: accepted in place by its text', r.phase === 'accept' && r.outcome === 'discount_applied' && fake.clicks[0]?.text === 'Claim offer', `${r.phase} ${r.outcome}`);
}

// R2: never open a host on your never-explore list (or a built-in sensitive one), by navigate or by a link click.
const blockSettings = { ...settings, extraBlock: 'payments.streamly.example' };
const opened = []; const trackOpens = (site) => (url, tab) => { opened.push(url); return site(url, tab); };
{
  reset(); opened.length = 0; fake.pageFor = trackOpens(streamly());
  agent = async (b) => b.step === 0 ? { state: 'account_home', reasoning: '', action: { type: 'navigate', url: 'https://payments.streamly.example/methods' } } : { state: 'other', reasoning: '', action: { type: 'back_out', reason: 'x' } };
  const r = await M.findOne(item(), blockSettings, onEvent);
  check('R2 navigate to a never-explore host on the same site: refused before opening', !opened.some((u) => /payments\./.test(u)) && r.outcome === 'no_offer_backed_out' && /never-explore/.test(r.reason || ''), `${r.outcome} ${r.reason}`);
}
{
  reset(); opened.length = 0;
  fake.pageFor = trackOpens(streamly({ '/account': (url) => new Page({ url, text: 'Your plan: Premium. $20.00/month.', elements: [
    { id: 1, tag: 'a', text: 'Payment settings', href: 'https://payments.streamly.example/methods', onClick: (tab) => navigate(tab, 'https://payments.streamly.example/methods') }] }) }));
  agent = async () => ({ state: 'account_home', reasoning: '', action: { type: 'click', id: 1 } });
  const r = await M.findOne(item(), blockSettings, onEvent);
  check('R2 click on a link into a never-explore host: refused, nothing clicked or opened', fake.clicks.length === 0 && !opened.some((u) => /payments\./.test(u)) && r.outcome === 'no_offer_backed_out' && /blocked or sensitive/.test(r.reason || ''), `${r.outcome} ${r.reason}`);
}
{
  reset(); opened.length = 0;
  const G = 'https://one.google.com', gItem = () => item({ id: 'google.com', domain: 'google.com', siteDomain: 'google.com', accountUrl: `${G}/settings`, url: `${G}/settings` });
  fake.pageFor = trackOpens((url) => new URL(url).hostname === 'one.google.com'
    ? new Page({ url, text: 'Google One Premium, $9.99/month. Manage your membership here.', elements: [{ id: 1, tag: 'a', text: 'Payment methods', href: 'https://wallet.google.com/', onClick: (tab) => navigate(tab, 'https://wallet.google.com/') }] })
    : new Page({ url, text: 'wallet' }));
  agent = async (b) => b.step === 0 ? { state: 'account_home', reasoning: '', action: { type: 'click', id: 1 } } : { state: 'other', reasoning: '', action: { type: 'back_out', reason: 'x' } };
  const r1 = await M.findOne(gItem(), settings, onEvent);
  agent = async (b) => b.step === 0 ? { state: 'account_home', reasoning: '', action: { type: 'navigate', url: 'https://wallet.google.com/' } } : { state: 'other', reasoning: '', action: { type: 'back_out', reason: 'x' } };
  const r2 = await M.findOne(gItem(), settings, onEvent);
  check('R2 built-in sensitive host on the same site (wallet.google.com): never opened by link or navigate', !opened.some((u) => /wallet\./.test(u)) && fake.clicks.length === 0 && r1.outcome === 'no_offer_backed_out' && r2.outcome === 'no_offer_backed_out', `${r1.reason} | ${r2.reason}`);
}

// R6: the label changes in place between the live read and the click: not pressed, read again.
{
  reset(); fake.pageFor = streamly();
  agent = async (b) => b.step === 0 ? { state: 'subscription_page', reasoning: '', action: { type: 'click', id: 1 } } : { state: 'other', reasoning: '', action: { type: 'back_out', reason: 'x' } };
  const orig = browser.scripting.executeScript;
  browser.scripting.executeScript = async (inj) => { const r = await orig(inj); if (inj.func === fake.fns.readElement) { const e = fake.tabs.get(inj.target.tabId).page.elements.find((x) => x.id === 1); if (e) e.liveText = 'Confirm cancellation'; } return r; };
  const r = await M.findOne(item(), settings, onEvent);
  browser.scripting.executeScript = orig;
  check('R6 label swapped after the live read: nothing clicked, the model is told the page changed', fake.clicks.length === 0 && /page changed since it was read/.test(agentCalls[1]?.history?.[0]?.note || '') && r.outcome === 'no_offer_backed_out', `${fake.clicks.length} ${r.outcome}`);
}
// R6: the same in the paused tab: the accept is not pressed in place; the re-walk decides.
{
  reset();
  const { it, f } = await findThenPause(streamly());
  const orig = browser.scripting.executeScript; let swapped = false;
  browser.scripting.executeScript = async (inj) => { const r = await orig(inj); if (!swapped && inj.func === fake.fns.readElement && inj.target.tabId === f.paused.tabId) { swapped = true; fake.tabs.get(inj.target.tabId).page.elements[0].liveText = 'Pause membership'; } return r; };
  const r = await M.acceptOne(it, settings, onEvent);
  browser.scripting.executeScript = orig;
  check('R6 accept label swapped at click time: not pressed in place, re-walked', swapped && r.phase === 'rewalk' && fake.clicks.filter((c) => c.text === 'Keep my discount').length === 1 && !fake.clicks.some((c) => /pause/i.test(c.text)), `${r.phase} ${r.outcome}`);
}

// R7: verification never reads or sends a never-explore or banking page; the result says unverified.
{
  reset();
  let visits = 0, snapped = false;
  const redirect = streamly({ '/account': (url) => {
    if (++visits === 1) return streamly()(url);
    const p = new Page({ url: 'https://billing-portal.example/acct', text: 'Your plan: Premium $10/month', elements: [{ id: 1, text: 'Done' }] });
    const s = p.snapshot.bind(p); p.snapshot = () => { snapped = true; return s(); }; return p;
  } });
  const s7 = { ...settings, extraBlock: 'billing-portal.example' };
  const { it } = await findThenPause(redirect, { settings: s7 });
  classifyCalls = 0;
  const r = await M.acceptOne(it, s7, onEvent);
  check('R7 verify redirected to a never-explore host: not read, not classified, unverified', !snapped && classifyCalls === 0 && r.after === null && r.outcome === 'error' && r.reason === 'could not verify a lower price on the billing page', `snapped=${snapped} ${classifyCalls} ${r.outcome} ${r.reason}`);
}
{
  reset();
  let visits = 0;
  const bank = streamly({ '/account': (url) => (++visits === 1 ? streamly()(url) : new Page({ url, text: 'Available balance $1,234.56. Routing number on file. Premium $10/month.', elements: [{ id: 1, text: 'Done' }] })) });
  const { it } = await findThenPause(bank);
  classifyCalls = 0;
  const r = await M.acceptOne(it, settings, onEvent);
  check('R7 verify page reads like banking: not classified, unverified', classifyCalls === 0 && r.after === null && r.outcome === 'error', `${classifyCalls} ${r.outcome} ${r.reason}`);
}

// R9: survey toggles are not reported as "no visible effect".
const survey = (el) => streamly({ '/account': (url) => { const p = new Page({ url, text: 'Why are you leaving? Tell us and we will help.', elements: [{ id: 1, text: 'Too expensive', checked: false, ...el }] }); p.elements[0].onClick = () => { p.elements[0].checked = true; }; return p; } });
const surveyAgent = async (b) => b.step === 0 ? { state: 'reason_survey', reasoning: '', action: { type: 'click', id: 1 } } : { state: 'other', reasoning: '', action: { type: 'back_out', reason: 'x' } };
for (const [name, el] of [['radio input', { type: 'radio', tag: 'input' }], ['label of a checkbox', { type: 'checkbox', tag: 'label' }], ['role=switch', { role: 'switch', tag: 'div' }], ['role=option', { role: 'option', tag: 'li' }]]) {
  reset(); fake.pageFor = survey(el); agent = surveyAgent;
  const t0 = Date.now(); await M.findOne(item(), settings, onEvent); const ms = Date.now() - t0;
  const note = agentCalls[1]?.history?.[0]?.note || '';
  check(`R9 ${name}: no "no visible effect" note, no 2.5s wait`, /clicked/.test(note) && !/no visible effect/.test(note) && ms < 3200, `${note} ${ms}ms`);
}
{
  reset(); fake.pageFor = survey({ tag: 'div' }); agent = surveyAgent;   // no type or role: caught by re-reading the element
  await M.findOne(item(), settings, onEvent);
  const note = agentCalls[1]?.history?.[0]?.note || '';
  check('R9 untyped element whose checked state changed: re-read, no "no visible effect" note', /clicked/.test(note) && !/no visible effect/.test(note), note);
}

// R12: the item's own account host is never dropped as an identity provider.
{
  reset(); fake.pageFor = (url) => new Page({ url, text: 'Your subscription: Premium, $15.99/month. Manage it here.', elements: [{ id: 1, text: 'Help', tag: 'a' }] });
  agent = async () => ({ state: 'other', reasoning: '', action: { type: 'back_out', reason: 'x' } });
  await M.findOne(item({ id: 'max.example', domain: 'max.example', siteDomain: 'hbomax.example', accountUrl: 'https://auth.hbomax.example/subscription', url: 'https://auth.hbomax.example/subscription' }), settings, onEvent);
  check('R12 landed on the account host auth.<site>: its site stays in the site set, walk starts there', !!agentCalls[0]?.merchant?.siteDomains?.includes('hbomax.example') && fake.created[0]?.url === 'https://auth.hbomax.example/subscription', `${agentCalls[0]?.merchant?.siteDomains} ${fake.created[0]?.url}`);
  reset();
  await M.findOne(item({ id: 'max.example', domain: 'max.example', siteDomain: 'hbomax.example', accountUrl: 'https://www.hbomax.example/account', url: 'https://accounts.hbomax.example/choose' }), settings, onEvent);
  check('R12 landed on an IdP host that is not the account host: still dropped', agentCalls[0]?.merchant?.siteDomains?.join(',') === 'max.example', `${agentCalls[0]?.merchant?.siteDomains}`);
}

const log = await M.traceEnd({});
const stepsWithSettle = log.events.filter((e) => e.kind === 'step' && e.settle);
check('trace: steps carry settle {kind, ms, navigated, loadTimedOut} and gen', stepsWithSettle.length > 0 && stepsWithSettle.every((e) => 'kind' in e.settle && 'navigated' in e.settle && 'loadTimedOut' in e.settle && typeof e.gen === 'string'));
check('trace: a no_effect settle was recorded', stepsWithSettle.some((e) => e.settle.kind === 'no_effect'));
check('trace: tab errors recorded by kind', log.events.some((e) => e.kind === 'step.tab_error' && e.errorKind === 'error_page') && log.events.some((e) => e.kind === 'step.tab_error' && e.errorKind === 'tab_gone'));
check('trace: no one-time token in any traced url', !JSON.stringify(log.events).includes('abc123def456abc123def456abc'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

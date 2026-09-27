// Runs the REAL probe/mapStatus/markDuplicates (runScan, read-only test mode) and discovery code
// against fake pages classified by the real mockClassify (+ guardPageClass). All names and emails are made up.
// Run through `npm run test:scan`, which bundles scan.ts and discovery.ts with the stubs in ./stubs first.
const { runScan, linkProblem } = await import('./.build/scan.mjs');
const { discoverCandidates } = await import('./.build/discovery.mjs');
const { mockClassify } = await import('../../../shared/brain-mock.js');

let pass = 0, fail = 0;
const check = (name, ok, got = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  — got ${typeof got === 'string' ? got : JSON.stringify(got)}`}`); };
const settings = { testMode: true, testFind: false, extraBlock: '', extraAllow: '', restrictedMode: false };
const cand = (domain, accountUrl, extra = {}) => ({ domain, name: domain, accountUrl, source: 'ai', typicalPrice: null, makesOffers: 'unknown', discountPct: 0.5, termMonths: 3, confidence: 0.9, aliases: [], altUrls: [], payLikelihood: 0.9, canonical: null, ...extra });
async function scan(cands, pages, overlay = null) {
  globalThis.__cands = cands; globalThis.__pages = pages; globalThis.__overlay = overlay; globalThis.__events = []; globalThis.__opened = []; globalThis.__api = null;
  const r = await runScan(settings, () => {});
  const probes = globalThis.__events.filter((e) => e.kind === 'probe');
  return { items: Object.fromEntries(r.items.map((i) => [i.domain, i])), probe: (d) => probes.find((p) => p.svc === d), opened: globalThis.__opened, events: globalThis.__events };
}
const menu = (email) => ({ emails: [{ value: email, source: 'account-menu' }], hints: [] });
const isError = (s) => { try { return /\/error$/.test(new URL(s.url).pathname); } catch { return false; } };

// ---------------------------------------------------------------------------------------------------------------
console.log('\nR26: Google One on a Workspace session lands on /error ("Sign in with your personal account")');
const g1 = {
  'https://one.google.com/settings': { final: 'https://one.google.com/error?g1_landing_page=0', snap: {
    title: 'Google One', headings: ['Sign in with your personal account', "You're currently signed in to your Google Workspace Account"],
    text: "Sign in with your personal account. You're currently signed in to your Google Workspace Account. Google One is for personal Google Accounts. Manage Google Workspace account. Switch account",
    elements: [{ id: 1, tag: 'a', text: 'Manage Google Workspace account', href: 'https://admin.google.com/' }, { id: 2, tag: 'button', text: 'Switch account' }], identity: menu('pat@corp-example.com') } },
  'https://one.google.com/': { final: 'https://one.google.com/about', snap: {
    title: 'Google One', headings: ['More storage, more benefits'], text: 'Get more storage with Google One. Subscription plans from $1.99/month. Get started',
    prices: [{ amount: 1.99, unit: 'month', context: 'plans from $1.99/month' }], elements: [{ id: 1, tag: 'a', text: 'Get started', href: '/plans' }], identity: menu('pat@corp-example.com') } },
  'https://google.com/': { final: 'https://www.google.com/', snap: { title: 'Google', text: "Google Search. I'm Feeling Lucky. Gmail. Images", elements: [{ id: 1, tag: 'a', text: 'Gmail', href: 'https://mail.google.com/' }], identity: menu('pat@corp-example.com') } },
};
// The real model's rule: a URL path ending in /error is not_found even when signed in.
const errorIsNotFound = (s, c) => (isError(s) ? { ...c, pageKind: 'not_found' } : null);
{
  const cls = mockClassify({ ...g1['https://one.google.com/settings'].snap, url: g1['https://one.google.com/settings'].final }, 'google.com');
  check('setup: the /error page reads as signed in, work_or_team', cls.signedIn === true && cls.accountType === 'work_or_team', cls);
  const r = await scan([cand('google.com', 'https://one.google.com/settings')], g1, errorIsNotFound);
  const i = r.items['google.com'], p = r.probe('google.com');
  check('Google One → work_account', i.status === 'work_account', `${i.status} · ${i.live}`);
  check('says: sign into your personal Google account', /personal Google account/.test(i.live), i.live);
  check('no hop away from the work-account page', p.hops.length === 0, p.hops);
  check('workReason traced', /workspace|work or team/i.test(p.workReason || ''), p.workReason);
  check('never walked', !(i.status === 'signed_in'), i.status);
  // The model missed accountType: the local orgAccountReason still catches it on the page itself.
  const r2 = await scan([cand('google.com', 'https://one.google.com/settings')], g1, (s, c) => ({ ...c, accountType: 'unknown', ...(isError(s) ? { pageKind: 'not_found' } : {}) }));
  check('model says accountType unknown → still work_account (orgAccountReason)', r2.items['google.com'].status === 'work_account' && r2.probe('google.com').hops.length === 0, r2.items['google.com'].status);
}

// ---------------------------------------------------------------------------------------------------------------
console.log('\nR3: team dashboard with a Billing link → the billing page shows a personal-looking paid plan');
const team = {
  'https://app.teamtool-example.com/dashboard': { snap: {
    title: 'Dashboard', headings: ['Team settings', 'Members & groups'], text: 'Team settings. Members & groups. Invite teammates to your workspace. Billing. Sign out',
    elements: [{ id: 1, tag: 'a', text: 'Team settings', href: 'https://app.teamtool-example.com/team' }, { id: 2, tag: 'button', text: 'Invite teammates' },
      { id: 3, tag: 'a', text: 'Billing', href: 'https://app.teamtool-example.com/settings/billing' }, { id: 4, tag: 'button', text: 'Sign out' }], identity: menu('you@example.com') } },
  'https://app.teamtool-example.com/settings/billing': { snap: {
    title: 'Billing', headings: ['Your plan'], text: 'Your plan: Pro $20.00/month. Next billing date: October 1, 2026. Cancel subscription. Sign out',
    prices: [{ amount: 20, unit: 'month', context: 'Pro $20.00/month' }], elements: [{ id: 1, tag: 'button', text: 'Cancel subscription' }, { id: 2, tag: 'button', text: 'Sign out' }], identity: menu('you@example.com') } },
};
{
  const A = mockClassify({ ...team['https://app.teamtool-example.com/dashboard'].snap, url: 'https://app.teamtool-example.com/dashboard' }, 'teamtool-example.com');
  const B = mockClassify({ ...team['https://app.teamtool-example.com/settings/billing'].snap, url: 'https://app.teamtool-example.com/settings/billing' }, 'teamtool-example.com');
  check('setup: dashboard is work_or_team with a details link (the hop the old code took)', A.accountType === 'work_or_team' && A.detailsLinkId === 3 && A.hasPaidPlan == null, A);
  check('setup: billing page alone reads as a personal paid plan', B.hasPaidPlan === true && B.accountType === 'unknown' && B.confidence >= 0.6, B);
  const r = await scan([cand('teamtool-example.com', 'https://app.teamtool-example.com/dashboard')], team);
  const i = r.items['teamtool-example.com'], p = r.probe('teamtool-example.com');
  check('team dashboard → work_account', i.status === 'work_account', `${i.status} · ${i.live}`);
  check('no details hop from a work-account page', p.hops.length === 0 && !r.opened.includes('https://app.teamtool-example.com/settings/billing'), p.hops);
  // Only the local signals: the classifier missed the team account on the dashboard.
  const r2 = await scan([cand('teamtool-example.com', 'https://app.teamtool-example.com/dashboard')], team, (s, c) => ({ ...c, accountType: 'unknown' }));
  check('classifier missed it → orgAccountReason still makes it work_account, no hop', r2.items['teamtool-example.com'].status === 'work_account' && r2.probe('teamtool-example.com').hops.length === 0, r2.items['teamtool-example.com'].status);
  // Work evidence on the SECOND page (after a hop) is kept too.
  const plain = { ...team, 'https://app.teamtool-example.com/dashboard': { snap: { title: 'Home', headings: ['Welcome back'], text: 'Welcome back. Billing. Sign out',
    elements: [{ id: 3, tag: 'a', text: 'Billing', href: 'https://app.teamtool-example.com/settings/billing' }, { id: 4, tag: 'button', text: 'Sign out' }], identity: menu('you@example.com') } } };
  const r3 = await scan([cand('teamtool-example.com', 'https://app.teamtool-example.com/dashboard')], plain, (s, c) => (/billing/.test(s.url) ? { ...c, billedVia: 'employer' } : null));
  check('employer billing seen on the hop\'s page → work_account', r3.items['teamtool-example.com'].status === 'work_account' && r3.probe('teamtool-example.com').hops.length === 1, `${r3.items['teamtool-example.com'].status} hops=${r3.probe('teamtool-example.com').hops.length}`);
}

// ---------------------------------------------------------------------------------------------------------------
console.log('\nR3: "billed through the App Store" on the account page, price only on the billing page');
const music = (appStore) => ({
  'https://www.musicapp-example.com/account': { snap: {
    title: 'Account', headings: ['Account overview'], text: `Account overview. ${appStore ? 'Your subscription is billed through the App Store. ' : ''}Billing. Sign out`,
    elements: [{ id: 3, tag: 'a', text: 'Billing', href: 'https://www.musicapp-example.com/account/billing' }, { id: 4, tag: 'button', text: 'Sign out' }], identity: menu('you@example.com') } },
  'https://www.musicapp-example.com/account/billing': { snap: {
    title: 'Billing', headings: ['Your plan'], text: 'Your plan: Premium $10.99/month. Next billing date: October 1, 2026. Sign out',
    prices: [{ amount: 10.99, unit: 'month', context: 'Premium $10.99/month' }], elements: [{ id: 2, tag: 'button', text: 'Sign out' }], identity: menu('you@example.com') } },
});
{
  const appStoreOverlay = (s, c) => (/App Store/.test(s.text) ? { ...c, billedVia: 'app_store', notes: 'Billed through the App Store' } : null);
  const r = await scan([cand('musicapp-example.com', 'https://www.musicapp-example.com/account')], music(true), appStoreOverlay);
  const i = r.items['musicapp-example.com'], p = r.probe('musicapp-example.com');
  check('App Store on page A + price on page B → billed_elsewhere', i.status === 'billed_elsewhere', `${i.status} · ${i.live}`);
  check('the details hop still ran (price read)', p.hops.length === 1 && i.monthlyPrice === 10.99, `hops=${p.hops.length} price=${i.monthlyPrice}`);
  check('says Apple, billedVia app_store', /Apple/.test(i.live) && i.billedVia === 'app_store', `${i.live} · ${i.billedVia}`);
  const r2 = await scan([cand('musicapp-example.com', 'https://www.musicapp-example.com/account')], music(false), appStoreOverlay);
  check('control: a personal plan still ends signed_in after the hop', r2.items['musicapp-example.com'].status === 'signed_in' && r2.probe('musicapp-example.com').hops.length === 1 && r2.items['musicapp-example.com'].monthlyPrice === 10.99, r2.items['musicapp-example.com'].status);
}

// ---------------------------------------------------------------------------------------------------------------
console.log('\nR26: a signed-in 404 then an apex marketing root that shows "Log in"');
{
  const news = {
    'https://www.newsdaily-example.com/account/subscription': { snap: { title: 'Page not found', headings: ['Page not found'], text: "We couldn't find that page. My account. Log out",
      elements: [{ id: 1, tag: 'button', text: 'Log out' }], identity: menu('you@example.com') } },
    'https://www.newsdaily-example.com/': { snap: { title: 'News Daily', headings: ['Unlimited news'], text: 'Subscription plans from $4.99/month. Log in',
      prices: [{ amount: 4.99, unit: 'month', context: 'from $4.99/month' }], elements: [{ id: 1, tag: 'a', text: 'Log in', href: 'https://www.newsdaily-example.com/login' }] } },
  };
  const r = await scan([cand('newsdaily-example.com', 'https://www.newsdaily-example.com/account/subscription')], news);
  const i = r.items['newsdaily-example.com'], p = r.probe('newsdaily-example.com');
  check('hopped to the root', p.hops.length === 1 && p.hops[0].why === 'not_found', p.hops);
  check('kept the signed-in 404 → wrong_page (Needs a look), not login_wall', i.status === 'wrong_page', `${i.status} · ${i.live}`);
}

// ---------------------------------------------------------------------------------------------------------------
console.log('\nR27 / R12: details links on the service\'s own accounts./auth. hosts, whole-word labels');
{
  const game = {
    'https://www.gamesite-example.com/account': { snap: { title: 'My account', headings: ['My account'], text: 'My account. Switch Online membership. Sign out',
      elements: [{ id: 5, tag: 'a', text: 'Switch Online membership', href: 'https://accounts.gamesite-example.com/membership' }, { id: 6, tag: 'button', text: 'Sign out' }], identity: menu('you@example.com') } },
    'https://accounts.gamesite-example.com/membership': { snap: { title: 'Membership', headings: ['Your membership'], text: 'Your membership: Individual $3.99/month. Renews on October 1, 2026. Sign out',
      prices: [{ amount: 3.99, unit: 'month', context: 'Individual $3.99/month' }], elements: [{ id: 1, tag: 'button', text: 'Sign out' }], identity: menu('you@example.com') } },
  };
  // mockClassify only points at same-host links; the model may point across subdomains, and the server guard allows it.
  const r = await scan([cand('gamesite-example.com', 'https://www.gamesite-example.com/account')], game, (s, c) => (/\/account$/.test(s.url) ? { ...c, detailsLinkId: 5 } : null));
  const i = r.items['gamesite-example.com'], p = r.probe('gamesite-example.com');
  check('"Switch Online membership" on accounts.<own site> is followed', p.hops.length === 1 && p.hops[0].why === 'details_link', { hops: p.hops, refused: p.linkRefused });
  check('… and the plan is read there', i.status === 'signed_in' && i.monthlyPrice === 3.99, `${i.status} ${i.monthlyPrice}`);

  const hub = {
    'https://auth.streamhub-example.com/account': { snap: { title: 'Account', headings: ['Account'], text: 'Account. Subscription. Sign out',
      elements: [{ id: 2, tag: 'a', text: 'Subscription', href: 'https://auth.streamhub-example.com/subscription' }, { id: 3, tag: 'button', text: 'Sign out' }], identity: menu('you@example.com') } },
    'https://auth.streamhub-example.com/subscription': { snap: { title: 'Subscription', headings: ['Your subscription'], text: 'Your subscription: Ad-free $16.99/month. Next billing date: October 1, 2026. Sign out',
      prices: [{ amount: 16.99, unit: 'month', context: 'Ad-free $16.99/month' }], elements: [{ id: 1, tag: 'button', text: 'Sign out' }], identity: menu('you@example.com') } },
  };
  const r2 = await scan([cand('streamhub-example.com', 'https://auth.streamhub-example.com/account')], hub);
  check('details link on the item\'s own auth.* account host is followed', r2.probe('streamhub-example.com').hops.length === 1 && r2.items['streamhub-example.com'].status === 'signed_in', r2.probe('streamhub-example.com'));

  // markDuplicates: two items whose own account page is on auth.<site> are one account.
  const r3 = await scan([cand('streamhub-example.com', 'https://auth.streamhub-example.com/subscription'), cand('shub-example.com', 'https://auth.streamhub-example.com/subscription', { confidence: 0.8 })], hub);
  const a = r3.items['streamhub-example.com'], b = r3.items['shub-example.com'];
  check('two readings on their own auth.* account host → one duplicate', [a.status, b.status].sort().join(',') === 'duplicate,signed_in', `${a.status}, ${b.status}`);
  check('scan.duplicates traced', r3.events.some((e) => e.kind === 'scan.duplicates' && e.merged.length === 1), '');
  // A shared IdP landing (not the item's own account host) is still never grouped.
  const idp = { 'https://www.acme-example.com/account': { final: 'https://login.microsoftonline.com/common/account', snap: hub['https://auth.streamhub-example.com/subscription'].snap },
    'https://www.other-example.com/account': { final: 'https://login.microsoftonline.com/common/account', snap: hub['https://auth.streamhub-example.com/subscription'].snap } };
  const r4 = await scan([cand('acme-example.com', 'https://www.acme-example.com/account'), cand('other-example.com', 'https://www.other-example.com/account')], idp);
  check('landing on a shared IdP host is not grouped as duplicates', !Object.values(r4.items).some((x) => x.status === 'duplicate'), Object.values(r4.items).map((x) => x.status));
}

console.log('\nR27: linkProblem table');
{
  const L = (label, href, sites, accountHost = '') => linkProblem(label, new URL(href), sites, accountHost);
  const ok = [
    ['Nintendo Switch Online', 'https://accounts.gamesite-example.com/shop', ['gamesite-example.com']],
    ['Subscriber Services', 'https://www.newsdaily-example.com/subscriber-center', ['newsdaily-example.com']],
    ['Subscriber Center', 'https://www.newsdaily-example.com/subscriber-center/', ['newsdaily-example.com']],
    ['Joined plans', 'https://www.x-example.com/plans', ['x-example.com']],
    ['My Best Buy Memberships', 'https://www.shop-example.com/memberships', ['shop-example.com']],
    ['Manage subscription', 'https://accounts.firefox-example.com/subscriptions', ['firefox-example.com']],
    ['Plan', 'https://id.tool-example.com/billing', ['tool-example.com']],
    ['Membership', 'https://auth.streamhub-example.com/subscription', ['streamhub-example.com'], 'auth.streamhub-example.com'],
    ['Your subscriptions', 'https://account.apple.com/account/manage', ['apple.com'], 'account.apple.com'],
    ['Billing', 'https://www.x-example.com/account/billing?tab=history', ['x-example.com']],
    ['Leaves of absence policy', 'https://www.x-example.com/help', ['x-example.com']],
  ];
  for (const [label, href, sites, ah] of ok) { const why = L(label, href, sites, ah); check(`open: "${label}" ${href}`, why === null, why); }
  const bad = [
    ['Sign out', 'https://www.x-example.com/account', ['x-example.com'], 'action label'],
    ['Log off', 'https://www.x-example.com/account', ['x-example.com'], 'action label'],
    ['Logout', 'https://www.x-example.com/account', ['x-example.com'], 'action label'],
    ['Cancel subscription', 'https://www.x-example.com/account', ['x-example.com'], 'action label'],
    ['Cancellation', 'https://www.x-example.com/account', ['x-example.com'], 'action label'],
    ['Upgrade to Pro', 'https://www.x-example.com/plans', ['x-example.com'], 'action label'],
    ['Switch to annual', 'https://www.x-example.com/plans', ['x-example.com'], 'action label'],
    ['Buy now', 'https://www.x-example.com/plans', ['x-example.com'], 'action label'],
    ['Subscribe', 'https://www.x-example.com/plans', ['x-example.com'], 'action label'],
    ['Start your free trial', 'https://www.x-example.com/plans', ['x-example.com'], 'action label'],
    ['Pause membership', 'https://www.x-example.com/plans', ['x-example.com'], 'action label'],
    ['Account', 'https://www.x-example.com/account/logout', ['x-example.com'], 'action path'],
    ['Account', 'https://www.x-example.com/sign-out', ['x-example.com'], 'action path'],
    ['Membership', 'https://www.x-example.com/membership/cancel-membership', ['x-example.com'], 'action path'],
    ['Membership', 'https://www.x-example.com/membership/cancellation/', ['x-example.com'], 'action path'],
    ['Plan', 'https://www.x-example.com/checkout', ['x-example.com'], 'action path'],
    ['Plan', 'https://www.x-example.com/index.php?do=logout', ['x-example.com'], 'action path'],
    ['Billing', 'https://www.y-example.com/billing', ['x-example.com'], 'other site'],
    ['Account', 'https://accounts.google.com/b/0/settings', ['google.com'], 'shared sign-in host', 'one.google.com'],
    ['Apple ID', 'https://appleid.apple.com/account', ['apple.com'], 'shared sign-in host', 'account.apple.com'],
    ['Profile', 'https://login.live.com/profile', ['live.com'], 'shared sign-in host', 'account.microsoft.com'],
    ['Billing', 'javascript:void(0)', ['x-example.com'], 'not a web link'],
  ];
  for (const [label, href, sites, want, ah] of bad) { const why = L(label, href, sites, ah || ''); check(`refuse (${want}): "${label}" ${href}`, why === want, why); }
}

// ---------------------------------------------------------------------------------------------------------------
console.log('\nR21: discovery withholds the Never-explore list before anything is sent to the model');
{
  const ck = (domain, name) => ({ domain, name, httpOnly: true, hostOnly: false, sameSite: 'lax' });
  globalThis.__cookies = [ck('.netflix.com', 'NetflixId'), ck('.mytherapist-example.com', 'sessionid'), ck('.chase.com', 'session'), ck('.newsdaily-example.com', 'sessionid'),
    ck('portal.intranet-corp-example.com', 'auth_token'), ck('.someapp.pages.dev', 'session'), ck('.x.netlify.app', 'session')];
  const sent = [];
  globalThis.__events = [];
  globalThis.__api = async (path, body) => { sent.push(...body.domains); return { services: body.domains.map((d) => ({ domain: d, isSubscription: false, category: 'news' })) }; };
  const out = await discoverCandidates({ ...settings, extraBlock: 'mytherapist-example.com\nintranet-corp-example.com' }, () => {});
  check('only unlisted, non-sensitive, non-catalog names reach the model', JSON.stringify(sent) === JSON.stringify(['newsdaily-example.com']), sent);
  const wh = globalThis.__events.find((e) => e.kind === 'discover.withheld');
  const why = Object.fromEntries((wh?.sites || []).map((s) => [s.d, s.why]));
  check('never-explore domains traced in discover.withheld', why['mytherapist-example.com'] === 'on your never-explore list' && why['intranet-corp-example.com'] === 'on your never-explore list', why);
  check('sensitive domain still withheld with its own reason', !!why['chase.com'] && why['chase.com'] !== 'on your never-explore list', why);
  check('one discover.withheld event', globalThis.__events.filter((e) => e.kind === 'discover.withheld').length === 1, '');
  check('domainsChecked counts only unblocked domains (netflix + newsdaily)', out.domainsChecked === 2, out.domainsChecked);
  check('netflix still a catalog candidate', out.candidates.some((c) => c.domain === 'netflix.com' && c.source === 'catalog'), out.candidates.map((c) => c.domain));
  const cookies = globalThis.__events.find((e) => e.kind === 'discover.cookies');
  check('hosted apps (x.pages.dev, x.netlify.app) dropped as infra, not sent', cookies.infraSites >= 2 && !sent.some((d) => /pages\.dev|netlify\.app/.test(d)), cookies);
  check('counts split: 1 sensitive, 2 never-explore', cookies.withheldSensitive === 1 && cookies.withheldNeverExplore === 2, cookies);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

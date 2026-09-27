// Read a Walkaway test-mode log and print a report: what the owner saw, what happened, how long it took, what it
// cost, and a list of FLAGS worth a closer look (wrong account pages, duplicates, walks that would go wrong, leaked
// secrets...). Works on old logs and new ones: every field added since the first live run is optional here.
// Never prints a full email or a token: free text goes through redactForLog, URLs are cut to host+path.
//
//   npm run review-log -- ~/Downloads/walkaway-test-log-2026-09-26T18-02-11.json
//   npm run review-log -- <log> --svc=hulu.com         full step-by-step trace for one service
//   npm run review-log -- <log> --svc=hulu.com --text  ...including the page text at each step
import fs from 'node:fs';
import { etld1, hostMatches } from '../shared/domains.js';
import { isIdpHost, isLoginUrl, isConsumerEmail } from '../shared/accounts.js';
import { canonicalKey } from '../shared/services.js';
import { secretKinds, scrubPii, scrubUrl, maskEmail, redactForLog } from '../shared/scrub.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
if (!file) { console.error('usage: npm run review-log -- <walkaway-test-log.json> [--svc=domain] [--text]'); process.exit(1); }
const log = JSON.parse(fs.readFileSync(file, 'utf8'));
if (log.format !== 'walkaway-test-log') { console.error('not a Walkaway test log'); process.exit(1); }
const E = log.events;
const of = (k) => E.filter((e) => e.kind === k);
const one = (k) => E.find((e) => e.kind === k);
const s = (ms) => (ms == null ? '–' : (ms / 1000).toFixed(1) + 's');
const $ = (n) => (n == null ? '–' : '$' + Number(n).toFixed(2));
const pad = (x, n) => String(x ?? '–').slice(0, n).padEnd(n);
const pct = (xs, p) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)] : null; };
const list = (xs, n = 12) => (xs.length > n ? xs.slice(0, n).join(', ') + ` +${xs.length - n} more` : xs.join(', '));
const countBy = (xs) => xs.reduce((o, x) => { o[x] = (o[x] || 0) + 1; return o; }, {});
const flags = [];
const flag = (sev, what, detail) => flags.push({ sev, what, detail });

// ---------------------------------------------------------------- privacy-safe printing
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const pathOf = (u) => { try { return new URL(u).pathname; } catch { return ''; } };
/** host+path, no query or fragment, ≤ n chars: OAuth URLs run to ~1000 chars and carry state and codes. */
const short = (u, n = 60) => { if (!u) return '–'; let t; try { const x = new URL(scrubUrl(u)); t = x.host + (x.pathname === '/' ? '' : x.pathname); } catch { t = safe(u); } return t.length > n ? t.slice(0, n - 1) + '…' : t; };
/** Any free text from the log (notes, titles, page text): tokens, long numbers, card data removed, emails masked. */
const safe = (x, n) => { const t = redactForLog(String(x ?? '')).replace(/\s+/g, ' ').trim(); return n && t.length > n ? t.slice(0, n - 1) + '…' : t; };
const EMAIL_RE = /[A-Z0-9._%+-]+(?:@|%40)[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,24}/gi;   // a masked one (ja***@…) never matches
const IMAGE_RE = /\.(png|jpe?g|gif|svg|webp|avif|ico)$/i;
const mask = (e) => (!e ? null : String(e).includes('*') ? String(e) : maskEmail(String(e)));   // new logs are masked already
const mailDomain = (e) => String(e || '').split('@')[1]?.toLowerCase() || '';

// ---------------------------------------------------------------- statuses (keep in sync with extension/src/scan.ts)
const PAYING = ['signed_in', 'billed_elsewhere'], NEEDS_LOOK = ['unconfirmed', 'wrong_page', 'not_loaded', 'needs_you', 'error'];
const isFound = (st) => PAYING.includes(st) || st === 'unknown';   // old logs counted 'unknown' as found
const RANK = ['signed_in', 'billed_elsewhere', 'unknown', 'unconfirmed', 'no_paid_plan', 'work_account', 'needs_you', 'wrong_page', 'not_loaded', 'login_wall', 'duplicate', 'error', 'sensitive'];
const rank = (st) => (RANK.indexOf(st) + 1 || 99);

// ---------------------------------------------------------------- what kind of page a probe landed on
// The report's own opinion, from title/headings/URL first and the model's notes last, so it can be compared with
// the classifier's pageKind (new logs) and the status the extension gave. Never from page text (K1 pollutes it).
const WRONG_RE = /\b404\b|not found|could ?n.t be found|can.t be found|doesn.t exist|does not exist|no longer (exists|available)|uh-?oh|\blost\?|get lost|glitch|something went wrong|^error$|^oops|não encontrada|no encontrada|introuvable|nicht gefunden/i;
const WRONG_NOTES_RE = /\b404\b|not found|error page|doesn.t exist|does not exist/i;
const SIGNIN_RE = /\b(sign|log) ?in\b|welcome back|enter (your )?password|verify (it.s|that it.s) you|verification code|two-step|2-step|forgot (your )?password/i;
const LOADING_RE = /^(loading|one moment|please wait|just a moment)|\brobot\b|captcha|are you (a )?human|enable javascript|checking your browser|access denied|attention required|press (and|&) hold/i;
const MARKETING_RE = /landing|marketing|pricing|home ?page|public page|sign-?up page/i;
const KIND_WHY = { not_found: 'wrong URL', error: 'wrong URL', login: 'sign-in form', reauth: 'sign-in form', loading: 'loading/blocked', bot_challenge: 'loading/blocked', marketing: 'marketing', account_billing: 'account page', account_other: 'account page' };
const arr = (x) => (Array.isArray(x) ? x : []);   // headings/buttons are counts when page text was off
const kindOf = (p) => p.pageKind ?? p.classify?.pageKind ?? null;
/** The landing is a sign-in page: an identity provider, a login URL, or a hosted customer login (Shopify). A service's
 *  own account host is not an IdP here, even when it looks like one (auth.hbomax.com, account.apple.com). */
const signInAt = (p) => { const u = p.finalUrl || '', h = hostOf(u); return !!h && ((isIdpHost(h) && h !== hostOf(p.accountUrl)) || isLoginUrl(u) || /\/(authentication|account\/login|customer\/login)(\/|$)/i.test(pathOf(u))); };
/** Off the service: not on the cookie domain, and not on the account URL's own registrable domain. */
const offService = (p) => { const h = hostOf(p.finalUrl); return !!h && !hostMatches(h, [etld1(p.svc), etld1(hostOf(p.accountUrl))].filter(Boolean)); };
function pageWhy(p) {
  if (p.status === 'sensitive') return 'sensitive';
  if (!p.page) return 'not read';
  const pg = p.page, heads = [pg.title, ...arr(pg.headings)].filter(Boolean), btns = arr(pg.buttons).map((b) => String(b).replace(/^\[\d+\]\s*/, ''));
  const notes = p.classify?.notes || '';
  if (heads.some((h) => WRONG_RE.test(h)) || /\/(error|404|not-?found)(\/|\.|$)/i.test(pathOf(p.finalUrl)) || WRONG_NOTES_RE.test(notes)) return 'wrong URL';
  const fewButtonsOneSignIn = btns.length > 0 && btns.length <= 8 && btns.some((b) => SIGNIN_RE.test(b)) && !btns.some((b) => /sign ?out|log ?out/i.test(b));
  if (pg.hasPassword || heads.some((h) => SIGNIN_RE.test(h)) || signInAt(p) || fewButtonsOneSignIn) return 'sign-in form';
  // 'timeout' also means content that never held still (a carousel, a ticker), read normally: blocked only when sparse.
  const sparseTimeout = p.ready?.kind === 'timeout' && (p.ready.visibleTextLen ?? 0) < 120 && !p.ready.interactiveCount;
  if (pg.elements === 0 || heads.some((h) => LOADING_RE.test(h)) || ['loading', 'challenge', 'empty', 'error_page'].includes(p.ready?.kind) || sparseTimeout) return 'loading/blocked';
  if (MARKETING_RE.test(notes)) return 'marketing';
  return 'account page';
}

// ---------------------------------------------------------------- script or JSON in page text (K1)
const CODE_RE = /function\s*\(|=>|\bwindow\.|\bdocument\.|\bvar |\bconst |\bif \(|\);|\{"[\w$]+"\s*:|"[\w$]+":\s*[\[{"\dtfn]|<iframe|<script|CDATA|requestAnimationFrame|performance\.mark/g;
/** Code tokens per 1000 chars over the whole logged text. Visible text of real pages scores 0; JS/JSON scores 2–40. */
function codeScore(pg) {
  if (!pg) return null;
  const t = typeof pg.text === 'string' ? pg.text : '', n = t ? (t.match(CODE_RE) || []).length : 0, per1k = t ? (n * 1000) / t.length : 0;
  // With page text off, only the shape is left: a huge text behind a handful of elements is mostly not UI.
  const suspect = !t && (pg.textLength || 0) > 50000 && (pg.textLength || 0) / Math.max(1, pg.elements || 0) > 5000;
  return { hits: n, per1k: +per1k.toFixed(1), code: n >= 3 && per1k >= 1, suspect };
}

// ---------------------------------------------------------------- one service in full
if (opt.svc) {
  const d = String(opt.svc);
  const mine = E.filter((e) => e.svc === d || e.svc?.endsWith?.(d));
  if (!mine.length) { console.error(`no events for ${d}`); process.exit(1); }
  console.log(`\n=== ${d}: ${mine.length} events ===\n`);
  const vd = one('discover.verdicts');
  const v = vd?.subscription?.find((x) => x.domain === d), ns = (vd?.not_subscription || []).find((x) => (x?.d ?? x) === d);
  if (v) console.log(`discovery: subscription · ${safe(v.name)} · ${v.category ?? '–'} · conf ${v.confidence ?? '–'} · offers ${v.offers ?? '–'} · account ${short(v.accountUrl)}${v.notes ? `\n           notes: ${safe(v.notes, 200)}` : ''}`);
  else if (ns) console.log(`discovery: not a subscription${ns.c ? ` (${ns.c})` : ''}`);
  const textOut = (pg) => { if (!opt.text || !pg?.text) return; const cs = codeScore(pg); if (cs?.code) console.log(`         ⚠ this text is mostly script/JSON (${cs.hits} code tokens, ${cs.per1k}/1k chars): K1`); console.log(`         text: ${safe(pg.text, 1500)}`); };
  for (const e of mine) {
    if (e.kind === 'step') {
      const a = e.action || {};
      console.log(`+${s(e.dt)}  step ${e.step} [${e.state}]  ${e.proposed?.type ?? '?'}${e.proposed?.id != null ? ' #' + e.proposed.id : ''} → ${a.type}${a.id != null ? ' #' + a.id : ''}${a.target ? ` "${safe(a.target, 60)}"` : ''}${a.outcome ? ' :' + a.outcome : ''}${e.gen ? `  gen ${e.gen}` : ''}`);
      console.log(`         url ${short(e.url, 90)}${e.offSite ? '  ⚠ OFF SITE' : ''}`);
      if (e.reasoning) console.log(`         why: ${safe(e.reasoning, 400)}`);
      if (e.guardrails?.length) console.log(`         guardrails: ${safe(e.guardrails.join(' | '), 400)}`);
      if (e.offer) console.log(`         offer: ${safe(JSON.stringify(e.offer), 300)}`);
      if (e.clickRefused) console.log(`         ⛔ click refused at click time, live text: "${safe(e.liveText, 80)}"`);
      if (e.ok === false) console.log(`         ⚠ action failed: ${safe(e.note, 200)}${e.errorKind ? ` (${e.errorKind})` : ''}`);
      console.log(`         timing: snapshot ${s(e.snapMs)} · brain ${s(e.brainMs)}${e.actMs != null ? ` · act ${s(e.actMs)}` : ''}${e.settle ? ` · settle ${e.settle.kind ? e.settle.kind + ' ' : ''}${s(e.settle.ms)}${e.settle.navigated ? ' (navigated)' : ''}${e.settle.loadTimedOut ? ' ⚠ LOAD TIMEOUT' : ''}` : ''}`);
      if (Array.isArray(e.page?.buttons)) console.log(`         buttons: ${safe(e.page.buttons.slice(0, 12).join(' · '), 600)}`);
      textOut(e.page);
    } else if (e.kind === 'api') {
      console.log(`+${s(e.dt)}  api ${e.path}${e.goal ? ' ' + e.goal : ''}${e.step != null ? ' step ' + e.step : ''} ${e.ok ? 'ok' : '⚠ ' + safe(e.error, 200)}${e.timedOut ? ' (timed out)' : ''} · ${s(e.ms)} (server ${s(e.serverMs)}, network ${s(e.networkMs)})${e.usage ? ` · ${e.usage.inputTokens}+${e.usage.outputTokens}+${e.usage.thinkingTokens} tok` : ''}`);
    } else if (e.kind === 'flow.page') {
      console.log(`+${s(e.dt)}  recorded ${e.phase} ${e.phase === 'probe' ? `page (hop ${e.hop ?? 0}${e.reread ? ', re-read' : ''})` : `step ${e.step}`} · ${e.snapshot?.elements?.length ?? 0} elements, ${e.snapshot?.textLength ?? 0} chars`);
    } else if (e.kind === 'probe') {
      const pg = e.page || {}, c = e.classify || {};
      console.log(`+${s(e.dt)}  probe: status ${e.status} · why ${pageWhy(e)}${kindOf(e) ? ` · pageKind ${kindOf(e)}` : ''} · load ${s(e.loadMs)}${e.loadTimedOut ? ' ⚠ TIMEOUT' : ''} · classify ${s(e.classifyMs)}`);
      console.log(`         ${short(e.accountUrl, 80)} → ${short(e.finalUrl, 80)}${offService(e) ? (signInAt(e) ? '  (sent to sign-in)' : '  ⚠ moved off the service') : ''}`);
      for (const h of e.hops || []) console.log(`         hop (${safe(h.why, 60)}): ${short(h.from, 60)} → ${short(h.to, 60)}`);
      if (e.ready) console.log(`         ready: ${e.ready.kind} in ${s(e.ready.ms)} · ${e.ready.visibleTextLen ?? '–'} chars · ${e.ready.interactiveCount ?? '–'} controls${e.loads != null ? ` · ${JSON.stringify(e.loads)} loads` : ''}`);
      console.log(`         page: "${safe(pg.title, 80)}" · ${pg.elements ?? '–'} elements · ${pg.textLength ?? '–'} chars · password field ${pg.hasPassword ? 'YES' : 'no'}${pg.frames?.length ? ` · ${pg.frames.length} frames` : ''}${pg.regions ? ` · regions ${JSON.stringify(pg.regions)}` : ''}`);
      if (pg.headings != null) console.log(`         headings: ${Array.isArray(pg.headings) ? safe(pg.headings.join(' | '), 300) || '–' : pg.headings + ' (count only: page text was off)'}`);
      if (pg.buttons != null) console.log(`         buttons: ${Array.isArray(pg.buttons) ? safe(pg.buttons.slice(0, 20).join(' · '), 800) || '–' : pg.buttons + ' (count only: page text was off)'}`);
      if (pg.prices?.length) console.log(`         prices: ${safe(pg.prices.join(' · '), 200)}`);
      if (pg.identity) console.log(`         identity: ${(pg.identity.emails || []).map(mask).join(', ') || 'no email'} · from ${(pg.identity.hintSources || []).join(', ') || '–'}`);
      const who = [e.email && `email ${mask(e.email)}`, e.rememberedEmail && `remembered ${mask(e.rememberedEmail)}`, e.accountName && `name ${safe(e.accountName, 40)}`, e.workReason && `work: ${safe(e.workReason, 100)}`].filter(Boolean);
      if (who.length) console.log(`         ${who.join(' · ')}`);
      if (e.error) console.log(`         ⚠ error: ${safe(e.error, 300)}`);
      const { notes, ...rest } = c;
      if (e.classify) console.log(`         classify: ${safe(JSON.stringify({ ...rest, accountEmail: mask(c.accountEmail) }), 1200)}\n         notes: ${safe(notes, 400)}`);
      textOut(pg);
    } else {
      const { t, dt, kind, svc, ...rest } = e;
      console.log(`+${s(dt)}  ${kind}: ${safe(JSON.stringify(rest), 400)}`);
    }
  }
  process.exit(0);
}

const probes = of('probe');
const probeOf = new Map(probes.map((p) => [p.svc, p]));
const pagesPhase = of('phase').find((p) => p.phase === 'pages') || {};
const sum = log.summary || one('run.end')?.summary;
// Signed in as someone other than the owner (new logs): on the pages phase and on the summary rows, not on probes.
const otherAccounts = new Set([...(pagesPhase.otherAccounts || []), ...(sum?.services || []).filter((r) => r.otherAccount).map((r) => r.domain)]);
const texty = probes.map((p) => ({ p, cs: codeScore(p.page) })).filter((x) => x.cs);
const k1 = texty.filter((x) => x.cs.code), k1suspect = texty.filter((x) => x.cs.suspect);

// ---------------------------------------------------------------- header
const m = log.meta || {};
const st = m.settings || {};
const readOnly = !!st.testMode && !st.testFind;
const dur = (log.endedAt || E[E.length - 1]?.t) - log.startedAt;
console.log(`\nWALKAWAY TEST LOG  ${m.startedAtLocal || new Date(log.startedAt).toString()}`);
console.log(`extension ${m.extensionVersion} · API ${st.apiBase} · ${st.restrictedMode ? 'RESTRICTED' : 'all signed-in sites'} · ${st.testFind ? 'walks cancellation flows' : 'read-only'} · page text ${st.testPageText ? 'on' : 'off'}`);
if (m.network) console.log(`network: ${m.network.effectiveType}, ~${m.network.downlinkMbps} Mbps, rtt ~${m.network.rttMs}ms`);
console.log(`duration ${s(dur)} · ${E.length} events${log.endedAt ? '' : ' · ⚠ LOG NEVER FINISHED (panel closed or crash?)'}`);
console.log(`K1 (script/JSON in page text): ${k1.length} of ${texty.filter((x) => x.p.page?.text).length} pages with text${k1suspect.length ? ` · ${k1suspect.length} more suspect (no text logged)` : ''}`);
{ // Pages recorded for replay tests ("Record each page for replay tests").
  const rec = E.filter((e) => e.kind === 'flow.page');
  if (rec.length) {
    const walks = rec.filter((e) => e.phase !== 'probe'), svcs = new Set(walks.map((e) => e.svc));
    console.log(`recorded for replay: ${rec.length - walks.length} account page(s), ${walks.length} walk step(s) across ${svcs.size} flow(s) → npm run flows -- ${file}`);
  } else if (st.testRecord === false) console.log('recorded for replay: off');
}
if (!log.endedAt) flag('high', 'run never finished', 'the log has no run.end: the panel was closed mid-scan or something threw without being caught');
const err = one('run.error');
if (err) flag('high', 'scan threw', safe(err.error, 300));

// ---------------------------------------------------------------- what the owner saw (the reveal screen)
/** Why a row is listed without an offer. Keep in sync with keptLabel() in extension/src/format.ts. */
const STATUS_LABEL = {
  login_wall: 'Signed out', no_paid_plan: 'Free plan', wrong_page: "Couldn't find the account page", not_loaded: "Page didn't load",
  needs_you: 'Needs you', work_account: 'Work account', billed_elsewhere: 'Billed elsewhere', unconfirmed: 'Plan not shown',
  error: "Couldn't check", sensitive: 'Skipped · sensitive', duplicate: 'Same account', checking: 'Checking…',
};
function keptLabel(i) {
  if (i.status !== 'signed_in') return STATUS_LABEL[i.status] || 'Not checked';
  if (i.offerApplied) return 'Promo active · kept';
  if (i.findOutcome === 'no_offer_backed_out') return 'No offer this time · left alone';
  if (i.findOutcome === 'blocked_needs_you') return 'Needs you to sign in';
  if (i.findOutcome === 'not_walked') return 'Not walked · read-only';
  if (i.findOutcome == null) return 'Not checked';
  return "Couldn't check · left alone";
}
const per = (c) => (c === 'year' ? 'yr' : c === 'week' ? 'wk' : 'mo');
/** planName · price/cadence · renews <date> · email, each only when present (the Paying row's sub-line). */
const subLine = (r) => [r.planName && safe(r.planName, 30), r.isTrial ? `trial${r.priceAfterTrial != null ? ' → ' + $(r.priceAfterTrial) + '/' + per(r.cadence) : ''}` : (r.cycleCharge ?? r.monthlyPrice) != null ? `${$(r.cycleCharge ?? r.monthlyPrice)}/${per(r.cadence)}` : null, r.renewalDate && `renews ${r.renewalDate}`, mask(r.email)].filter(Boolean).join(' · ');
if (sum?.services) {
  const rows = sum.services;
  const hasOffer = (r) => r.hasOffer ?? !!r.deal;   // summary rows carry a deal line only when an offer was held
  const found = rows.filter((r) => isFound(r.status)), offers = found.filter(hasOffer);
  const paying = found.filter((r) => !hasOffer(r)).sort((a, b) => (b.monthlyPrice ?? -1) - (a.monthlyPrice ?? -1));
  const dups = rows.filter((r) => r.status === 'duplicate');
  const also = (r) => { const xs = dups.filter((d) => d.dupOf === r.domain || d.dupOf === r.id).map((d) => d.domain); return xs.length ? ` (also: ${xs.join(', ')})` : ''; };
  console.log('\nOWNER VIEW (the reveal screen, rebuilt from the run summary)');
  const skippedFind = of('phase').some((p) => p.phase === 'find' && p.skipped);
  console.log(`  ${found.length} subscription${found.length === 1 ? '' : 's'} found · ${skippedFind || readOnly ? 'offers not checked (read-only test)' : `${offers.length} made an offer`}${sum.totalEstSavings ? ` · ~$${sum.totalEstSavings} to save` : ''}`);
  for (const r of offers) console.log(`  ☑ ${pad(safe(r.name), 26)} ~${$(r.estSavings)}  ${safe(r.deal, 70)}${r.email ? ` · ${mask(r.email)}` : ''}${r.otherAccount ? ' · [other account]' : ''}${also(r)}`);
  if (paying.length) console.log('  Paying');
  for (const r of paying) console.log(`    ${pad(safe(r.name), 26)} [${keptLabel(r)}]  ${subLine(r)}${r.otherAccount ? ' · [other account]' : ''}${also(r)}`);
  const look = rows.filter((r) => NEEDS_LOOK.includes(r.status));
  if (look.length) console.log(`  Needs a look (${look.length})`);
  for (const r of look) console.log(`    ${pad(safe(r.name), 26)} [${keptLabel(r)}]  ${safe(r.note, 70)}`);
  for (const [title, sts] of [['Work accounts', ['work_account']], ['Free plans', ['no_paid_plan']], ['Signed out — sign in, then rescan', ['login_wall']], ['Skipped (sensitive)', ['sensitive']]]) {
    const xs = rows.filter((r) => sts.includes(r.status));
    if (xs.length) console.log(`  ▸ ${title} (${xs.length}): ${list(xs.map((r) => safe(r.name)), 10)}`);
  }
  const GROUPED = ['work_account', 'no_paid_plan', 'login_wall', 'sensitive'];
  const hidden = rows.filter((r) => !isFound(r.status) && !NEEDS_LOOK.includes(r.status) && !GROUPED.includes(r.status));
  const by = sum.byStatus || countBy(rows.map((r) => r.status)), fmt = (ks) => Object.entries(by).filter(([k]) => ks(k)).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing';
  console.log(`  collapsed: ${fmt((k) => GROUPED.includes(k))} · hidden: ${hidden.length ? fmt((k) => hidden.some((r) => r.status === k)) : 'nothing'}`);
  if (sum.found != null && sum.found !== found.length) flag('high', `owner view: the summary says ${sum.found} found but ${found.length} rows count as found`, 'the reveal count and its rows disagree');
}

// ---------------------------------------------------------------- phases
console.log('\nPHASES');
for (const p of of('phase')) console.log(`  ${pad(p.phase, 9)} ${p.skipped ? 'skipped (' + p.reason + ')' : s(p.ms)}${p.byStatus ? '  ' + JSON.stringify(p.byStatus) : ''}${p.byOutcome ? '  ' + JSON.stringify(p.byOutcome) : ''}`);

// ---------------------------------------------------------------- discovery funnel
const ck = one('discover.cookies'), vd = one('discover.verdicts'), rs = one('discover.restricted');
console.log('\nDISCOVERY');
if (rs) console.log(`  restricted mode: allowlist ${rs.allowlist.join(', ')}${rs.blocked.length ? ' · blocked ' + rs.blocked.join(', ') : ''}`);
if (ck) {
  console.log(`  ${ck.cookies} cookies → ${ck.sites} sites → ${ck.infraSites} infrastructure dropped → ${ck.noSessionCookie} without a session-like cookie → ${ck.signedInLike} signed-in-like${ck.dropped ? ` → ${ck.dropped} DROPPED by the ${ck.cappedAt} cap` : ''} (${s(ck.ms)})`);
  const third = (ck.sites_sent || []).filter((x) => x.thirdPartyOnly);
  if (third.length) console.log(`  third-party cookies only (likely ad-tech, still sent): ${third.length} — ${list(third.map((x) => x.d), 15)}`);
  const wh = one('discover.withheld');
  if (wh?.count) { const never = wh.sites.filter((x) => /never-explore/.test(x.why || '')); const built = wh.sites.filter((x) => !never.includes(x)); console.log(`  withheld before sending: ${wh.count}${built.length ? ` — never-touch (banks, government, health, payroll…): ${built.map((x) => x.d).join(', ')}` : ''}${never.length ? ` — your Never-explore list: ${never.map((x) => x.d).join(', ')}` : ''}`); }
  if (ck.dropped) flag('medium', `${ck.dropped} signed-in-like sites dropped by the ${ck.cappedAt}-site cap`, list(ck.sites_dropped_by_cap || [], 20));
}
// New logs: catalog hits, filters, accountUrl replacements and dedupe. Printed compactly whatever their shape.
const brief = (e) => { const { t, dt, kind, svc, ...rest } = e; return safe(JSON.stringify(rest, (k, v) => (Array.isArray(v) && v.length > 12 ? [...v.slice(0, 12), `+${v.length - 12} more`] : v)), 400); };
for (const e of E.filter((e) => /^discover\./.test(e.kind) && !['discover.cookies', 'discover.verdicts', 'discover.restricted', 'discover.withheld', 'discover.dropped_by_category', 'discover.missing', 'discover.chunk_failed'].includes(e.kind))) console.log(`  ${e.kind}: ${brief(e)}`);
if (vd) {
  console.log(`  model: ${vd.sent} sent → ${vd.answered} answered${vd.failed ? ` · ${vd.failed} FAILED` : ''} → ${vd.subscriptions} subscriptions${vd.blocked.length ? ` (${vd.blocked.length} blocklisted)` : ''}`);
  for (const x of vd.subscription) console.log(`    ${pad(safe(x.name), 24)} ${pad(x.domain, 22)} ${pad(x.category, 14)} conf ${pad(x.confidence, 4)} offers ${pad(x.offers, 8)} ${x.accountUrl ? short(x.accountUrl, 44) : '⚠ no account URL'}${x.notes ? `  · ${safe(x.notes, 60)}` : ''}`);
  const noUrl = vd.subscription.filter((x) => !x.accountUrl).map((x) => x.domain);
  if (noUrl.length) flag('medium', `no account URL for ${noUrl.length} service(s)`, `probed at a fallback URL: ${list(noUrl)}`);
  if (vd.failed) flag('high', `${vd.failed} domains never classified (discover call failed)`, '');
}
for (const e of of('discover.dropped_by_category')) flag('info', 'the model filed some "subscriptions" under a sensitive category; dropped', e.sites.map((x) => `${x.d} (${x.category})`).join(', '));
for (const e of of('discover.missing')) flag('low', 'model skipped some domains', list(e.domains, 20));
for (const e of of('discover.chunk_failed')) flag('high', 'a discover chunk failed', `${safe(e.error, 200)} · ${e.domains.length} domains`);

// ---------------------------------------------------------------- account pages
const emailOf = (p) => p.email ?? (p.classify?.signedIn ? p.classify?.accountEmail : null) ?? null;
const rememberedOf = (p) => p.rememberedEmail ?? (p.classify && !p.classify.signedIn ? p.classify.accountEmail : null) ?? null;
if (probes.length) {
  console.log('\nACCOUNT PAGES (classify, sorted by status)');
  console.log(`  ${pad('service', 22)} ${pad('status', 13)} ${pad('why', 15)} ${pad('pageKind·conf', 20)} ${pad('email', 18)} ${pad('pays', 13)} ${pad('renews', 11)} ${pad('load+cls', 10)} final page`);
  for (const p of [...probes].sort((a, b) => rank(a.status) - rank(b.status) || a.svc.localeCompare(b.svc))) {
    const c = p.classify || {};
    const pays = p.isTrial ? `trial→${$(c.priceAfterTrialUsd)}` : p.cycleCharge != null ? `${$(p.cycleCharge)}/${per(p.cadence)}` : '–';
    const em = emailOf(p) ? mask(emailOf(p)) : rememberedOf(p) ? `(${mask(rememberedOf(p))})` : '–';
    const moved = offService(p) ? (signInAt(p) ? '→sign-in ' : '⚠ moved ') : '';
    console.log(`  ${pad(p.svc, 22)} ${pad(p.status, 13)} ${pad(pageWhy(p), 15)} ${pad([kindOf(p), c.confidence].filter((x) => x != null).join('·') || '–', 20)} ${pad(em, 18)} ${pad(pays, 13)} ${pad(p.renewalDate, 11)} ${pad(`${s(p.loadMs)}${p.loadTimedOut ? '!' : ''}+${s(p.classifyMs)}`, 10)} ${moved}${short(p.finalUrl)}`);
    if (c.notes && p.status !== 'sensitive') console.log(`  ${' '.repeat(22)} └ ${safe(c.notes, 110)}`);
  }

  // Where the account URL went. A hop to an identity provider or the same company's other domain is not "leaving".
  const toSignIn = [], sameSvc = [];
  for (const p of probes.filter(offService)) {
    const fh = hostOf(p.finalUrl), ck2 = canonicalKey(p.svc);
    if (signInAt(p)) toSignIn.push(`${p.svc} → ${short(p.finalUrl, 40)}`);
    else if ((ck2 && ck2 === canonicalKey(fh)) || p.status === 'duplicate') sameSvc.push(`${p.svc} → ${etld1(fh)}`);
    else flag('medium', `${p.svc}: moved to ${etld1(fh)}`, `${short(p.accountUrl)} → ${short(p.finalUrl)}${p.redirected === false ? ' (no redirect recorded)' : ''}`);
  }
  if (toSignIn.length) flag('info', `${toSignIn.length} account URLs sent to a sign-in page`, list(toSignIn, 10));
  if (sameSvc.length) flag('info', `${sameSvc.length} landed on the same service's other domain`, list(sameSvc));
  const stale = probes.filter((p) => p.leftSite && !offService(p));
  if (stale.length) flag('info', `${stale.length} probes say leftSite but stayed on the service (old cookie-domain check)`, list(stale.map((p) => `${p.svc} → ${hostOf(p.finalUrl)}`)));

  // One line per kind of page behind every "signed out" status, not 47 identical flags.
  const walls = probes.filter((p) => p.status === 'login_wall');
  const byWhy = (why) => walls.filter((p) => pageWhy(p) === why).map((p) => p.svc);
  const bucket = [['wrong URL', 'medium', 'reported signed out, but the page is a 404/error: the account URL is wrong'], ['account page', 'medium', 'reported signed out on what looks like an account page: check'], ['loading/blocked', 'medium', "reported signed out, but the page hadn't loaded or was a robot check"], ['marketing', 'low', 'reported signed out on a public/marketing page'], ['sign-in form', 'info', 'a real sign-in form: signed out there (expected)']];
  for (const [why, sev, what] of bucket) { const xs = byWhy(why); if (xs.length) flag(sev, `${xs.length} × ${what}`, list(xs, 20)); }
  const agg = (sts, sev, what) => { const xs = probes.filter((p) => sts.includes(p.status)).map((p) => p.svc); if (xs.length) flag(sev, `${xs.length} × ${what}`, list(xs, 20)); };
  agg(['wrong_page'], 'medium', "couldn't find the account page (404/error, even after hops)");
  agg(['not_loaded'], 'medium', "page didn't load");
  agg(['needs_you'], 'info', 'needs the owner (robot check or password again)');
  const timeouts = probes.filter((p) => p.loadTimedOut).map((p) => p.svc);
  if (timeouts.length) flag('medium', `${timeouts.length} account pages did not finish loading`, `classified whatever had rendered; check the status: ${list(timeouts)}`);

  // Money: a "found" subscription whose plan the page never confirmed is the worst kind of wrong.
  for (const p of probes.filter((p) => p.status === 'signed_in' && (p.classify?.hasPaidPlan ?? null) === null)) flag('high', `${p.svc}: counted as a subscription without a confirmed plan${pageWhy(p) === 'wrong URL' ? ', on a 404/error page' : ''}`, `hasPaidPlan is null · page "${safe(p.page?.title, 60)}" · why ${pageWhy(p)}`);
  const noPrice = probes.filter((p) => PAYING.includes(p.status) && p.classify?.hasPaidPlan === true && p.monthlyPrice == null && p.cycleCharge == null && !p.isTrial).map((p) => p.svc);
  if (noPrice.length) flag('medium', `${noPrice.length} paid plan(s) with no price read`, `an offer can't be valued: ${list(noPrice)}`);
  // The panel shows the account's name when there is no email, so only a row with neither is anonymous.
  const noEmail = probes.filter((p) => PAYING.includes(p.status) && !emailOf(p) && !p.accountName).map((p) => p.svc);
  if (noEmail.length) flag('low', `${noEmail.length} paying service(s) with no account email or name`, list(noEmail));
  for (const p of probes.filter((p) => p.status === 'error')) flag('high', `${p.svc}: probe error`, safe(p.error, 200));
  for (const p of probes.filter((p) => p.status === 'sensitive')) flag('info', `${p.svc}: skipped as a sensitive account, nothing sent`, `${safe(p.sensitive, 80)} · landed on ${short(p.finalUrl)}. If this is a normal subscription, the page check is too strict`);
  for (const p of probes.filter((p) => p.isTrial)) flag('info', `${p.svc}: on a trial`, `after trial ${$(p.classify?.priceAfterTrialUsd)}, trial ends ${p.classify?.trialEndsOn}`);

  // ---------------------------------------------------------------- status × why
  console.log('\nBY STATUS × WHY (the report\'s own reading of each landing page)');
  const cells = new Map();
  for (const p of probes) { const k = `${p.status}|${pageWhy(p)}`; cells.set(k, [...(cells.get(k) || []), p.svc]); }
  for (const [k, xs] of [...cells].sort((a, b) => rank(a[0].split('|')[0]) - rank(b[0].split('|')[0]) || b[1].length - a[1].length)) { const [stt, why] = k.split('|'); console.log(`  ${pad(stt, 13)} ${pad(why, 15)} ${pad(xs.length, 3)} ${list(xs, 10)}`); }
}

// ---------------------------------------------------------------- duplicates (union-find)
// Linked by the same name, the same account-page site, or the same landing site. Identity providers and other
// sign-in hosts are left out: every Microsoft service lands on login.microsoftonline.com, every Shopify store on
// shopify.com/authentication.
const parent = new Map();
const root = (x) => { if (!parent.has(x)) parent.set(x, x); while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
const keysOf = (p) => {
  const k = [], nm = String(p.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (nm.length >= 3) k.push('name ' + nm);
  const ah = hostOf(p.accountUrl); if (ah && !isIdpHost(ah)) k.push('account page on ' + etld1(ah));
  const fh = hostOf(p.finalUrl); if (fh && !isIdpHost(fh) && !(signInAt(p) && offService(p))) k.push('landed on ' + etld1(fh));
  return k;
};
const members = probes.filter((p) => p.status !== 'sensitive');
for (const p of members) for (const k of keysOf(p)) parent.set(root('svc ' + p.svc), root(k));
const groups = new Map();
for (const p of members) { const r = root('svc ' + p.svc); groups.set(r, [...(groups.get(r) || []), p]); }
const groupOf = new Map();
const dupGroups = [...groups.values()].filter((g) => g.length > 1);
for (const g of dupGroups) for (const p of g) groupOf.set(p.svc, g);
if (dupGroups.length || of('scan.duplicates').length) {
  console.log('\nDUPLICATES (one account reached through several domains)');
  for (const g of dupGroups) {
    const kc = countBy(g.flatMap(keysOf)), shared = Object.entries(kc).filter(([, n]) => n > 1).map(([k]) => k);
    console.log(`  ${g.map((p) => `${safe(p.name, 24)} (${p.svc}, ${p.status}${p.dupOf ? ' of ' + p.dupOf : ''})`).join(' + ')}\n      linked by: ${shared.join(' · ') || 'a chain of links'}`);
    const counted = g.filter((p) => isFound(p.status));
    if (counted.length > 1) flag('medium', `${safe(g[0].name, 30)}: counted ${counted.length} times`, `${counted.map((p) => p.svc).join(', ')} are one account (${shared.join(' · ')})`);
  }
  for (const e of of('scan.duplicates')) console.log(`  extension marked: ${brief(e)}`);
}

// ---------------------------------------------------------------- would walk (the find pass's input)
const skipped = of('phase').find((p) => p.phase === 'find' && p.skipped);
const walkList = skipped ? skipped.wouldWalk || [] : [...new Set(of('find.start').map((e) => e.svc))];
// The walk's own precondition refused an item the scan sent it: the scan's gating let something through.
for (const e of of('find.skipped')) flag('medium', `${e.svc}: sent to the find pass but refused by its precondition`, safe(e.why, 120));
if (walkList.length || skipped) {
  console.log(`\n${skipped ? 'WOULD WALK (read-only run: nothing was opened)' : 'WALKED'}`);
  const seenGroup = new Map(), bad = [];
  for (const d of walkList) {
    const p = probeOf.get(d), c = p?.classify || {}, why = p ? pageWhy(p) : '?', kind = p && kindOf(p), problems = [];
    if (!p) problems.push('no probe event');
    else {
      if (c.hasPaidPlan !== true) problems.push(`plan not confirmed (hasPaidPlan ${c.hasPaidPlan})`);
      if (why !== 'account page') problems.push(`page is ${why}`);
      if (kind && !/^account_/.test(kind)) problems.push(`pageKind ${kind}`);
      if (p.status === 'work_account' || p.workReason || c.accountType === 'work_or_team' || c.billedVia === 'employer') problems.push('work account');
      if (c.billedVia && ['app_store', 'carrier', 'bundle_or_partner'].includes(c.billedVia)) problems.push(`billed via ${c.billedVia}`);
      const g = groupOf.get(d), first = g && seenGroup.get(g);
      if (first) problems.push(`duplicate of ${first}`); else if (g) seenGroup.set(g, d);
    }
    console.log(`  ${pad(d, 22)} ${pad(c.hasPaidPlan === true ? 'paid' : `paid? ${c.hasPaidPlan}`, 11)} ${pad(p?.monthlyPrice != null ? $(p.monthlyPrice) + '/mo' : '–', 10)} ${pad(why, 15)} ${problems.length ? '⚠ ' + problems.join(' · ') : 'ok'}${otherAccounts.has(d) ? ' · other account' : ''}`);
    if (problems.length) bad.push(`${d} (${problems.join(' · ')})`);
  }
  if (!walkList.length) console.log('  nothing');
  if (bad.length) flag('high', `${bad.length} of ${walkList.length} ${skipped ? 'walks would have gone' : 'walks went'} to an unconfirmed, wrong, duplicate or work page`, list(bad, 10));
}

// ---------------------------------------------------------------- identities
const ids = new Map();
const idKey = (e) => String(e).toLowerCase().trim();
for (const p of probes) {
  for (const [e, how] of [[emailOf(p), 'signed in'], [rememberedOf(p), 'remembered']]) {
    if (!e) continue;
    const k = idKey(e), x = ids.get(k) || { masked: mask(e), consumer: isConsumerEmail('x@' + mailDomain(e)), signedIn: [], remembered: [] };
    (how === 'signed in' ? x.signedIn : x.remembered).push(`${p.svc}${how === 'signed in' ? ' ' + p.status : ''}`);
    ids.set(k, x);
  }
}
if (ids.size) {
  console.log('\nIDENTITIES (who each service is signed in as)');
  for (const x of ids.values()) console.log(`  ${pad(x.masked, 26)} ${pad(x.consumer ? 'personal' : 'work/custom', 12)} ${x.signedIn.length ? 'signed in: ' + list(x.signedIn, 8) : ''}${x.remembered.length ? `${x.signedIn.length ? ' · ' : ''}remembered only: ${list(x.remembered, 8)}` : ''}`);
  const personal = [...ids.values()].filter((x) => x.consumer && x.signedIn.length);
  if (personal.length > 1) flag('medium', `${personal.length} different personal accounts are signed in`, `${personal.map((x) => `${x.masked} (${x.signedIn.length})`).join(', ')}: some subscriptions may belong to someone else in the household`);
  if (pagesPhase.ownerEmail) console.log(`  the extension took ${mask(pagesPhase.ownerEmail)} as the owner`);
  if (otherAccounts.size) console.log(`  marked "other account" by the extension: ${list([...otherAccounts])}`);
}

// ---------------------------------------------------------------- text quality (K1 regression detector)
if (texty.length) {
  console.log(`\nTEXT QUALITY (script or JSON where visible text belongs)`);
  console.log(`  ${k1.length} page(s) look like code${k1suspect.length ? ` · ${k1suspect.length} suspect by shape (page text off)` : ''} · ${texty.filter((x) => (x.p.page?.textLength || 0) > 20000).length} over 20k chars (context only)`);
  for (const { p, cs } of [...k1, ...k1suspect].sort((a, b) => b.cs.per1k - a.cs.per1k)) console.log(`    ${pad(p.svc, 22)} ${pad(p.page.textLength ?? '–', 8)} chars · ${pad(p.page.elements ?? '–', 3)} elements · ${cs.code ? `${cs.hits} code tokens (${cs.per1k}/1k)` : 'huge text per element'}`);
  if (k1.length) flag('high', `K1: ${k1.length} page(s) put script/JSON in the page text the model reads`, list(k1.map((x) => x.p.svc), 20));
}

// ---------------------------------------------------------------- classify sanity
const withCls = probes.filter((p) => p.classify);
if (withCls.length) {
  const NOT_PLAN_RE = /\bnot (a |the )?([\w-]+ ){0,2}(account|billing|subscription|plan)\b|landing|marketing|main (chat )?interface/i;
  const NO_MONEY_KINDS = ['login', 'not_found', 'error', 'loading', 'bot_challenge', 'marketing'];
  const EXPECT = { not_found: ['wrong_page'], error: ['wrong_page'], loading: ['not_loaded'], bot_challenge: ['needs_you'], reauth: ['needs_you'], login: ['login_wall'] };
  const OVERRIDES = ['sensitive', 'error', 'duplicate', 'work_account'];
  const money = (c) => [c.monthlyPriceUsd, c.cycleChargeUsd, c.priceAfterTrialUsd].some((x) => x != null && x > 0);
  const out = [];
  const add = (sev, svc, what, raise = true) => { out.push(`  [${sev}] ${pad(svc, 22)} ${what}`); if (raise) flag(sev, `${svc}: ${what}`, ''); };
  for (const p of withCls) {
    const c = p.classify, kind = kindOf(p), why = pageWhy(p);
    if (c.signedIn === false && money(c)) add('medium', p.svc, `a price was read while signed out (${$(c.monthlyPriceUsd ?? c.priceAfterTrialUsd)})`);
    if (c.hasPaidPlan === false && (NOT_PLAN_RE.test(c.notes || '') || (c.isPlanPage === false && kind && kind !== 'account_billing'))) add('medium', p.svc, `"no paid plan" on a page that isn't a plan page${kind ? ` (${kind})` : ''}`);
    if (kind && NO_MONEY_KINDS.includes(kind) && money(c)) add('high', p.svc, `money fields on a ${kind} page: the server guard should have nulled them`);
    if (kind && EXPECT[kind] && !EXPECT[kind].includes(p.status) && !OVERRIDES.includes(p.status)) add('medium', p.svc, `pageKind ${kind} but status ${p.status}`);
    if (kind && KIND_WHY[kind] && KIND_WHY[kind] !== why && (why === 'wrong URL' || KIND_WHY[kind] === 'wrong URL')) add('low', p.svc, `the report reads "${why}", the classifier "${kind}"`);
    if (why === 'wrong URL' && isFound(p.status)) add('high', p.svc, `counted as paying, but the page is a 404/error`, c.hasPaidPlan === true);   // null: flagged above already
  }
  const lowConf = withCls.filter((p) => p.classify.confidence != null && p.classify.confidence < 0.7);
  if (lowConf.length) { out.push(`  [low]    confidence < 0.7: ${list(lowConf.map((p) => `${p.svc} ${p.classify.confidence}`), 12)}`); flag('low', `${lowConf.length} classification(s) with confidence < 0.7`, list(lowConf.map((p) => p.svc))); }
  console.log(`\nCLASSIFY SANITY${out.length ? '' : '  nothing odd'}`);
  for (const l of out) console.log(l);
}

// ---------------------------------------------------------------- secrets and personal data in the log itself
// Every string in every event, through the same scrubbers the extension uses: anything they would still change
// is something that should never have been written. Reports where, never what.
const SECRET_KIND = { jwt: 'JWT', keyed: 'keyed secret (token=…, "sessionId":…)', bearer: 'Bearer token', hex: 'hex token (32+ chars)', blob: 'base64 token (40+ chars)', digits: 'digit run of 12+', ssn: 'SSN' };
const PII_MARK = { '[card]': 'card last-4', '[exp]': 'card expiry', '[address]': 'street address', '[zip]': 'ZIP code', '[redacted]': 'birthdate' };
const TEXTISH = /(^|\.)(page\.)?(text|title|headings|buttons|notes|reasoning|liveText|note|error)(\[\])?$/;
const leaks = new Map();
const leak = (what, where) => { if (!leaks.has(what)) leaks.set(what, new Set()); leaks.get(what).add(where); };
const nOf = (x, mk) => x.split(mk).length - 1;
function scanStrings(v, path, where) {
  if (typeof v === 'string') {
    if (v.length < 6) return;
    for (const k of secretKinds(v)) leak(SECRET_KIND[k] || k, where(path));
    if (/^https?:\/\//i.test(v)) { const su = scrubUrl(v); if (nOf(su, '=x') > nOf(v, '=x') || nOf(su, '[token]') > nOf(v, '[token]')) leak('secret-looking URL parameter or path', where(path)); }
    for (const mm of v.matchAll(EMAIL_RE)) if (!IMAGE_RE.test(mm[0])) { leak('full email address', where(path)); break; }
    if (TEXTISH.test(path)) { const sp = scrubPii(v); if (sp !== v) for (const [mk, what] of Object.entries(PII_MARK)) if (nOf(sp, mk) > nOf(v, mk)) leak(what, where(path)); }
  } else if (Array.isArray(v)) v.forEach((x) => scanStrings(x, path + '[]', where));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) scanStrings(x, path ? `${path}.${k}` : k, where);
}
for (const e of E) { const { t, dt, kind, svc, ...rest } = e; scanStrings(rest, '', (path) => `${svc || '-'} · ${kind}.${path}`); }
console.log(`\nSECRETS & PERSONAL DATA IN THIS LOG${leaks.size ? '' : '  none found'}`);
for (const [what, where] of leaks) {
  const fields = countBy([...where].map((w) => w.split(' · ')[1]));
  console.log(`  ${pad(what, 40)} ${pad(where.size, 4)} place(s) · ${list(Object.entries(fields).map(([f, n]) => `${f} ×${n}`), 6)}`);
  const pii = Object.values(PII_MARK).includes(what);
  flag(pii ? 'medium' : 'high', `the log contains ${what}: ${where.size} place(s)`, list([...where], 8));
}

// ---------------------------------------------------------------- new-log sections: hops, readiness, work accounts
const hopped = probes.filter((p) => p.hops?.length);
if (hopped.length) {
  console.log(`\nHOPS (fallback navigations while looking for the account page): ${hopped.length} probe(s) · ${Object.entries(countBy(hopped.flatMap((p) => p.hops.map((h) => String(h.why || '?'))))).map(([k, n]) => `${n} ${safe(k, 30)}`).join(', ')}`);
  for (const p of hopped) console.log(`  ${pad(p.svc, 22)} ${pad(p.status, 13)} ${p.hops.map((h) => `${safe(h.why, 24)}: ${short(h.to, 44)}`).join('  ⇢  ')}`);
}
const readied = probes.filter((p) => p.ready);
if (readied.length) {
  const notReady = readied.filter((p) => p.ready.kind !== 'ready');
  console.log(`\nREADINESS (was the page done before it was read?): ${Object.entries(countBy(readied.map((p) => p.ready.kind))).map(([k, n]) => `${n} ${k}`).join(', ')} · p50 ${s(pct(readied.map((p) => p.ready.ms || 0), 50))} · p95 ${s(pct(readied.map((p) => p.ready.ms || 0), 95))}`);
  for (const p of notReady) console.log(`  ${pad(p.svc, 22)} ${pad(p.ready.kind, 10)} ${pad(s(p.ready.ms), 6)} ${pad((p.ready.visibleTextLen ?? '–') + ' chars', 12)} ${(p.ready.interactiveCount ?? '–') + ' controls'} → ${p.status}`);
  const readyButEmpty = readied.filter((p) => p.ready.kind === 'ready' && (p.page?.elements === 0 || pageWhy(p) === 'loading/blocked'));
  if (readyButEmpty.length) flag('medium', `${readyButEmpty.length} page(s) judged ready but read as loading/blocked`, list(readyButEmpty.map((p) => p.svc)));
}
const work = probes.filter((p) => p.status === 'work_account');
if (work.length) {
  console.log(`\nWORK ACCOUNTS (left alone): ${work.length}`);
  for (const p of work) console.log(`  ${pad(p.svc, 22)} ${pad(mask(emailOf(p)) || '–', 22)} ${safe(p.workReason || p.classify?.notes, 90)}`);
}

// ---------------------------------------------------------------- walks
const walks = of('find.result');
if (walks.length) {
  console.log('\nOFFER WALKS (find)');
  for (const w of walks) {
    const steps = E.filter((e) => e.kind === 'step' && e.svc === w.svc);
    const retries = E.filter((e) => e.kind === 'step.retry' && e.svc === w.svc);
    // A real save is the guardrail overruling the model. The find-mode pause (accept → "offer found, stop
    // here") is the design working, not a save, so it is not counted.
    const isPause = (x) => (x.guardrails || []).some((g) => /^find mode:/.test(g)) && x.action?.outcome === 'offer_found';
    const saves = steps.filter((x) => (x.changedByGuardrail && !isPause(x)) || x.clickRefused);
    const t0 = E.find((e) => e.kind === 'find.start' && e.svc === w.svc)?.t, t1 = w.t;
    const o = w.offer;
    const terms = o ? [o.discountPct != null ? `${o.discountPct > 1 ? o.discountPct : Math.round(o.discountPct * 100)}% off` : null, o.newMonthlyPriceUsd != null ? `$${o.newMonthlyPriceUsd}/mo` : null, o.freeMonths ? `${o.freeMonths} free mo` : null, o.termMonths ? `for ${o.termMonths} mo` : null].filter(Boolean).join(' ') || safe(o.description, 60) : '';
    console.log(`  ${pad(safe(w.name), 24)} ${pad(w.outcome, 20)} ${pad(steps.length + ' steps', 9)} ${pad(t0 ? s(t1 - t0) : '–', 7)} ${terms}${saves.length ? `  ⛔ ${saves.length} guardrail save(s)` : ''}${retries.length ? `  ↻ ${retries.length} retries` : ''}`);
    if (w.outcome === 'offer_found' && o && o.discountPct == null && o.newMonthlyPriceUsd == null && !o.freeMonths) flag('medium', `${w.svc}: offer found but its terms weren't read`, `"${safe(o.description, 100)}" — the saving can't be computed`);
    if (w.outcome === 'error') flag('high', `${w.svc}: walk ended in error`, safe(w.reason || w.error, 200));
    if (w.outcome === 'ai_declined') flag('medium', `${w.svc}: the model declined to act`, safe(w.reason, 200));
    if (w.outcome === 'blocked_needs_you') flag('medium', `${w.svc}: hit a sign-in wall mid-walk`, safe(w.reason, 200));
    for (const x of saves) flag('high', `${w.svc} step ${x.step}: a guardrail stopped the model`, `${x.proposed?.type} → ${x.action?.type}${x.liveText ? ` (live text "${safe(x.liveText, 60)}")` : ''} · ${safe((x.guardrails || []).join(' | '), 200)} · reasoning: ${safe(x.reasoning, 200)}`);
    for (const x of steps.filter((x) => x.offSite)) flag('high', `${w.svc} step ${x.step}: the walk left the site`, short(x.url));
    for (const x of steps.filter((x) => x.ok === false)) flag('medium', `${w.svc} step ${x.step}: action failed`, `${x.action?.type} "${safe(x.action?.target, 60)}" · ${safe(x.note, 120)}${x.errorKind ? ` (${x.errorKind})` : ''}`);
    for (const x of steps.filter((x) => x.settle?.loadTimedOut)) flag('medium', `${w.svc} step ${x.step}: page didn't finish loading after the click`, short(x.url));
    const noEffect = steps.filter((x) => x.settle?.kind === 'no_effect');
    if (noEffect.length) flag('low', `${w.svc}: ${noEffect.length} click(s) had no visible effect`, noEffect.map((x) => `step ${x.step}`).join(', '));
    const stale = steps.filter((x) => x.stale);
    if (stale.length) flag('low', `${w.svc}: ${stale.length} step(s) acted on a page that had changed since it was read (re-read)`, stale.map((x) => `step ${x.step}`).join(', '));
    const k1Steps = steps.filter((x) => codeScore(x.page)?.code);
    if (k1Steps.length) flag('high', `${w.svc}: K1 on ${k1Steps.length} walk step page(s)`, k1Steps.map((x) => `step ${x.step}`).join(', '));
    if (retries.length) flag('medium', `${w.svc}: ${retries.length} brain retries`, safe(retries.map((r) => r.error).join(' | '), 300));
  }
  for (const e of of('step.tab_error')) flag('medium', `${e.svc} step ${e.step}: tab error (${e.errorKind})`, safe(e.error, 200));
  for (const e of of('step.budget_exhausted')) flag('high', `${e.svc}: ran out of steps (${e.maxSteps})`, 'likely a loop or a flow it could not read');
  for (const e of of('step.sensitive_page')) flag('high', `${e.svc}: a walk reached a banking or other sensitive page and stopped`, `${short(e.url)} · ${safe(e.why, 100)}`);
  for (const e of of('step.blocked')) flag('high', `${e.svc}: a step landed on a blocklisted site`, short(e.url));
  for (const e of of('find.start').filter((e) => e.loadTimedOut)) flag('medium', `${e.svc}: account page timed out at the start of the walk`, short(e.accountUrl));
}

// ---------------------------------------------------------------- API timing, tokens, cost
const api = of('api');
if (api.length) {
  console.log('\nAPI CALLS');
  const PRICE = { 'agent-step': [0.75, 3.75, 'gemini-3.8-flash'], classify: [0.25, 1.5, 'gemini-3.1-flash-lite'], discover: [0.25, 1.5, 'gemini-3.1-flash-lite'] };
  let cost = 0; const tok = { in: 0, out: 0, think: 0 };
  for (const path of [...new Set(api.map((a) => a.path))]) {
    const xs = api.filter((a) => a.path === path), ms = xs.map((a) => a.ms), net = xs.map((a) => a.networkMs).filter((x) => x != null);
    const errs = xs.filter((a) => !a.ok).length, tos = xs.filter((a) => a.timedOut).length;
    const key = path.replace('/api/', ''); const pr = PRICE[key];
    let c = 0; for (const a of xs) if (a.usage && pr) { c += (a.usage.inputTokens * pr[0] + (a.usage.outputTokens + a.usage.thinkingTokens) * pr[1]) / 1e6; tok.in += a.usage.inputTokens; tok.out += a.usage.outputTokens; tok.think += a.usage.thinkingTokens; }
    cost += c;
    console.log(`  ${pad(path, 22)} ${pad(xs.length + ' calls', 9)} p50 ${pad(s(pct(ms, 50)), 6)} p95 ${pad(s(pct(ms, 95)), 6)} max ${pad(s(Math.max(...ms)), 6)} · network p50 ${pad(s(pct(net, 50)), 6)}${errs ? `  ⚠ ${errs} errors` : ''}${tos ? ` (${tos} timeouts)` : ''}${c ? `  ~$${c.toFixed(4)}` : ''}`);
  }
  console.log(`  tokens: ${tok.in} in · ${tok.out} out · ${tok.think} thinking · estimated model cost ~$${cost.toFixed(3)} (list prices)`);
  for (const a of api.filter((a) => a.ms > 10000)) flag('low', `slow API call: ${a.path}${a.svc ? ' for ' + a.svc : ''} took ${s(a.ms)}`, `server ${s(a.serverMs)}, network ${s(a.networkMs)}`);
  for (const a of api.filter((a) => !a.ok)) flag('high', `API ${a.timedOut ? 'timeout' : 'error'}: ${a.path}${a.svc ? ' for ' + a.svc : ''}`, `${a.status ?? ''} ${safe(a.error, 200)}`);
  const slowNet = api.filter((a) => a.networkMs != null && a.networkMs > 3000);
  if (slowNet.length) flag('info', `${slowNet.length} calls spent over 3s on the network alone`, 'your connection, not the model');
}

// ---------------------------------------------------------------- flags
const order = { high: 0, medium: 1, low: 2, info: 3 };
flags.sort((a, b) => order[a.sev] - order[b.sev]);
console.log(`\nFLAGS (${flags.length})${flags.length ? '  ' + Object.entries(countBy(flags.map((f) => f.sev))).map(([k, n]) => `${n} ${k}`).join(' · ') : '  none'}`);
for (const f of flags) console.log(`  [${f.sev.toUpperCase()}] ${f.what}${f.detail ? `\n         ${f.detail}` : ''}`);
console.log('\nFor one service in full:  npm run review-log -- ' + file + ' --svc=<domain> [--text]\n');

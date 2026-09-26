// Read a Walkaway test-mode log and print a report: what happened, how long it took, what it cost,
// and a list of FLAGS worth a closer look (timeouts, retries, wrong account pages, guardrail saves...).
//
//   npm run review-log -- ~/Downloads/walkaway-test-log-2026-09-26T18-02-11.json
//   npm run review-log -- <log> --svc=hulu.com         full step-by-step trace for one service
//   npm run review-log -- <log> --svc=hulu.com --text  ...including the page text at each step
import fs from 'node:fs';

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
const flags = [];
const flag = (sev, what, detail) => flags.push({ sev, what, detail });

// ---------------------------------------------------------------- one service in full
if (opt.svc) {
  const d = String(opt.svc);
  const mine = E.filter((e) => e.svc === d || e.svc?.endsWith?.(d));
  if (!mine.length) { console.error(`no events for ${d}`); process.exit(1); }
  console.log(`\n=== ${d}: ${mine.length} events ===\n`);
  for (const e of mine) {
    if (e.kind === 'step') {
      const a = e.action || {};
      console.log(`+${s(e.dt)}  step ${e.step} [${e.state}]  ${e.proposed?.type ?? '?'}${e.proposed?.id != null ? ' #' + e.proposed.id : ''} → ${a.type}${a.id != null ? ' #' + a.id : ''}${a.target ? ` "${a.target}"` : ''}${a.outcome ? ' :' + a.outcome : ''}`);
      console.log(`         url ${e.url}${e.offSite ? '  ⚠ OFF SITE' : ''}`);
      if (e.reasoning) console.log(`         why: ${e.reasoning}`);
      if (e.guardrails?.length) console.log(`         guardrails: ${e.guardrails.join(' | ')}`);
      if (e.offer) console.log(`         offer: ${JSON.stringify(e.offer)}`);
      if (e.clickRefused) console.log(`         ⛔ click refused at click time, live text: "${e.liveText}"`);
      if (e.ok === false) console.log(`         ⚠ action failed: ${e.note}`);
      console.log(`         timing: snapshot ${s(e.snapMs)} · brain ${s(e.brainMs)}${e.actMs != null ? ` · act ${s(e.actMs)}` : ''}${e.settle ? ` · settle ${s(e.settle.ms)}${e.settle.navigated ? ' (navigated)' : ''}${e.settle.loadTimedOut ? ' ⚠ LOAD TIMEOUT' : ''}` : ''}`);
      if (e.page?.buttons) console.log(`         buttons: ${e.page.buttons.slice(0, 12).join(' · ')}`);
      if (opt.text && e.page?.text) console.log(`         text: ${e.page.text.replace(/\s+/g, ' ').slice(0, 1500)}`);
    } else if (e.kind === 'api') {
      console.log(`+${s(e.dt)}  api ${e.path}${e.goal ? ' ' + e.goal : ''}${e.step != null ? ' step ' + e.step : ''} ${e.ok ? 'ok' : '⚠ ' + e.error} · ${s(e.ms)} (server ${s(e.serverMs)}, network ${s(e.networkMs)})${e.usage ? ` · ${e.usage.inputTokens}+${e.usage.outputTokens}+${e.usage.thinkingTokens} tok` : ''}`);
    } else if (e.kind === 'probe') {
      console.log(`+${s(e.dt)}  probe: status ${e.status} · load ${s(e.loadMs)}${e.loadTimedOut ? ' ⚠ TIMEOUT' : ''} · classify ${s(e.classifyMs)} · final ${e.finalUrl}`);
      console.log(`         classify: ${JSON.stringify(e.classify)}`);
      if (opt.text && e.page?.text) console.log(`         text: ${e.page.text.replace(/\s+/g, ' ').slice(0, 1500)}`);
    } else {
      const { t, dt, kind, svc, ...rest } = e;
      console.log(`+${s(dt)}  ${kind}: ${JSON.stringify(rest).slice(0, 400)}`);
    }
  }
  process.exit(0);
}

// ---------------------------------------------------------------- header
const m = log.meta || {};
const st = m.settings || {};
const dur = (log.endedAt || E[E.length - 1]?.t) - log.startedAt;
console.log(`\nWALKAWAY TEST LOG  ${m.startedAtLocal || new Date(log.startedAt).toString()}`);
console.log(`extension ${m.extensionVersion} · API ${st.apiBase} · ${st.restrictedMode ? 'RESTRICTED' : 'all signed-in sites'} · ${st.testFind ? 'walks cancellation flows' : 'read-only'} · page text ${st.testPageText ? 'on' : 'off'}`);
if (m.network) console.log(`network: ${m.network.effectiveType}, ~${m.network.downlinkMbps} Mbps, rtt ~${m.network.rttMs}ms`);
console.log(`duration ${s(dur)} · ${E.length} events${log.endedAt ? '' : ' · ⚠ LOG NEVER FINISHED (panel closed or crash?)'}`);
if (!log.endedAt) flag('high', 'run never finished', 'the log has no run.end: the panel was closed mid-scan or something threw without being caught');
const err = one('run.error');
if (err) flag('high', 'scan threw', err.error);

// ---------------------------------------------------------------- phases
console.log('\nPHASES');
for (const p of of('phase')) console.log(`  ${pad(p.phase, 9)} ${p.skipped ? 'skipped (' + p.reason + ')' : s(p.ms)}${p.byStatus ? '  ' + JSON.stringify(p.byStatus) : ''}${p.byOutcome ? '  ' + JSON.stringify(p.byOutcome) : ''}`);

// ---------------------------------------------------------------- discovery funnel
const ck = one('discover.cookies'), vd = one('discover.verdicts'), rs = one('discover.restricted');
console.log('\nDISCOVERY');
if (rs) console.log(`  restricted mode: allowlist ${rs.allowlist.join(', ')}${rs.blocked.length ? ' · blocked ' + rs.blocked.join(', ') : ''}`);
if (ck) {
  console.log(`  ${ck.cookies} cookies → ${ck.sites} sites → ${ck.infraSites} infrastructure dropped → ${ck.noSessionCookie} without a session-like cookie → ${ck.signedInLike} signed-in-like${ck.dropped ? ` → ${ck.dropped} DROPPED by the ${ck.cappedAt} cap` : ''} (${s(ck.ms)})`);
  if (ck.dropped) flag('medium', `${ck.dropped} signed-in-like sites dropped by the ${ck.cappedAt}-site cap`, (ck.sites_dropped_by_cap || []).slice(0, 20).join(', '));
}
if (vd) {
  console.log(`  model: ${vd.sent} sent → ${vd.answered} answered${vd.failed ? ` · ${vd.failed} FAILED` : ''} → ${vd.subscriptions} subscriptions${vd.blocked.length ? ` (${vd.blocked.length} blocklisted)` : ''}`);
  for (const x of vd.subscription) console.log(`    ${pad(x.name, 28)} ${pad(x.domain, 26)} conf ${pad(x.confidence, 4)} offers ${pad(x.offers, 8)} ${x.accountUrl ?? '⚠ no account URL'}`);
  for (const x of vd.subscription.filter((x) => !x.accountUrl)) flag('medium', `no account URL guessed for ${x.domain}`, 'probed at https://www.<domain>/account, which is often wrong');
  if (vd.failed) flag('high', `${vd.failed} domains never classified (discover call failed)`, '');
}
for (const e of of('discover.missing')) flag('low', 'model skipped some domains', e.domains.join(', '));
for (const e of of('discover.chunk_failed')) flag('high', 'a discover chunk failed', `${e.error} · ${e.domains.length} domains`);

// ---------------------------------------------------------------- account pages
const probes = of('probe');
if (probes.length) {
  console.log('\nACCOUNT PAGES (classify)');
  console.log(`  ${pad('service', 24)} ${pad('status', 12)} ${pad('email', 26)} ${pad('pays', 14)} ${pad('renews', 16)} ${pad('load', 6)} ${pad('class.', 6)} final page`);
  for (const p of probes) {
    const pays = p.isTrial ? `trial→${$(p.classify?.priceAfterTrialUsd)}` : p.cycleCharge != null ? `${$(p.cycleCharge)}/${p.cadence === 'year' ? 'yr' : p.cadence === 'week' ? 'wk' : 'mo'}` : '–';
    console.log(`  ${pad(p.name, 24)} ${pad(p.status, 12)} ${pad(p.email, 26)} ${pad(pays, 14)} ${pad(p.renewalDate, 16)} ${pad(s(p.loadMs) + (p.loadTimedOut ? '!' : ''), 6)} ${pad(s(p.classifyMs), 6)} ${p.leftSite ? '⚠ LEFT SITE ' : ''}${p.finalUrl ?? ''}`);
    if (p.loadTimedOut) flag('medium', `${p.svc}: account page did not finish loading in 20s`, 'classified whatever had rendered; check the status is right');
    if (p.leftSite) flag('medium', `${p.svc}: account URL redirected off the site`, `${p.accountUrl} → ${p.finalUrl}`);
    if (p.status === 'login_wall') flag('medium', `${p.svc}: reported NOT signed in`, `landed on ${p.finalUrl}. If you are signed in there, the guessed account URL (${p.accountUrl}) is wrong`);
    if (p.status === 'signed_in' && p.monthlyPrice == null && !p.isTrial) flag('medium', `${p.svc}: signed in but no price read`, `the offer can't be valued; page title "${p.page?.title}"`);
    if (p.status === 'signed_in' && !p.email) flag('low', `${p.svc}: no account email found on the page`, '');
    if (p.status === 'error') flag('high', `${p.svc}: probe error`, p.error);
    if (p.isTrial) flag('info', `${p.svc}: on a trial`, `after trial ${$(p.classify?.priceAfterTrialUsd)}, trial ends ${p.classify?.trialEndsOn}`);
  }
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
    const terms = o ? [o.discountPct != null ? `${o.discountPct > 1 ? o.discountPct : Math.round(o.discountPct * 100)}% off` : null, o.newMonthlyPriceUsd != null ? `$${o.newMonthlyPriceUsd}/mo` : null, o.freeMonths ? `${o.freeMonths} free mo` : null, o.termMonths ? `for ${o.termMonths} mo` : null].filter(Boolean).join(' ') || o.description : '';
    console.log(`  ${pad(w.name, 24)} ${pad(w.outcome, 20)} ${pad(steps.length + ' steps', 9)} ${pad(t0 ? s(t1 - t0) : '–', 7)} ${terms}${saves.length ? `  ⛔ ${saves.length} guardrail save(s)` : ''}${retries.length ? `  ↻ ${retries.length} retries` : ''}`);
    if (w.outcome === 'offer_found' && o && o.discountPct == null && o.newMonthlyPriceUsd == null && !o.freeMonths) flag('medium', `${w.svc}: offer found but its terms weren't read`, `"${o.description}" — the saving can't be computed`);
    if (w.outcome === 'error') flag('high', `${w.svc}: walk ended in error`, w.reason || w.error);
    if (w.outcome === 'ai_declined') flag('medium', `${w.svc}: the model declined to act`, w.reason);
    if (w.outcome === 'blocked_needs_you') flag('medium', `${w.svc}: hit a sign-in wall mid-walk`, w.reason);
    for (const x of saves) flag('high', `${w.svc} step ${x.step}: a guardrail stopped the model`, `${x.proposed?.type} → ${x.action?.type}${x.liveText ? ` (live text "${x.liveText}")` : ''} · ${x.guardrails.join(' | ')} · reasoning: ${x.reasoning}`);
    for (const x of steps.filter((x) => x.offSite)) flag('high', `${w.svc} step ${x.step}: the walk left the site`, x.url);
    for (const x of steps.filter((x) => x.ok === false)) flag('medium', `${w.svc} step ${x.step}: action failed`, `${x.action?.type} "${x.action?.target}" · ${x.note}`);
    for (const x of steps.filter((x) => x.settle?.loadTimedOut)) flag('medium', `${w.svc} step ${x.step}: page didn't finish loading after the click`, x.url);
    if (retries.length) flag('medium', `${w.svc}: ${retries.length} brain retries`, retries.map((r) => r.error).join(' | ').slice(0, 300));
  }
  for (const e of of('step.budget_exhausted')) flag('high', `${e.svc}: ran out of steps (${e.maxSteps})`, 'likely a loop or a flow it could not read');
  for (const e of of('step.blocked')) flag('high', `${e.svc}: a step landed on a blocklisted site`, e.url);
  for (const e of of('find.start').filter((e) => e.loadTimedOut)) flag('medium', `${e.svc}: account page timed out at the start of the walk`, e.accountUrl);
}
const skipped = of('phase').find((p) => p.phase === 'find' && p.skipped);
if (skipped) console.log(`\nOFFER WALKS: skipped (read-only). Would have walked: ${skipped.wouldWalk.join(', ') || 'nothing'}`);

// ---------------------------------------------------------------- API timing, tokens, cost
const api = of('api');
if (api.length) {
  console.log('\nAPI CALLS');
  const PRICE = { 'agent-step': [0.75, 3.75, 'gemini-3.8-flash'], classify: [0.25, 1.5, 'gemini-3.1-flash-lite'], discover: [0.25, 1.5, 'gemini-3.1-flash-lite'] };
  let cost = 0; const tok = { in: 0, out: 0, think: 0 };
  for (const path of [...new Set(api.map((a) => a.path))]) {
    const xs = api.filter((a) => a.path === path), ms = xs.map((a) => a.ms), net = xs.map((a) => a.networkMs).filter((x) => x != null);
    const errs = xs.filter((a) => !a.ok).length;
    const key = path.replace('/api/', ''); const pr = PRICE[key];
    let c = 0; for (const a of xs) if (a.usage && pr) { c += (a.usage.inputTokens * pr[0] + (a.usage.outputTokens + a.usage.thinkingTokens) * pr[1]) / 1e6; tok.in += a.usage.inputTokens; tok.out += a.usage.outputTokens; tok.think += a.usage.thinkingTokens; }
    cost += c;
    console.log(`  ${pad(path, 22)} ${pad(xs.length + ' calls', 9)} p50 ${pad(s(pct(ms, 50)), 6)} p95 ${pad(s(pct(ms, 95)), 6)} max ${pad(s(Math.max(...ms)), 6)} · network p50 ${pad(s(pct(net, 50)), 6)}${errs ? `  ⚠ ${errs} errors` : ''}${c ? `  ~$${c.toFixed(4)}` : ''}`);
  }
  console.log(`  tokens: ${tok.in} in · ${tok.out} out · ${tok.think} thinking · estimated model cost ~$${cost.toFixed(3)} (list prices)`);
  for (const a of api.filter((a) => a.ms > 10000)) flag('low', `slow API call: ${a.path}${a.svc ? ' for ' + a.svc : ''} took ${s(a.ms)}`, `server ${s(a.serverMs)}, network ${s(a.networkMs)}`);
  for (const a of api.filter((a) => !a.ok)) flag('high', `API error: ${a.path}${a.svc ? ' for ' + a.svc : ''}`, `${a.status} ${a.error}`);
  const slowNet = api.filter((a) => a.networkMs != null && a.networkMs > 3000);
  if (slowNet.length) flag('info', `${slowNet.length} calls spent over 3s on the network alone`, 'your connection, not the model');
}

// ---------------------------------------------------------------- flags
const order = { high: 0, medium: 1, low: 2, info: 3 };
flags.sort((a, b) => order[a.sev] - order[b.sev]);
console.log(`\nFLAGS (${flags.length})${flags.length ? '' : '  none'}`);
for (const f of flags) console.log(`  [${f.sev.toUpperCase()}] ${f.what}${f.detail ? `\n         ${f.detail}` : ''}`);
console.log('\nFor one service in full:  npm run review-log -- ' + file + ' --svc=<domain> [--text]\n');

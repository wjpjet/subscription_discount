// Real cancellation flows as test cases. A test-mode scan with "Record each page for replay tests" on keeps every
// account page it read and every walk step, exactly as the model saw them (scrubbed). This turns them into flow files
// and replays them against the current brain and guardrails, so a prompt or guardrail change can be checked on real
// sites' pages without visiting them again.
//
//   npm run flows -- <log.json>                      list the recorded flows, write them to flows/<run>/
//   npm run flows -- <log.json | flows/<run>> --replay        re-decide every page: MOCK brain + guardrails (free)
//   npm run flows -- <...> --replay --real [--max=10]         the real model, at most --max calls (costs money)
//   ... --svc=netflix.com   one service only      ... --phase=find|probe   one kind of flow only
//
// Flow files hold scrubbed page text (no tokens, card data, addresses or full emails) but can still hold names and
// plan details. flows/ is git-ignored: keep them on this machine unless you mean to share them.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
if (!input) { console.error('usage: npm run flows -- <walkaway-test-log.json | flows/<run>> [--replay [--real --max=10]] [--svc=domain] [--phase=find|probe]'); process.exit(1); }
const REAL = !!opt.real, MAX = Number(opt.max || 10);
if (REAL) process.env.AI_PROVIDER ||= 'gemini'; else process.env.WALKAWAY_BRAIN = 'mock';
process.env.WALKAWAY_RATE_LIMIT = '0';

// ---------------------------------------------------------------- load
function fromLog(file) {
  const log = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (log.format !== 'walkaway-test-log') throw new Error('not a Walkaway test log');
  const E = log.events, pages = E.filter((e) => e.kind === 'flow.page' && e.snapshot);
  const flows = new Map();
  for (const e of pages) {
    const key = `${e.svc}.${e.phase}`;
    if (!flows.has(key)) flows.set(key, { format: 'walkaway-flow', version: 1, source: path.basename(file), recordedAt: log.meta?.startedAtLocal || null, svc: e.svc, name: e.name || e.svc, phase: e.phase, outcome: null, pages: [] });
    const { t, dt, kind, svc, name, phase, ...rest } = e;
    flows.get(key).pages.push(rest);
  }
  for (const f of flows.values()) {
    f.maxSteps = Number(log.meta?.settings?.maxSteps) || 25;
    if (f.phase !== 'probe') for (const p of f.pages) {
      const s = E.find((x) => x.kind === 'step' && x.svc === f.svc && x.goal === f.phase && x.step === p.step);
      if (s) { p.ok = !(s.stale || s.clickRefused || s.blockedNav || s.blockedLink) && s.ok !== false; p.note = s.note ?? null; }
    }
    if (f.phase === 'probe') { const p = E.find((x) => x.kind === 'probe' && x.svc === f.svc); f.outcome = p ? { status: p.status, pageKind: p.pageKind ?? null, monthlyPrice: p.monthlyPrice ?? null } : null; }
    else { const r = E.find((x) => x.kind === 'find.result' && x.svc === f.svc); f.outcome = r ? { outcome: r.outcome, reason: r.reason ?? null, offer: r.offer ?? null } : null; }
  }
  return { flows: [...flows.values()], run: path.basename(file).replace(/^walkaway-test-log-|\.json$/g, ''), recordedPages: pages.length };
}
function fromDir(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  return { flows: files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).filter((f) => f.format === 'walkaway-flow'), run: path.basename(dir), recordedPages: null };
}
const isDir = fs.existsSync(input) && fs.statSync(input).isDirectory();
let { flows, run, recordedPages } = isDir ? fromDir(input) : fromLog(input);
if (opt.svc) flows = flows.filter((f) => f.svc === opt.svc || f.svc.endsWith('.' + opt.svc));
if (opt.phase) flows = flows.filter((f) => f.phase === opt.phase);
if (!flows.length) {
  console.log(recordedPages === 0 ? 'No recorded pages in this log. Turn on "Record each page for replay tests" (Settings → Test mode, with page text on) and scan again.' : 'No flows match.');
  process.exit(0);
}

// ---------------------------------------------------------------- list (and write)
const brief = (p) => p.phase === 'probe' || p.classify ? `${p.classify?.pageKind ?? '?'}${p.classify?.hasPaidPlan ? ' · paid' : ''}` : `[${p.state}] ${p.action?.type}${p.action?.target ? ` "${String(p.action.target).slice(0, 40)}"` : ''}${p.action?.outcome ? ':' + p.action.outcome : ''}`;
console.log(`\n${flows.length} recorded flow(s) from ${run}\n`);
for (const f of flows) {
  const out = f.phase === 'probe' ? f.outcome?.status : f.outcome?.outcome;
  console.log(`  ${f.name.padEnd(22).slice(0, 22)} ${f.phase.padEnd(6)} ${String(f.pages.length).padStart(2)} page(s) → ${out ?? '–'}`);
  for (const p of f.pages) console.log(`      ${String(p.step ?? p.hop ?? '').padStart(2)} ${brief(p)}${p.reread ? ' (re-read)' : ''}  @ ${String(p.snapshot?.url || '').replace(/^https?:\/\//, '').slice(0, 70)}`);
}
if (!isDir && !opt['no-write']) {
  const dir = path.join(ROOT, 'flows', run);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of flows) fs.writeFileSync(path.join(dir, `${f.svc}.${f.phase}.json`), JSON.stringify(f, null, 2));
  console.log(`\nwritten → ${path.relative(ROOT, dir)}/ (git-ignored; holds scrubbed page text)`);
}
if (!opt.replay) { console.log('\nReplay against the current brain:  npm run flows -- ' + (isDir ? input : `flows/${run}`) + ' --replay   (mock, free)\n'); process.exit(0); }

// ---------------------------------------------------------------- replay
const brain = await import('../netlify/functions/lib/brain.mjs');
const { applyGuardrails, elementText, isFinalizeText, isCommitText, isPlanChangeText, actsOnCancel } = await import('../shared/guardrails.js');
let calls = 0, same = 0, changed = 0, unsafe = 0, skipped = 0;
const budget = () => !REAL || calls < MAX;
console.log(`\nREPLAY with the ${REAL ? `REAL model (at most ${MAX} calls)` : 'mock brain (free; it checks the guardrails on real pages, not the model)'}\n`);
for (const f of flows) {
  console.log(`  ${f.name} · ${f.phase}`);
  const history = [];
  for (const p of f.pages) {
    if (!budget()) { skipped++; continue; }
    const snap = p.snapshot;
    if (f.phase === 'probe') {
      calls++;
      const r = await brain.classify({ domain: f.svc, name: f.name, snapshot: snap, readiness: p.readiness ?? undefined });
      const was = p.classify || {}, keys = ['pageKind', 'signedIn', 'hasPaidPlan', 'monthlyPriceUsd', 'accountType', 'billedVia'];
      const diff = keys.filter((k) => (was[k] ?? null) !== (r[k] ?? null)).map((k) => `${k} ${JSON.stringify(was[k] ?? null)}→${JSON.stringify(r[k] ?? null)}`);
      diff.length ? changed++ : same++;
      console.log(`    hop ${p.hop ?? 0}  ${diff.length ? 'CHANGED  ' + diff.join(' · ') : 'same     ' + brief(p)}`);
      continue;
    }
    calls++;
    const step = p.step ?? history.length, sites = [f.svc, ...(p.siteDomains || [])];
    const maxSteps = f.maxSteps || 25;
    const proposed = await brain.decide({ merchant: { name: f.name, domain: f.svc, siteDomains: p.siteDomains || [] }, goal: f.phase, step, maxSteps, history, snapshot: snap, priorPath: null });
    const { decision } = applyGuardrails({ decision: proposed, snapshot: snap, history, merchantDomain: sites, step, maxSteps, goal: f.phase });
    const a = decision.action || {}, was = p.action || {};
    const el = a.id != null ? (snap.elements || []).find((e) => e.id === a.id) : null;
    const label = el ? elementText(el) : '';
    // What must never happen, judged by the primitive rules (not the guardrail composites under test): a click on a
    // finalize or commit label (pause, downgrade, buy…), or an offer recorded on one that also cancels or changes the plan.
    const isOffer = a.type === 'accept_offer' || (a.type === 'finish' && a.outcome === 'offer_found');
    const bad = !!label && ((a.type === 'click' && (isFinalizeText(label) || isCommitText(label)))
      || (isOffer && (isFinalizeText(label) || isCommitText(label) || isPlanChangeText(label) || actsOnCancel(label))));
    const movedOffer = isOffer && was.outcome === 'offer_found' && (a.id ?? null) !== (was.id ?? null);
    if (bad) unsafe++;
    const sameAct = a.type === was.type && (a.id ?? null) === (was.id ?? null);
    sameAct ? same++ : changed++;
    console.log(`    step ${String(step).padStart(2)}  ${bad ? 'UNSAFE   ' : movedOffer ? 'MOVED    ' : sameAct ? 'same     ' : 'CHANGED  '}${sameAct ? brief(p) : `${was.type}${was.target ? ` "${String(was.target).slice(0, 30)}"` : ''} → ${a.type}${label ? ` "${label.slice(0, 30)}"` : ''}${a.outcome ? ':' + a.outcome : ''}`}`);
    // Replay continues along the RECORDED path: later pages are what the recorded action led to.
    history.push({ step, url: snap.url, state: p.state, action: was, target: was.target ?? undefined, ok: p.ok ?? true, note: p.note ?? undefined });
  }
}
console.log(`\n${same} same · ${changed} changed · ${unsafe} unsafe${skipped ? ` · ${skipped} not replayed (--max=${MAX} reached)` : ''} · ${calls} ${REAL ? 'model' : 'mock'} call(s)`);
if (REAL) console.log('Real calls are billed: roughly $0.003 per walk step and $0.001 per account page at list prices.');
process.exit(unsafe ? 1 : 0);

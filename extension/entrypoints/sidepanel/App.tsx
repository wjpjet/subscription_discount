import { useEffect, useRef, useState } from 'react';
import { browser } from '#imports';
import { DEFAULTS, getSettings, saveSettings, type Settings } from '@/src/settings';
import { originsFor } from '@/src/discovery';
import { runScan, discardScan, reconcileOnLoad, isBusy, PAYING, NEEDS_LOOK, type ScanItem, type ScanProgress, type ScanResult } from '@/src/scan';
import { dealLine, paidSubLine, groupReveal, alsoLabel, countLine, bucketLine, monthlyOf, type StatusSets } from '@/src/saving';
import { acceptAll, requestStop, releasePaused, type HuntEvent, type HuntResult, type HuntStep } from '@/src/hunt';
import { startCheckout, waitForCheckout, settle } from '@/src/payment';
import { focusTab } from '@/src/tabs';
import { money, outcomeLabel, keptLabel, hostLabel } from '@/src/format';
import type { CheckoutResult, Settlement } from '@/src/types';
import { traceStart, traceEnd, trace, lastLog, downloadLog, maskForLog, redactForLog } from '@/src/trace';

type Screen = 'idle' | 'consent' | 'scanning' | 'reveal' | 'checkout' | 'hunting' | 'done' | 'settings' | 'error';
const SITE = ((import.meta as any).env?.WXT_API_BASE || '').replace(/\/+$/, '');
const PRIVACY_URL = (SITE || 'https://walkaway.netlify.app') + '/privacy.html';
interface HuntState { current: ScanItem | null; tabId: number | null; log: HuntStep[]; results: HuntResult[]; total: number; verifying: boolean; settlement: Settlement | null }
const EMPTY_HUNT: HuntState = { current: null, tabId: null, log: [], results: [], total: 0, verifying: false, settlement: null };
const SETS: StatusSets = { paying: PAYING, needsLook: NEEDS_LOOK };

// Chrome gives every window its own side panel, so two panels could scan at once, and a panel opening while
// another is mid-scan must not sweep that scan's live tabs as orphans. One run at a time, held by a Web Lock:
// Chrome releases it by itself when the holding panel closes or reloads, so a crash can't leave it stuck.
const RUN_LOCK = 'walkaway-run';
const BUSY_ELSEWHERE = 'Walkaway is already running in another window. Let it finish there, then try again.';
const hasLocks = () => typeof navigator !== 'undefined' && 'locks' in navigator;
/** Run fn holding the lock; false (without running it) when another panel holds it. */
async function runExclusive(fn: () => Promise<void>): Promise<boolean> {
  if (!hasLocks()) { await fn(); return true; }
  return navigator.locks.request(RUN_LOCK, { ifAvailable: true }, async (lock) => { if (!lock) return false; await fn(); return true; });
}
/** No panel in any window is scanning or hunting right now. */
async function runIdle(): Promise<boolean> {
  if (!hasLocks()) return true;
  try { return await navigator.locks.request(RUN_LOCK, { ifAvailable: true }, async (lock) => lock != null); } catch { return true; }
}
/** Where "Open" goes: the page the scan landed on, else the account URL. Web pages only (never a chrome-error:// page). */
const openUrl = (i: ScanItem) => [i.url, i.accountUrl].find((u) => !!u && /^https?:\/\//i.test(u)) || '';

export default function App() {
  const [screen, setScreen] = useState<Screen>('idle');
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkoutMsg, setCheckoutMsg] = useState('');
  const [hunt, setHunt] = useState<HuntState>(EMPTY_HUNT);
  const [consented, setConsented] = useState<boolean>(false);
  const [excluded, setExcluded] = useState<string[]>([]);   // services the user unticked on the reveal screen
  const returnTo = useRef<Screen>('idle');
  const cancelCheckout = useRef(false);

  useEffect(() => {
    (async () => {
      setSettings(await getSettings());
      const v = await browser.storage.local.get(['scanResult', 'huntResults', 'previewHunt', 'consentAt']);
      setConsented(!!v.consentAt);
      if (v.huntResults) setHunt((h) => ({ ...h, results: v.huntResults as HuntResult[] }));
      // Before showing a saved scan: close tabs a panel closed mid-scan left behind, and drop handles to paused
      // tabs that are no longer ours (tab ids are reused after a browser restart). Skipped while another
      // window's panel is running: its tabs are live, not orphans.
      const saved = (v.scanResult as ScanResult | undefined) ?? null;
      const r = (await runIdle()) ? await reconcileOnLoad(saved).catch(() => saved) : saved;
      if (r) { setResult(r); setScreen('reveal'); }
      // Design previews only (sidepanel.html?preview=…); never used in the real flow.
      const pv = new URLSearchParams(location.search).get('preview');
      if (pv === 'settings') setScreen('settings');
      else if (pv === 'consent') setScreen('consent');
      else if (pv === 'done' && v.huntResults) setScreen('done');
      else if (pv === 'hunting' && v.previewHunt) { setHunt(v.previewHunt as HuntState); setScreen('hunting'); }
    })();
  }, []);

  async function startScan() {
    setError(null);
    if (!consented) { setScreen('consent'); return; }
    try {
      const s = await getSettings(); setSettings(s);
      const origins = originsFor(s);
      if (!(await browser.permissions.contains({ origins }))) {
        const ok = await browser.permissions.request({ origins });
        if (!ok) { setError("Walkaway needs permission to check which sites you're signed into. Nothing runs without it."); return; }
      }
      await scanNow(s);
    } catch (e: any) { setError(String(e?.message || e)); setScreen('error'); }
  }
  /** Run a scan; in test mode, record everything about it. */
  async function scanNow(s: Settings) {
    const ran = await runExclusive(async () => {
      setScreen('scanning'); setProgress({ phase: 'discover', done: 0, total: 0, message: 'Starting…', items: [], totalEstSavings: 0 });
      if (s.testMode) await traceStart(await runMeta(s), { pageText: s.testPageText });
      try {
        const r = await runScan(s, setProgress);
        if (s.testMode) await traceEnd(scanSummary(r));
        setResult(r); setScreen('reveal');
      } catch (e: any) {
        if (s.testMode) { trace('run.error', { error: String(e?.message || e), stack: String(e?.stack || '').slice(0, 1500) }); await traceEnd({ error: String(e?.message || e) }); }
        throw e;
      }
    });
    if (!ran) { setError(BUSY_ELSEWHERE); setScreen('idle'); }
  }
  async function agreeAndScan() {
    await browser.storage.local.set({ consentAt: Date.now() });
    setConsented(true);
    setError(null);
    try {
      const s = await getSettings(); setSettings(s);
      const origins = originsFor(s);
      if (!(await browser.permissions.contains({ origins }))) {
        const ok = await browser.permissions.request({ origins });
        if (!ok) { setError("Walkaway needs permission to check which sites you're signed into. Nothing runs without it."); setScreen('idle'); return; }
      }
      await scanNow(s);
    } catch (e: any) { setError(String(e?.message || e)); setScreen('error'); }
  }
  async function rescan() {
    // Another window may be accepting from this very result: leave it (and its tabs) alone.
    if (!(await runIdle())) { setError(BUSY_ELSEWHERE); setScreen('error'); return; }
    await discardScan(result); setResult(null); setHunt(EMPTY_HUNT); setExcluded([]); await startScan();
  }
  const toggle = (id: string) => setExcluded((x) => (x.includes(id) ? x.filter((v) => v !== id) : [...x, id]));
  /** Test mode: close the tabs held on offer screens. Only tabs still ours on the same site are closed; nothing is clicked. */
  async function releaseHeld() {
    if (!result) return;
    for (const i of result.items) if (i.paused) await releasePaused(i);
    const r = { ...result, items: [...result.items] };
    setResult(r); await browser.storage.local.set({ scanResult: r });
  }

  async function startHunt() {
    if (!result) return;
    const s = await getSettings(); setSettings(s);
    if (s.testMode) return;   // test mode never accepts an offer and never charges
    const ran = await runExclusive(() => huntNow(s, result));
    if (!ran) { setError(BUSY_ELSEWHERE); setScreen('error'); }
  }
  async function huntNow(s: Settings, result: ScanResult) {
    // The services still ticked (all are ticked by default), best offer first, capped. Every figure was observed during the scan.
    const offers = result.items.filter((i) => i.hasOffer);
    const targets = offers.filter((i) => !excluded.includes(i.id)).slice(0, Math.max(1, s.maxHunts || 10));
    const skipped = offers.filter((i) => !targets.includes(i));
    const estimate = +targets.reduce((sum, i) => sum + i.estSavings, 0).toFixed(2);
    setError(null); setHunt({ ...EMPTY_HUNT, total: targets.length });
    // Tabs paused on offers the user did not pick are closed (only if still ours). Nothing is clicked in them.
    for (const i of skipped) await releasePaused(i);

    let pay: CheckoutResult | null = null;
    if (!s.skipPayment) {
      try {
        cancelCheckout.current = false;
        setScreen('checkout'); setCheckoutMsg('Opening secure checkout…');
        const { sessionId, url } = await startCheckout(estimate);
        await browser.tabs.create({ url, active: true });
        pay = await waitForCheckout(sessionId, (m) => { if (cancelCheckout.current) throw new Error('Checkout cancelled — nothing was charged.'); setCheckoutMsg(m); });
      } catch (e: any) { setError(String(e?.message || e)); setScreen('error'); return; }
    }

    setScreen('hunting');
    const onEvent = (e: HuntEvent) => {
      if (e.type === 'start') setHunt((h) => ({ ...h, current: e.item, tabId: e.tabId, log: [], verifying: false }));
      else if (e.type === 'step') setHunt((h) => ({ ...h, log: [...h.log, e.step].slice(-40) }));
      else if (e.type === 'verify') setHunt((h) => ({ ...h, verifying: true }));
      else if (e.type === 'done') setHunt((h) => ({ ...h, results: [...h.results, e.result], verifying: false }));
    };
    try {
      const results = await acceptAll(targets, s, onEvent);
      await browser.storage.local.set({ huntResults: results, scanResult: result });   // the paused tabs were consumed; persist that
      let settlement: Settlement | null = null;
      if (pay) {
        // Charged now, and only now: 15% of what the billing pages actually showed.
        const verified = results.reduce((sum, r) => sum + (r.outcome === 'discount_applied' ? (r.savingsUsd || 0) : 0), 0);
        settlement = await settle(pay, verified, estimate).catch((e: any) => ({ feeCents: 0, estimatedFeeCents: 0, adjusted: false, charged: false, error: String(e?.message || e) }));
      }
      setHunt((h) => ({ ...h, settlement }));
      setScreen('done');
    } catch (e: any) { setError(String(e?.message || e)); setScreen('error'); }
  }

  const modeLabel = settings.testMode ? (settings.testFind ? 'Test mode · finds offers' : 'Test mode · read-only') : settings.restrictedMode ? 'Restricted mode' : null;
  const right: Record<Screen, string> = { consent: 'Before we start', idle: modeLabel || 'Free to scan', scanning: settings.testMode ? 'Scanning · logging' : 'Scanning…', reveal: modeLabel || 'Scan complete', checkout: 'Checkout', hunting: 'Hunting…', done: 'Done', settings: 'Settings', error: 'Something went wrong' };
  const openSettings = () => { returnTo.current = screen === 'settings' ? 'idle' : screen; setScreen('settings'); };

  return (
    <div className="panel">
      <div className="top">
        <span className="mark" aria-hidden="true"><svg viewBox="0 0 64 64" fill="none" stroke="#0E1116" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"><path d="M18 32h24M32 20l12 12-12 12" /></svg></span>
        Walkaway
        <span className="r">{right[screen]}</span>
        <button className="gear" title="Settings" onClick={openSettings} aria-label="Settings">⚙</button>
      </div>
      {screen === 'idle' && <Idle onScan={startScan} error={error} restricted={settings.restrictedMode} testMode={settings.testMode} testFind={settings.testFind} />}
      {screen === 'consent' && <Consent onAgree={agreeAndScan} onBack={() => setScreen('idle')} />}
      {screen === 'scanning' && <Scanning progress={progress} />}
      {screen === 'reveal' && result && <Reveal result={result} excluded={excluded} onToggle={toggle} onHunt={startHunt} onRescan={rescan} onRelease={releaseHeld} restricted={settings.restrictedMode} skipPayment={settings.skipPayment} testMode={settings.testMode} testFind={settings.testFind} />}
      {screen === 'checkout' && <Checkout msg={checkoutMsg} onCancel={() => { cancelCheckout.current = true; }} />}
      {screen === 'hunting' && <Hunting hunt={hunt} watch={settings.watch} />}
      {screen === 'done' && <Done hunt={hunt} onRescan={rescan} onAgain={startHunt} />}
      {screen === 'settings' && <SettingsScreen settings={settings} onSave={async (p) => { const n = await saveSettings(p); setSettings(n); setScreen(returnTo.current); }} onCancel={() => setScreen(returnTo.current)} />}
      {screen === 'error' && <ErrorScreen error={error} onRetry={startScan} onSettings={openSettings} />}
    </div>
  );
}

function Idle({ onScan, error, restricted, testMode, testFind }: { onScan: () => void; error: string | null; restricted: boolean; testMode: boolean; testFind: boolean }) {
  return (
    <div className="body">
      <h1>Find your <em>loyalty discounts.</em></h1>
      {testMode && <p className="testnote"><b>Test mode.</b> {testFind ? 'It will walk each cancellation flow up to the offer and stop there.' : 'Read-only: it reads account pages and opens no cancellation flow.'} Nothing is accepted and nothing is charged. Everything is logged; download the log when it finishes.{restricted ? ' Restricted mode is on, so only allowlisted sites are scanned.' : ''}</p>}
      <p>{restricted ? 'Restricted mode: only the sites in your allowlist are scanned and hunted.' : "We'll check which subscription services you're signed into — locally in your browser, sending only the site names to identify subscriptions — and show you what you could save on your upcoming renewals."}</p>
      {error && <p className="err">{error}</p>}
      <div className="spacer" />
      <button className="btn" onClick={onScan}>Scan my subscriptions</button>
      <p className="fine">Takes about a minute. No passwords, cookies, or history are ever uploaded. Nothing gets cancelled — ever.</p>
    </div>
  );
}

function Consent({ onAgree, onBack }: { onAgree: () => void; onBack: () => void }) {
  return (
    <div className="body">
      <h1>Before we <em>start.</em></h1>
      <p>Here's exactly what Walkaway does with your data. Please read it, then agree to continue.</p>
      <ul className="consent">
        <li><b>Finding subscriptions:</b> it checks which sites you're signed into by looking at cookie <i>names</i> on this device. Cookie values, passwords, and your browsing history never leave your browser.</li>
        <li><b>Sent to our AI service:</b> the names of those sites, and the text of the account and cancellation pages it works on, so it can decide what to click. Nothing else.</li>
        <li><b>Acting on your behalf:</b> it opens those sites in background tabs and goes through their cancellation flows to reach the loyalty offer. It cannot press a final “confirm cancellation.”</li>
        <li><b>Payment:</b> if you continue to checkout, Stripe saves your card and email. Nothing is charged until the run is done; then 15% of what was actually saved.</li>
      </ul>
      <p className="fine left">We don't sell data or use it for ads. Full details: <a href={PRIVACY_URL} target="_blank" rel="noreferrer">privacy policy</a>.</p>
      <div className="spacer" />
      <button className="btn" onClick={onAgree}>I agree — scan my subscriptions</button>
      <button className="btn ghost" onClick={onBack}>Not now</button>
    </div>
  );
}

function Scanning({ progress }: { progress: ScanProgress | null }) {
  const phase = progress?.phase ?? 'discover';
  const items = progress?.items ?? [];
  const offers = items.filter((i) => i.hasOffer);
  // Only rows worth watching: being read or walked, paying, or holding an offer. Everything else is counted
  // in one line, so the list doesn't fill up with sign-in pages.
  const shown = items.filter((i) => i.hasOffer || isBusy(i) || PAYING.includes(i.status));
  const rest = bucketLine(items.filter((i) => !shown.includes(i)), SETS);
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 5;
  const headline = phase === 'discover' ? (progress?.message || 'Discovering…')
    : phase === 'pages' ? `Checking accounts · ${progress!.done} of ${progress!.total}`
    : phase === 'find' ? `Looking for offers · ${progress!.done} of ${progress!.total}`
    : 'Almost done…';
  return (
    <div className="body">
      <div className="prog"><i style={{ width: `${Math.max(5, pct)}%` }} /></div>
      <div className="count">{headline}</div>
      {offers.length > 0 && <div className="total"><small>Found so far</small><b>~{money(progress!.totalEstSavings)}</b><span>{offers.length} offer{offers.length === 1 ? '' : 's'} · more may appear as the scan continues.</span></div>}
      {shown.length > 0 && (
        <div className="card">
          {shown.map((i) => (
            <div className={`row col scan${i.hasOffer ? ' won' : ''}`} key={i.id}>
              <div className="rowline"><span className="nm">{i.name}</span>{i.hasOffer ? <b className="amt">~{money(i.estSavings)}</b> : <span className={`tag ${isBusy(i) ? 'busy' : 'skip'}`}>{isBusy(i) ? 'working' : keptLabel(i)}</span>}</div>
              <span className={`sub${i.hasOffer ? ' offer' : ''}`} title={i.live || undefined}>{i.live || <>&nbsp;</>}</span>
            </div>
          ))}
        </div>
      )}
      {rest && <p className="buckets">{rest}</p>}
      <p className="fine left">{phase === 'find'
        ? 'This is the slow part: it walks each cancellation flow up to the loyalty offer and stops there, three services at a time. Nothing is accepted yet.'
        : phase === 'pages' ? 'Account pages open briefly in background tabs and close on their own.'
        : "Only the names of sites you're signed into leave your browser at this step."}</p>
    </div>
  );
}

/**
 * The result, in the order the owner acts on it: the total, the offers (tick what to take), what they pay
 * for, what needs a look (one click to open it), then folded groups for everything left alone. Duplicates
 * are hidden; their names show as "also: …" on the row they were merged into.
 */
function Reveal({ result, excluded, onToggle, onHunt, onRescan, onRelease, restricted, skipPayment, testMode, testFind }: { result: ScanResult; excluded: string[]; onToggle: (id: string) => void; onHunt: () => void; onRescan: () => void; onRelease: () => void; restricted: boolean; skipPayment: boolean; testMode: boolean; testFind: boolean }) {
  const [details, setDetails] = useState(false);
  const g = groupReveal(result.items, SETS);
  const found = result.items.filter((i) => PAYING.includes(i.status)).length;
  const offers = g.offers;
  const picked = offers.filter((i) => !excluded.includes(i.id));
  const total = Math.round(picked.reduce((s, i) => s + i.estSavings, 0));
  // Say "not checked" when no cancellation flow was opened, never "0 made an offer".
  const readOnly = result.items.some((i) => i.findOutcome === 'not_walked') || (testMode && !testFind);
  const walked = result.items.some((i) => i.findOutcome != null && i.findOutcome !== 'not_walked');
  const also = (i: ScanItem) => alsoLabel(i, result.items);
  const who = (i: ScanItem) => i.email || i.accountName || '';
  const workLine = (i: ScanItem) => [who(i), (i.live || '').replace(/^work account\s*[—–-]\s*/i, '')].filter(Boolean).join(' · ');
  return (
    <div className="body">
      {found === 0 ? (
        <>
          <h1>Nothing found <em>yet.</em></h1>
          <p>{restricted ? "None of the allowlisted sites showed a paid plan you're signed into." : `We checked ${result.domainsChecked} sites you're signed into and didn't confirm a paid subscription we can work with.`} {g.needsLook.length ? 'Some need a look — open them below to check.' : 'Sign in to a service in this browser, then rescan.'}</p>
        </>
      ) : (
        <>
          {offers.length > 0 && <div className="total"><small>{picked.length === offers.length ? 'You could save' : `${picked.length} of ${offers.length} picked · you could save`}</small><b>~{money(total)}</b><span>on your next bills, without cancelling anything.</span></div>}
          <div className="count">{countLine(found, offers.length, { readOnly, walked })}</div>
          {offers.length > 0 && <div className="card">
            {offers.map((i) => { const on = !excluded.includes(i.id); const a = also(i); return (
              <label className={`row pick${on ? '' : ' off'}`} key={i.id}>
                <input type="checkbox" checked={on} onChange={() => onToggle(i.id)} aria-label={`Include ${i.name}`} />
                <div className="rowmain">
                  <div className="rowline"><span>{i.name}</span><b className="amt">~{money(i.estSavings)}</b></div>
                  {(who(i) || i.otherAccount) && <span className="sub who">{who(i) && `Signed in as ${who(i)}`}{i.otherAccount && <span className="chip">other account</span>}</span>}
                  <span className="sub deal">{dealLine(i)}</span>
                  {a && <span className="sub also">{a}</span>}
                </div>
              </label>
            ); })}
          </div>}
          {g.paying.length > 0 && <>
            <div className="sect">Paying</div>
            <div className="card">
              {g.paying.map((i) => { const sub = paidSubLine(i); const a = also(i); return (
                <div className="row col" key={i.id} title={i.live || undefined}>
                  <div className="rowline"><span className="nm">{i.name}</span><span className="tag skip">{keptLabel(i)}</span></div>
                  {(sub || i.otherAccount) && <span className="sub">{sub}{i.otherAccount && <span className="chip">other account</span>}</span>}
                  {a && <span className="sub also">{a}</span>}
                </div>
              ); })}
            </div>
          </>}
        </>
      )}
      {g.needsLook.length > 0 && <>
        <div className="sect">Needs a look ({g.needsLook.length})</div>
        <div className="card">
          {g.needsLook.map((i) => (
            <div className="row col" key={i.id}>
              <div className="rowline"><span className="nm">{i.name}</span><OpenLink item={i} /></div>
              <span className="sub">{[i.live || keptLabel(i), who(i), also(i)].filter(Boolean).join(' · ')}</span>
            </div>
          ))}
        </div>
      </>}
      <Folded title="Work accounts" items={g.work} line={workLine} also={also} />
      <Folded title="Free plans" items={g.free} line={(i) => [i.planName ?? i.before?.planName, who(i)].filter(Boolean).join(' · ')} also={also} />
      <Folded title="Signed out — sign in, then rescan" items={g.signedOut} line={() => ''} also={also} openLinks />
      <Folded title="Skipped (sensitive)" items={g.sensitive} line={(i) => i.note || ''} also={also} />
      <div className="spacer" />
      {testMode ? (<>
        <button className="btn" onClick={async () => { const l = await lastLog(); if (l) downloadLog(l); }}>Download test log</button>
        {result.items.some((i) => i.paused) && <button className="btn ghost" onClick={onRelease}>Close the tabs held on offers</button>}
        <p className="fine">Test mode: nothing was accepted and nothing will be charged. The tabs held on offer screens are real; leave them or close them.</p>
      </>) : (<>
        <button className="btn" onClick={onHunt} disabled={picked.length === 0}>Get these discounts →</button>
        <p className="fine">{skipPayment ? 'Payment skipped (testing). ' : 'No charge now. After the run: 15% of what was actually saved, $0 if nothing. '}It cannot press “confirm cancellation” — that action doesn't exist in its toolset.</p>
      </>)}
      <p className="links"><a onClick={onRescan}>Rescan</a> · <a onClick={() => setDetails(!details)}>{details ? 'Hide' : 'Show'} details</a></p>
      {details && <DevTable items={result.items} />}
    </div>
  );
}
/** A folded group of rows left alone (native <details>, closed by default). `openLinks` adds an Open link per row. */
function Folded({ title, items, line, also, openLinks }: { title: string; items: ScanItem[]; line: (i: ScanItem) => string; also: (i: ScanItem) => string; openLinks?: boolean }) {
  if (!items.length) return null;
  return (
    <details className="grp">
      <summary>{title} <span className="n">({items.length})</span></summary>
      <div className="card">
        {items.map((i) => { const sub = [line(i), also(i)].filter(Boolean).join(' · '); return (
          <div className="row col skip" key={i.id}>
            <div className="rowline"><span className="nm">{i.name}</span>{openLinks && <OpenLink item={i} />}</div>
            {sub && <span className="sub">{sub}</span>}
          </div>
        ); })}
      </div>
    </details>
  );
}
/** Opens the page in a new tab in front, so the owner can check it (or sign in) in one click. */
function OpenLink({ item }: { item: ScanItem }) {
  const url = openUrl(item);
  if (!url) return null;
  return <a className="open" href={url} target="_blank" rel="noreferrer" onClick={(e) => { e.preventDefault(); void browser.tabs.create({ url, active: true }); }}>Open ↗</a>;
}

function Checkout({ msg, onCancel }: { msg: string; onCancel: () => void }) {
  return (
    <div className="body">
      <h1>Save a card. <em>Nothing is charged yet.</em></h1>
      <p>A secure Stripe page opened in a new tab. Your card is saved there and not charged. After the run you pay 15% of what we actually saved you — if some services don't make an offer, the charge goes down with them. $0 if none do.</p>
      <p className="fine left">{msg}</p>
      <div className="spacer" />
      <button className="btn ghost" onClick={onCancel}>Cancel</button>
    </div>
  );
}

function Hunting({ hunt, watch }: { hunt: HuntState; watch: boolean }) {
  const done = hunt.results.length, total = hunt.total || 1;
  return (
    <div className="body">
      <div className="prog"><i style={{ width: `${Math.max(4, Math.round((done / total) * 100))}%` }} /></div>
      <div className="count">{hunt.current ? `${hunt.verifying ? 'Verifying' : 'Accepting'} ${Math.min(done + 1, hunt.total)} of ${hunt.total} — ${hunt.current.name}` : 'Starting…'}</div>
      <div className="log">
        {hunt.log.slice(-10).map((s) => (
          <div className={`step ${s.action.type === 'back_out' ? 'warn' : s.action.type === 'finish' ? 'done' : 'now'}`} key={s.step}>
            <div className="dot">{s.step}</div>
            <div><b>{s.state.replace(/_/g, ' ')}</b><span>{s.action.type}{s.target ? ` → “${s.target.slice(0, 50)}”` : ''}{s.guardrails && s.guardrails.length ? ` · ⛔ ${s.guardrails[0]}` : ''}</span></div>
          </div>
        ))}
        {hunt.log.length === 0 && <p className="fine left">Accepting the offer that was found…</p>}
      </div>
      <div className="spacer" />
      {hunt.tabId != null && <button className="btn ghost" onClick={() => focusTab(hunt.tabId!)}>Watch this tab</button>}
      <button className="btn ghost" onClick={requestStop}>Stop after this one</button>
      <p className="note">{watch ? 'Watch mode: the tab is in front.' : 'Runs in a background tab — keep doing what you were doing.'} On anything ambiguous, it backs out.</p>
    </div>
  );
}

function Done({ hunt, onRescan, onAgain }: { hunt: HuntState; onRescan: () => void; onAgain: () => void }) {
  const results = hunt.results;
  const total = results.reduce((s, r) => s + (r.outcome === 'discount_applied' ? (r.savingsUsd || 0) : 0), 0);
  const wins = results.filter((r) => r.outcome === 'discount_applied').length;
  const missed = results.length - wins;
  const st = hunt.settlement;
  const payment = !st ? null
    : st.error ? `Payment: ${st.error}`
    : st.charged ? <>Charged {money(st.feeCents / 100)}{st.adjusted ? <> — adjusted down from about {money(st.estimatedFeeCents / 100)}, because {missed} of {results.length} didn't come through</> : ' (15% of verified savings)'}. {st.receiptUrl && <a href={st.receiptUrl} target="_blank" rel="noreferrer">Receipt</a>}</>
    : st.waived ? `No charge — 15% came to ${money(st.feeCents / 100)}, less than a card can be charged, so it's on us.`
    : st.needsAction ? 'Your bank needs to authenticate this charge — we will follow up by email.'
    : 'No charge — nothing was verified, so your card was not used.';
  return (
    <div className="body">
      <h1>{wins ? <>You're paying <em>{money(total)} less</em> on your upcoming renewals.</> : <>No discounts <em>this time.</em></>}</h1>
      <div className="card">
        {results.map((r) => (
          <div className="row col" key={r.domain}>
            <div className="rowline">{r.name}<span className={`tag ${r.outcome === 'discount_applied' ? 'ok' : 'skip'}`}>{outcomeLabel(r.outcome)}</span></div>
            <span className="sub">{r.outcome === 'discount_applied' ? `${money(r.before?.monthlyPriceUsd ?? null)}/mo → ${money(r.after?.monthlyPriceUsd ?? null)}/mo${r.termMonths ? ` for ${r.termMonths} months` : ''} · saves ${money(r.savingsUsd)}` : (r.reason || 'No offer was made, so it was left alone.')}</span>
          </div>
        ))}
      </div>
      <p className="sub">Nothing was cancelled. {payment}</p>
      <div className="spacer" />
      <button className="btn ghost" onClick={onAgain}>Run again</button>
      <p className="links"><a onClick={onRescan}>Rescan</a></p>
    </div>
  );
}

function SettingsScreen({ settings, onSave, onCancel }: { settings: Settings; onSave: (p: Partial<Settings>) => void; onCancel: () => void }) {
  const [s, setS] = useState<Settings>(settings);
  const f = (k: keyof Settings) => ({ value: String(s[k] ?? ''), onChange: (e: any) => setS({ ...s, [k]: (k === 'maxSteps' || k === 'maxHunts') ? Number(e.target.value) : e.target.value }) });
  return (
    <div className="body form">
      <h1>Settings</h1>
      <label>API URL <span className="hint">your backend, e.g. https://walkaway.you.workers.dev</span><input {...f('apiBase')} placeholder="https://…workers.dev" /></label>
      <label>Client key <span className="hint">only if WALKAWAY_CLIENT_KEY is set on the backend</span><input {...f('clientKey')} /></label>
      <label className="check"><input type="checkbox" checked={s.restrictedMode} onChange={(e) => setS({ ...s, restrictedMode: e.target.checked })} /> Restricted mode — scan and hunt <b>only</b> allowlisted sites (allowlist.json + below)</label>
      <label>Extra allowed sites <span className="hint">one per line: domain | name | account URL</span><textarea rows={3} value={s.extraAllow} onChange={(e) => setS({ ...s, extraAllow: e.target.value })} placeholder="streamly-testbed.netlify.app | Streamly | https://streamly-testbed.netlify.app/settings/subscription" /></label>
      <label>Never explore <span className="hint">one domain per line; also blocklist.json. Applies in every mode. Banks, government, health, insurance and payroll sites are always skipped, without needing to be listed.</span><textarea rows={2} value={s.extraBlock} onChange={(e) => setS({ ...s, extraBlock: e.target.value })} placeholder="bank.com" /></label>
      <label className="check"><input type="checkbox" checked={s.skipPayment} onChange={(e) => setS({ ...s, skipPayment: e.target.checked })} /> Skip payment — no card, no fee (testing only)</label>
      <label className="check"><input type="checkbox" checked={s.watch} onChange={(e) => setS({ ...s, watch: e.target.checked })} /> Watch mode — open the hunt tab in front and leave it open</label>
      <label>Max services per run <span className="hint">highest estimated savings first</span><input type="number" min={1} max={30} {...f('maxHunts')} /></label>
      <label>Max steps per service<input type="number" min={5} max={40} {...f('maxSteps')} /></label>
      <h2 className="settings-h">Test mode</h2>
      <label className="check"><input type="checkbox" checked={s.testMode} onChange={(e) => setS({ ...s, testMode: e.target.checked })} /> Test mode — scan and log everything; never accept an offer, never charge</label>
      <label className="check"><input type="checkbox" checked={s.testFind} disabled={!s.testMode} onChange={(e) => setS({ ...s, testFind: e.target.checked })} /> Also walk cancellation flows to find offers <span className="hint">off = read-only: account pages only, no cancellation flow opened</span></label>
      <label className="check"><input type="checkbox" checked={s.testPageText} disabled={!s.testMode} onChange={(e) => setS({ ...s, testPageText: e.target.checked })} /> Include page text in the log <span className="hint">helps find bugs; may contain your name or address; long numbers are removed</span></label>
      <button className="btn ghost" onClick={async () => { const l = await lastLog(); if (l) downloadLog(l); else alert('No test log yet. Turn on test mode and run a scan.'); }}>Download last test log</button>
      <div className="spacer" />
      <button className="btn" onClick={() => onSave(s)}>Save</button>
      <button className="btn ghost" onClick={onCancel}>Cancel</button>
    </div>
  );
}

function ErrorScreen({ error, onRetry, onSettings }: { error: string | null; onRetry: () => void; onSettings: () => void }) {
  return (
    <div className="body">
      <h1>Hmm.</h1>
      <p className="err">{error ?? 'Something went wrong.'}</p>
      <div className="spacer" />
      <button className="btn" onClick={onRetry}>Try again</button>
      <button className="btn ghost" onClick={onSettings}>Open settings</button>
    </div>
  );
}

/** Every row, raw: where the probe landed, what kind of page the classifier saw and how sure it was. Hover for its notes. */
function DevTable({ items }: { items: ScanItem[] }) {
  return (
    <table className="dev">
      <thead><tr><th>service</th><th>status</th><th>landed on</th><th>page · conf</th><th>$/mo</th></tr></thead>
      <tbody>{items.map((i) => {
        const m = monthlyOf(i), conf = i.before?.confidence;
        const notes = [i.note, i.before?.notes].filter((x, k, a): x is string => !!x && a.indexOf(x) === k).join(' — ');
        return (<tr key={i.id} title={notes || undefined}><td>{i.name}</td><td>{i.status}</td><td>{hostLabel(i.url) || '–'}</td><td>{[i.pageKind || '–', conf != null ? conf.toFixed(1) : ''].filter(Boolean).join(' · ')}</td><td>{m != null ? m.toFixed(2) : '–'}</td></tr>);
      })}</tbody>
    </table>
  );
}

/** Everything about the environment that could explain a surprise in the log. */
async function runMeta(s: Settings): Promise<Record<string, unknown>> {
  const conn: any = (navigator as any).connection;
  const { clientKey, ...safe } = s;
  return {
    extensionVersion: browser.runtime.getManifest().version, settings: { ...safe, clientKey: clientKey ? '(set)' : '' },
    userAgent: navigator.userAgent, language: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    network: conn ? { effectiveType: conn.effectiveType, downlinkMbps: conn.downlink, rttMs: conn.rtt, saveData: conn.saveData } : null,
    startedAtLocal: new Date().toString(),
  };
}
/** The result in one object: counts, what the reveal screen showed, and one compact row per service. Emails masked, notes redacted. */
function scanSummary(r: ScanResult): Record<string, unknown> {
  const by = (xs: string[]) => xs.reduce((o: Record<string, number>, x) => { o[x] = (o[x] || 0) + 1; return o; }, {});
  const g = groupReveal(r.items, SETS);
  return {
    domainsChecked: r.domainsChecked, found: r.found, needsLook: r.needsLook, withOffers: r.withOffers, totalEstSavings: r.totalEstSavings,
    byStatus: by(r.items.map((i) => i.status)), byFindOutcome: by(r.items.map((i) => i.findOutcome || '-')),
    reveal: { offers: g.offers.length, paying: g.paying.length, needsLook: g.needsLook.length, work: g.work.length, free: g.free.length, signedOut: g.signedOut.length, sensitive: g.sensitive.length, duplicates: g.duplicates.length },
    services: r.items.map((i) => ({ domain: i.domain, name: i.name, status: i.status, pageKind: i.pageKind, billedVia: i.billedVia, email: maskForLog(i.email), rememberedEmail: maskForLog(i.rememberedEmail), otherAccount: i.otherAccount, dupOf: i.dupOf, aliases: i.aliases, planName: i.planName, monthlyPrice: i.monthlyPrice, cycleCharge: i.cycleCharge, cadence: i.cadence, renewalDate: i.renewalDate, isTrial: i.isTrial, offerApplied: i.offerApplied, findOutcome: i.findOutcome, offer: i.offer, estSavings: i.estSavings, deal: i.hasOffer ? dealLine(i) : null, note: i.note ? redactForLog(i.note).slice(0, 300) : null })),
  };
}

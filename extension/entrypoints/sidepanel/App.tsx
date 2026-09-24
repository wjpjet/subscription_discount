import { useEffect, useRef, useState } from 'react';
import { browser } from '#imports';
import { DEFAULTS, getSettings, saveSettings, type Settings } from '@/src/settings';
import { originsFor } from '@/src/discovery';
import { runScan, discardScan, savingLines, isBusy, type ScanItem, type ScanProgress, type ScanResult } from '@/src/scan';
import { acceptAll, requestStop, type HuntEvent, type HuntResult, type HuntStep } from '@/src/hunt';
import { startCheckout, waitForCheckout, settle } from '@/src/payment';
import { focusTab, closeTab } from '@/src/tabs';
import { money, outcomeLabel } from '@/src/format';
import type { CheckoutResult, Settlement } from '@/src/types';

type Screen = 'idle' | 'consent' | 'scanning' | 'reveal' | 'checkout' | 'hunting' | 'done' | 'settings' | 'error';
const SITE = ((import.meta as any).env?.WXT_API_BASE || '').replace(/\/+$/, '');
const PRIVACY_URL = (SITE || 'https://walkaway.netlify.app') + '/privacy.html';
interface HuntState { current: ScanItem | null; tabId: number | null; log: HuntStep[]; results: HuntResult[]; total: number; verifying: boolean; settlement: Settlement | null }
const EMPTY_HUNT: HuntState = { current: null, tabId: null, log: [], results: [], total: 0, verifying: false, settlement: null };

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
      if (v.scanResult) { setResult(v.scanResult as ScanResult); setScreen('reveal'); }
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
      setScreen('scanning'); setProgress({ phase: 'discover', done: 0, total: 0, message: 'Starting…', items: [], totalEstSavings: 0 });
      const r = await runScan(s, setProgress);
      setResult(r); setScreen('reveal');
    } catch (e: any) { setError(String(e?.message || e)); setScreen('error'); }
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
      setScreen('scanning'); setProgress({ phase: 'discover', done: 0, total: 0, message: 'Starting…', items: [], totalEstSavings: 0 });
      const r = await runScan(s, setProgress);
      setResult(r); setScreen('reveal');
    } catch (e: any) { setError(String(e?.message || e)); setScreen('error'); }
  }
  async function rescan() { await discardScan(result); setResult(null); setHunt(EMPTY_HUNT); setExcluded([]); await startScan(); }
  const toggle = (id: string) => setExcluded((x) => (x.includes(id) ? x.filter((v) => v !== id) : [...x, id]));

  async function startHunt() {
    if (!result) return;
    const s = await getSettings(); setSettings(s);
    // The services still ticked (all are ticked by default), best offer first, capped. Every figure was observed during the scan.
    const offers = result.items.filter((i) => i.hasOffer);
    const targets = offers.filter((i) => !excluded.includes(i.id)).slice(0, Math.max(1, s.maxHunts || 10));
    const skipped = offers.filter((i) => !targets.includes(i));
    const estimate = +targets.reduce((sum, i) => sum + i.estSavings, 0).toFixed(2);
    setError(null); setHunt({ ...EMPTY_HUNT, total: targets.length });
    // Tabs paused on offers the user did not pick are simply closed. Nothing is clicked in them.
    for (const i of skipped) if (i.paused) { await closeTab(i.paused.tabId); i.paused = null; }

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
        // Charged now, and only now: 10% of what the billing pages actually showed.
        const verified = results.reduce((sum, r) => sum + (r.outcome === 'discount_applied' ? (r.savingsUsd || 0) : 0), 0);
        settlement = await settle(pay, verified, estimate).catch((e: any) => ({ feeCents: 0, estimatedFeeCents: 0, adjusted: false, charged: false, error: String(e?.message || e) }));
      }
      setHunt((h) => ({ ...h, settlement }));
      setScreen('done');
    } catch (e: any) { setError(String(e?.message || e)); setScreen('error'); }
  }

  const right: Record<Screen, string> = { consent: 'Before we start', idle: settings.restrictedMode ? 'Restricted mode' : 'No account needed', scanning: 'Scanning…', reveal: settings.restrictedMode ? 'Restricted mode' : 'Scan complete', checkout: 'Checkout', hunting: 'Hunting…', done: 'Done', settings: 'Settings', error: 'Something went wrong' };
  const openSettings = () => { returnTo.current = screen === 'settings' ? 'idle' : screen; setScreen('settings'); };

  return (
    <div className="panel">
      <div className="top">
        <span className="mark" aria-hidden="true"><svg viewBox="0 0 64 64" fill="none" stroke="#0E1116" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"><path d="M18 32h24M32 20l12 12-12 12" /></svg></span>
        Walkaway
        <span className="r">{right[screen]}</span>
        <button className="gear" title="Settings" onClick={openSettings} aria-label="Settings">⚙</button>
      </div>
      {screen === 'idle' && <Idle onScan={startScan} error={error} restricted={settings.restrictedMode} />}
      {screen === 'consent' && <Consent onAgree={agreeAndScan} onBack={() => setScreen('idle')} />}
      {screen === 'scanning' && <Scanning progress={progress} />}
      {screen === 'reveal' && result && <Reveal result={result} excluded={excluded} onToggle={toggle} onHunt={startHunt} onRescan={rescan} restricted={settings.restrictedMode} skipPayment={settings.skipPayment} />}
      {screen === 'checkout' && <Checkout msg={checkoutMsg} onCancel={() => { cancelCheckout.current = true; }} />}
      {screen === 'hunting' && <Hunting hunt={hunt} watch={settings.watch} />}
      {screen === 'done' && <Done hunt={hunt} onRescan={rescan} onAgain={startHunt} />}
      {screen === 'settings' && <SettingsScreen settings={settings} onSave={async (p) => { const n = await saveSettings(p); setSettings(n); setScreen(returnTo.current); }} onCancel={() => setScreen(returnTo.current)} />}
      {screen === 'error' && <ErrorScreen error={error} onRetry={startScan} onSettings={openSettings} />}
    </div>
  );
}

function Idle({ onScan, error, restricted }: { onScan: () => void; error: string | null; restricted: boolean }) {
  return (
    <div className="body">
      <h1>Find your <em>loyalty discounts.</em></h1>
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
        <li><b>Payment:</b> if you continue to checkout, Stripe saves your card and email. Nothing is charged until the run is done; then 10% of what was actually saved, once.</li>
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
      {items.length > 0 && (
        <div className="card">
          {items.map((i) => (
            <div className={`row col${i.hasOffer ? ' won' : ''}`} key={i.id}>
              <div className="rowline"><span>{i.name}</span>{i.hasOffer ? <b className="amt">~{money(i.estSavings)}</b> : <span className={`tag ${isBusy(i) ? 'busy' : 'skip'}`}>{isBusy(i) ? 'working' : keptLabel(i)}</span>}</div>
              <span className={`sub${i.hasOffer ? ' offer' : ''}`}>{i.live || ''}</span>
            </div>
          ))}
        </div>
      )}
      <p className="fine left">{phase === 'find'
        ? 'This is the slow part: it walks each cancellation flow up to the loyalty offer and stops there, three services at a time. Nothing is accepted yet.'
        : phase === 'pages' ? 'Account pages open briefly in background tabs and close on their own.'
        : "Only the names of sites you're signed into leave your browser at this step."}</p>
    </div>
  );
}

function Reveal({ result, excluded, onToggle, onHunt, onRescan, restricted, skipPayment }: { result: ScanResult; excluded: string[]; onToggle: (id: string) => void; onHunt: () => void; onRescan: () => void; restricted: boolean; skipPayment: boolean }) {
  const [details, setDetails] = useState(false);
  const found = result.items.filter((i) => i.status === 'signed_in' || i.status === 'unknown');
  const offers = found.filter((i) => i.hasOffer);
  const kept = found.filter((i) => !i.hasOffer);
  const picked = offers.filter((i) => !excluded.includes(i.id));
  const total = Math.round(picked.reduce((s, i) => s + i.estSavings, 0));
  return (
    <div className="body">
      {found.length === 0 ? (
        <>
          <h1>Nothing found <em>yet.</em></h1>
          <p>{restricted ? "None of the allowlisted sites looked signed in. Sign in to one in this browser, then rescan." : `We checked ${result.domainsChecked} sites you're signed into and didn't find a paid subscription we can work with. Sign in to a service in this browser, then rescan.`}</p>
        </>
      ) : (
        <>
          <div className="count">{found.length} subscription{found.length === 1 ? '' : 's'} found · {offers.length} made an offer</div>
          {offers.length > 0 && <p className="sub hint">All ticked. <b>Untick any subscription you'd rather we leave alone.</b> We only go for the discount on the ones left ticked.</p>}
          <div className="card">
            {offers.map((i) => { const on = !excluded.includes(i.id); return (
              <label className={`row pick${on ? '' : ' off'}`} key={i.id}>
                <input type="checkbox" checked={on} onChange={() => onToggle(i.id)} aria-label={`Include ${i.name}`} />
                <div className="rowmain">
                  <div className="rowline"><span>{i.name}</span><b className="amt">~{money(i.estSavings)}</b></div>
                  {(() => { const L = savingLines(i); return (<>
                    <span className="sub">{[i.email, L.now].filter(Boolean).join(' · ')}</span>
                    <span className="sub offer">{L.offer}</span>
                  </>); })()}
                </div>
              </label>
            ); })}
            {kept.map((i) => <div className="row skip" key={i.id}>{i.name}<span className="tag skip">{keptLabel(i)}</span></div>)}
          </div>
          {offers.length > 0 && <div className="total"><small>{picked.length === offers.length ? 'You could save about' : `${picked.length} of ${offers.length} selected — you could save about`}</small><b>~{money(total)}</b><span>on your upcoming renewals — by not cancelling. These are the offers each service actually showed; the exact charge is confirmed on your billing page after the run.</span></div>}
        </>
      )}
      <div className="spacer" />
      <button className="btn" onClick={onHunt} disabled={picked.length === 0}>Get these discounts →</button>
      <p className="fine">{skipPayment ? 'Payment skipped (testing). ' : 'No charge now. After the run: 10% of what was actually saved, $1 minimum, $0 if nothing. '}It cannot press “confirm cancellation” — that action doesn't exist in its toolset.</p>
      <p className="links"><a onClick={onRescan}>Rescan</a> · <a onClick={() => setDetails(!details)}>{details ? 'Hide' : 'Show'} details</a></p>
      {details && <DevTable items={result.items} />}
    </div>
  );
}
/** Why a subscription is listed without an offer. */
function keptLabel(i: ScanItem): string {
  if (i.status === 'login_wall') return 'Not signed in';
  if (i.status === 'no_paid_plan') return 'No paid plan';
  if (i.status === 'error') return "Couldn't check";
  if (i.offerApplied) return 'Promo active · kept';
  if (i.findOutcome === 'no_offer_backed_out') return 'No offer this time · left alone';
  if (i.findOutcome === 'blocked_needs_you') return 'Needs you to sign in';
  if (i.findOutcome == null) return 'Not checked';
  return "Couldn't check · left alone";
}

function Checkout({ msg, onCancel }: { msg: string; onCancel: () => void }) {
  return (
    <div className="body">
      <h1>Save a card. <em>Nothing is charged yet.</em></h1>
      <p>A secure Stripe page opened in a new tab. Your card is saved there and not charged. After the run you pay 10% of what we actually saved you — if some services don't make an offer, the charge goes down with them. $0 if none do.</p>
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
    : st.charged ? <>Charged {money(st.feeCents / 100)}{st.adjusted ? <> — adjusted down from about {money(st.estimatedFeeCents / 100)}, because {missed} of {results.length} didn't come through</> : ' (10% of verified savings)'}. {st.receiptUrl && <a href={st.receiptUrl} target="_blank" rel="noreferrer">Receipt</a>}</>
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
      <label>Never explore <span className="hint">one domain per line; also blocklist.json. Applies in every mode.</span><textarea rows={2} value={s.extraBlock} onChange={(e) => setS({ ...s, extraBlock: e.target.value })} placeholder="bank.com" /></label>
      <label className="check"><input type="checkbox" checked={s.skipPayment} onChange={(e) => setS({ ...s, skipPayment: e.target.checked })} /> Skip payment — no card, no fee (testing only)</label>
      <label className="check"><input type="checkbox" checked={s.watch} onChange={(e) => setS({ ...s, watch: e.target.checked })} /> Watch mode — open the hunt tab in front and leave it open</label>
      <label>Max services per run <span className="hint">highest estimated savings first</span><input type="number" min={1} max={30} {...f('maxHunts')} /></label>
      <label>Max steps per service<input type="number" min={5} max={40} {...f('maxSteps')} /></label>
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

function DevTable({ items }: { items: ScanItem[] }) {
  return (
    <table className="dev">
      <thead><tr><th>service</th><th>status</th><th>src</th><th>$/mo</th><th>est</th></tr></thead>
      <tbody>{items.map((i) => (<tr key={i.id} title={(i.url ?? '') + (i.note ? ' — ' + i.note : '')}><td>{i.name}</td><td>{i.status}</td><td>{i.source}</td><td>{i.monthlyPrice ?? '–'}</td><td>{i.estSavings || '–'}</td></tr>))}</tbody>
    </table>
  );
}

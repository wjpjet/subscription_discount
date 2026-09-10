import { useEffect, useRef, useState } from 'react';
import { browser } from '#imports';
import { DEFAULTS, getSettings, saveSettings, type Settings } from '@/src/settings';
import { originsFor } from '@/src/discovery';
import { runScan, type ScanItem, type ScanProgress, type ScanResult } from '@/src/scan';
import { huntAll, requestStop, type HuntEvent, type HuntResult, type HuntStep } from '@/src/hunt';
import { focusTab } from '@/src/tabs';
import { money, outcomeLabel } from '@/src/format';

type Screen = 'idle' | 'scanning' | 'reveal' | 'hunting' | 'done' | 'settings' | 'error';

export default function App() {
  const [screen, setScreen] = useState<Screen>('idle');
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hunt, setHunt] = useState<{ current: ScanItem | null; tabId: number | null; log: HuntStep[]; results: HuntResult[]; total: number; verifying: boolean }>({ current: null, tabId: null, log: [], results: [], total: 0, verifying: false });
  const returnTo = useRef<Screen>('idle');

  useEffect(() => {
    (async () => {
      setSettings(await getSettings());
      const v = await browser.storage.local.get(['scanResult', 'huntResults', 'previewHunt']);
      if (v.huntResults) { setHunt((h) => ({ ...h, results: v.huntResults as HuntResult[] })); }
      if (v.scanResult) { setResult(v.scanResult as ScanResult); setScreen('reveal'); }
      // Design previews only (sidepanel.html?preview=…); never used in the real flow.
      const pv = new URLSearchParams(location.search).get('preview');
      if (pv === 'settings') setScreen('settings');
      else if (pv === 'done' && v.huntResults) setScreen('done');
      else if (pv === 'hunting' && v.previewHunt) { setHunt(v.previewHunt as any); setScreen('hunting'); }
    })();
  }, []);

  async function startScan() {
    setError(null);
    try {
      const s = await getSettings(); setSettings(s);
      const origins = originsFor(s);
      if (!(await browser.permissions.contains({ origins }))) {
        const ok = await browser.permissions.request({ origins });
        if (!ok) { setError("Walkaway needs permission to check which sites you're signed into. Nothing runs without it."); return; }
      }
      setScreen('scanning'); setProgress({ phase: 'discover', done: 0, total: 0, message: 'Starting…' });
      const r = await runScan(s, setProgress);
      setResult(r); setScreen('reveal');
    } catch (e: any) { setError(String(e?.message || e)); setScreen('error'); }
  }
  async function rescan() { await browser.storage.local.remove(['scanResult', 'huntResults']); setResult(null); setHunt({ current: null, tabId: null, log: [], results: [], total: 0, verifying: false }); await startScan(); }

  async function startHunt() {
    if (!result) return;
    const targets = result.items.filter((i) => (i.status === 'signed_in' || i.status === 'unknown') && i.hasOffer);
    const s = await getSettings(); setSettings(s);
    setHunt({ current: null, tabId: null, log: [], results: [], total: targets.length, verifying: false });
    setScreen('hunting');
    const onEvent = (e: HuntEvent) => {
      if (e.type === 'start') setHunt((h) => ({ ...h, current: e.item, tabId: e.tabId, log: [], verifying: false }));
      else if (e.type === 'step') setHunt((h) => ({ ...h, log: [...h.log, e.step].slice(-40) }));
      else if (e.type === 'verify') setHunt((h) => ({ ...h, verifying: true }));
      else if (e.type === 'done') setHunt((h) => ({ ...h, results: [...h.results, e.result], verifying: false }));
    };
    try {
      const results = await huntAll(targets, s, onEvent);
      await browser.storage.local.set({ huntResults: results });
      setScreen('done');
    } catch (e: any) { setError(String(e?.message || e)); setScreen('error'); }
  }

  const right: Record<Screen, string> = { idle: settings.testMode ? 'Test mode' : 'No account needed', scanning: 'Scanning…', reveal: settings.testMode ? 'Test mode' : 'Scan complete', hunting: 'Hunting…', done: 'Done', settings: 'Settings', error: 'Something went wrong' };
  const openSettings = () => { returnTo.current = screen === 'settings' ? 'idle' : screen; setScreen('settings'); };

  return (
    <div className="panel">
      <div className="top">
        <span className="mark" aria-hidden="true"><svg viewBox="0 0 64 64" fill="none" stroke="#0E1116" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"><path d="M18 32h24M32 20l12 12-12 12" /></svg></span>
        Walkaway
        <span className="r">{right[screen]}</span>
        <button className="gear" title="Settings" onClick={openSettings} aria-label="Settings">⚙</button>
      </div>
      {screen === 'idle' && <Idle onScan={startScan} error={error} testMode={settings.testMode} />}
      {screen === 'scanning' && <Scanning progress={progress} />}
      {screen === 'reveal' && result && <Reveal result={result} onHunt={startHunt} onRescan={rescan} testMode={settings.testMode} />}
      {screen === 'hunting' && <Hunting hunt={hunt} watch={settings.watch} />}
      {screen === 'done' && <Done results={hunt.results} onRescan={rescan} onAgain={startHunt} />}
      {screen === 'settings' && <SettingsScreen settings={settings} onSave={async (p) => { const n = await saveSettings(p); setSettings(n); setScreen(returnTo.current); }} onCancel={() => setScreen(returnTo.current)} />}
      {screen === 'error' && <ErrorScreen error={error} onRetry={startScan} onSettings={openSettings} />}
    </div>
  );
}

function Idle({ onScan, error, testMode }: { onScan: () => void; error: string | null; testMode: boolean }) {
  return (
    <div className="body">
      <h1>Find your <em>loyalty discounts.</em></h1>
      <p>{testMode ? 'Test mode: only your configured test site will be scanned and hunted.' : "We'll check which subscription services you're signed into — locally in your browser, sending only the site names to identify subscriptions — and show you what you could save on your upcoming renewals."}</p>
      {error && <p className="err">{error}</p>}
      <div className="spacer" />
      <button className="btn" onClick={onScan}>Scan my subscriptions</button>
      <p className="fine">Takes about a minute. No passwords, cookies, or history are ever uploaded. Nothing gets cancelled — ever.</p>
    </div>
  );
}

function Scanning({ progress }: { progress: ScanProgress | null }) {
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 5;
  const label = !progress || progress.phase === 'discover' ? (progress?.message || 'Discovering…') : progress.phase === 'pages' ? `Checking ${progress.current ?? 'your accounts'}… (${progress.done} of ${progress.total})` : 'Almost done…';
  return (
    <div className="body">
      <div className="prog"><i style={{ width: `${Math.max(5, pct)}%` }} /></div>
      <h1>Scanning.</h1>
      <p>{label}</p>
      <p className="fine left">Account pages open briefly in background tabs and close on their own. Keep doing what you were doing.</p>
    </div>
  );
}

function Reveal({ result, onHunt, onRescan, testMode }: { result: ScanResult; onHunt: () => void; onRescan: () => void; testMode: boolean }) {
  const [details, setDetails] = useState(false);
  const found = result.items.filter((i) => i.status === 'signed_in' || i.status === 'unknown');
  const offers = found.filter((i) => i.hasOffer);
  const kept = found.filter((i) => !i.hasOffer);
  return (
    <div className="body">
      {found.length === 0 ? (
        <>
          <h1>Nothing found <em>yet.</em></h1>
          <p>{testMode ? "The test site didn't look signed in. Sign in to it in this browser, then rescan." : `We checked ${result.domainsChecked} sites you're signed into and didn't find a paid subscription we can work with. Sign in to a service in this browser and scan again.`}</p>
        </>
      ) : (
        <>
          <div className="count">{found.length} subscription{found.length === 1 ? '' : 's'} found · {offers.length} make{offers.length === 1 ? 's' : ''} loyalty offers</div>
          <div className="card">
            {offers.map((i) => <div className="row" key={i.id}>{i.name}<span className="tag ok">Makes offers</span></div>)}
            {kept.map((i) => <div className="row skip" key={i.id}>{i.name}<span className="tag skip">{i.offerApplied ? 'Promo active · kept' : 'No offers · kept'}</span></div>)}
          </div>
          {offers.length > 0 && <div className="total"><small>You could save about</small><b>~{money(result.totalEstSavings)}</b><span>on your upcoming renewals — by not cancelling. Exact amounts appear in your summary after the run.</span></div>}
        </>
      )}
      <div className="spacer" />
      <button className="btn" onClick={onHunt} disabled={offers.length === 0}>Get these discounts →</button>
      <p className="fine">Runs in a background tab. It cannot press “confirm cancellation” — that action doesn't exist in its toolset.</p>
      <p className="links"><a onClick={onRescan}>Rescan</a> · <a onClick={() => setDetails(!details)}>{details ? 'Hide' : 'Show'} details</a></p>
      {details && <DevTable items={result.items} />}
    </div>
  );
}

function Hunting({ hunt, watch }: { hunt: { current: ScanItem | null; tabId: number | null; log: HuntStep[]; results: HuntResult[]; total: number; verifying: boolean }; watch: boolean }) {
  const done = hunt.results.length, total = hunt.total || 1;
  return (
    <div className="body">
      <div className="prog"><i style={{ width: `${Math.max(4, Math.round((done / total) * 100))}%` }} /></div>
      <div className="count">{hunt.current ? `${hunt.verifying ? 'Verifying' : 'Hunting'} ${done + 1} of ${hunt.total} — ${hunt.current.name}` : 'Starting…'}</div>
      <div className="log">
        {hunt.log.slice(-10).map((s) => (
          <div className={`step ${s.action.type === 'back_out' ? 'warn' : s.action.type === 'finish' ? 'done' : 'now'}`} key={s.step}>
            <div className="dot">{s.step}</div>
            <div><b>{s.state.replace(/_/g, ' ')}</b><span>{s.action.type}{s.target ? ` → “${s.target.slice(0, 50)}”` : ''}{s.guardrails && s.guardrails.length ? ` · ⛔ ${s.guardrails[0]}` : ''}</span></div>
          </div>
        ))}
        {hunt.log.length === 0 && <p className="fine left">Opening the account page…</p>}
      </div>
      <div className="spacer" />
      {hunt.tabId != null && <button className="btn ghost" onClick={() => focusTab(hunt.tabId!)}>Watch this tab</button>}
      <button className="btn ghost" onClick={requestStop}>Stop after this one</button>
      <p className="note">{watch ? 'Watch mode: the tab is in front.' : 'Runs in a background tab — keep doing what you were doing.'} On anything ambiguous, it backs out.</p>
    </div>
  );
}

function Done({ results, onRescan, onAgain }: { results: HuntResult[]; onRescan: () => void; onAgain: () => void }) {
  const total = results.reduce((s, r) => s + (r.savingsUsd || 0), 0);
  const wins = results.filter((r) => r.outcome === 'discount_applied').length;
  return (
    <div className="body">
      <h1>{wins ? <>You're paying <em>{money(total)} less</em> on your upcoming renewals.</> : <>No discounts <em>this time.</em></>}</h1>
      <div className="card">
        {results.map((r) => (
          <div className="row col" key={r.domain}>
            <div className="rowline">{r.name}<span className={`tag ${r.outcome === 'discount_applied' ? 'ok' : 'skip'}`}>{outcomeLabel(r.outcome)}</span></div>
            <span className="sub">{r.outcome === 'discount_applied' ? `${money(r.before?.monthlyPriceUsd ?? null)}/mo → ${money(r.after?.monthlyPriceUsd ?? null)}/mo${r.termMonths ? ` for ${r.termMonths} months` : ''} · saves ${money(r.savingsUsd)}` : (r.reason || r.error || r.details?.summary || '')}{r.steps.length ? ` · ${r.steps.length} steps` : ''}</span>
          </div>
        ))}
      </div>
      <p className="sub">Nothing was cancelled. {wins ? 'Your fee: 10% of verified savings — checkout arrives in the next build.' : ''}</p>
      <div className="spacer" />
      <button className="btn ghost" onClick={onAgain}>Run again</button>
      <p className="links"><a onClick={onRescan}>Rescan</a></p>
    </div>
  );
}

function SettingsScreen({ settings, onSave, onCancel }: { settings: Settings; onSave: (p: Partial<Settings>) => void; onCancel: () => void }) {
  const [s, setS] = useState<Settings>(settings);
  const f = (k: keyof Settings) => ({ value: String(s[k] ?? ''), onChange: (e: any) => setS({ ...s, [k]: k === 'maxSteps' ? Number(e.target.value) : e.target.value }) });
  return (
    <div className="body form">
      <h1>Settings</h1>
      <label>API URL <span className="hint">your Netlify site, e.g. https://walkaway-api.netlify.app</span><input {...f('apiBase')} placeholder="https://…netlify.app" /></label>
      <label>Client key <span className="hint">only if WALKAWAY_CLIENT_KEY is set on the backend</span><input {...f('clientKey')} /></label>
      <label className="check"><input type="checkbox" checked={s.testMode} onChange={(e) => setS({ ...s, testMode: e.target.checked })} /> Test mode — scan and hunt <b>only</b> the test site below</label>
      <label>Test domain<input {...f('testDomain')} placeholder="streamly-testbed.netlify.app" /></label>
      <label>Test account URL<input {...f('testAccountUrl')} placeholder="https://streamly-testbed.netlify.app/settings/subscription" /></label>
      <label>Test service name<input {...f('testName')} /></label>
      <label className="check"><input type="checkbox" checked={s.watch} onChange={(e) => setS({ ...s, watch: e.target.checked })} /> Watch mode — open the hunt tab in front and leave it open</label>
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

import { useEffect, useState } from 'react';
import { browser } from '#imports';
import { ORIGINS, PLAYBOOKS } from '@/src/playbooks';
import type { ScanItem, ScanProgress, ScanResult } from '@/src/scan';
import { money } from '@/src/format';

type Screen = 'idle' | 'scanning' | 'reveal' | 'hunting' | 'error';

export default function App() {
  const [screen, setScreen] = useState<Screen>('idle');
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    browser.storage.local.get(['scanResult', 'scanRunning']).then((v) => {
      if (v.scanRunning) setScreen('scanning');
      else if (v.scanResult) { setResult(v.scanResult as ScanResult); setScreen('reveal'); }
    });
    const onMsg = (msg: any) => {
      if (!msg) return;
      if (msg.type === 'SCAN_PROGRESS') { setProgress(msg.progress); setScreen('scanning'); }
      else if (msg.type === 'SCAN_DONE') { setResult(msg.result); setProgress(null); setScreen('reveal'); }
      else if (msg.type === 'SCAN_ERROR') { setError(msg.error); setScreen('error'); }
    };
    browser.runtime.onMessage.addListener(onMsg);
    return () => { browser.runtime.onMessage.removeListener(onMsg); };
  }, []);

  async function startScan() {
    setError(null);
    try {
      const has = await browser.permissions.contains({ origins: ORIGINS });
      if (!has) {
        const ok = await browser.permissions.request({ origins: ORIGINS });
        if (!ok) { setError('Walkaway needs permission to check those sites. Nothing runs without it.'); return; }
      }
      setProgress({ phase: 'cookies', done: 0, total: PLAYBOOKS.length });
      setScreen('scanning');
      const res = await browser.runtime.sendMessage({ type: 'SCAN_START' });
      if (res && res.ok === false && res.reason !== 'already_running') throw new Error('Could not start the scan.');
    } catch (e: any) {
      setError(String(e?.message || e));
      setScreen('error');
    }
  }

  async function rescan() {
    await browser.storage.local.remove('scanResult');
    setResult(null);
    await startScan();
  }

  const rightLabel: Record<Screen, string> = {
    idle: 'No account needed', scanning: 'Scanning…', reveal: 'Scan complete', hunting: 'Next build', error: 'Something went wrong',
  };

  return (
    <div className="panel">
      <div className="top">
        <span className="mark" aria-hidden="true">
          <svg viewBox="0 0 64 64" fill="none" stroke="#0E1116" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"><path d="M18 32h24M32 20l12 12-12 12" /></svg>
        </span>
        Walkaway
        <span className="r">{rightLabel[screen]}</span>
      </div>
      {screen === 'idle' && <Idle onScan={startScan} error={error} />}
      {screen === 'scanning' && <Scanning progress={progress} />}
      {screen === 'reveal' && result && <Reveal result={result} onHunt={() => setScreen('hunting')} onRescan={rescan} />}
      {screen === 'hunting' && <Hunting onBack={() => setScreen('reveal')} />}
      {screen === 'error' && <ErrorScreen error={error} onRetry={startScan} />}
    </div>
  );
}

function Idle({ onScan, error }: { onScan: () => void; error: string | null }) {
  return (
    <div className="body">
      <h1>Find your <em>loyalty discounts.</em></h1>
      <p>We'll check which subscription services you're signed into — locally, in your browser — and show you what you could save on your upcoming renewals.</p>
      {error && <p className="err">{error}</p>}
      <div className="spacer" />
      <button className="btn" onClick={onScan}>Scan my subscriptions</button>
      <p className="fine">Takes about a minute. Nothing about your browsing is uploaded. Nothing gets cancelled — ever.</p>
    </div>
  );
}

function Scanning({ progress }: { progress: ScanProgress | null }) {
  const phase = progress?.phase ?? 'cookies';
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 5;
  const label = phase === 'cookies'
    ? "Checking which services you're signed into…"
    : phase === 'pages'
      ? `Checking ${progress?.current ?? 'your accounts'}… (${progress?.done ?? 0} of ${progress?.total ?? 0})`
      : 'Almost done…';
  return (
    <div className="body">
      <div className="prog"><i style={{ width: `${Math.max(5, pct)}%` }} /></div>
      <h1>Scanning.</h1>
      <p>{label}</p>
      <p className="fine left">Account pages open briefly in background tabs and close on their own. Keep doing what you were doing.</p>
    </div>
  );
}

function Reveal({ result, onHunt, onRescan }: { result: ScanResult; onHunt: () => void; onRescan: () => void }) {
  const [details, setDetails] = useState(false);
  const found = result.items.filter((i) => i.status === 'signed_in' || i.status === 'unknown');
  const offers = found.filter((i) => i.hasOffer);
  const kept = found.filter((i) => !i.hasOffer);

  if (found.length === 0) {
    return (
      <div className="body">
        <h1>Nothing found <em>yet.</em></h1>
        <p>We didn't find any subscriptions you're signed into on our list. Sign in to a service in this browser and scan again, or check the details below.</p>
        <p className="links"><a onClick={onRescan}>Rescan</a> · <a onClick={() => setDetails(!details)}>{details ? 'Hide' : 'Show'} details</a></p>
        {details && <DevTable items={result.items} />}
        <div className="spacer" />
        <p className="fine">Supported today: {PLAYBOOKS.map((p) => p.name).join(', ')}.</p>
      </div>
    );
  }

  return (
    <div className="body">
      <div className="count">{found.length} subscription{found.length === 1 ? '' : 's'} found · {offers.length} make{offers.length === 1 ? 's' : ''} loyalty offers</div>
      <div className="card">
        {offers.map((i) => <div className="row" key={i.id}>{i.name}<span className="tag ok">Makes offers</span></div>)}
        {kept.map((i) => <div className="row skip" key={i.id}>{i.name}<span className="tag skip">No offers · kept</span></div>)}
      </div>
      {offers.length > 0 && (
        <div className="total">
          <small>You could save about</small>
          <b>~{money(result.totalEstSavings)}</b>
          <span>on your upcoming renewals — by not cancelling. Exact amounts appear in your summary after the run.</span>
        </div>
      )}
      <div className="spacer" />
      <button className="btn" onClick={onHunt} disabled={offers.length === 0}>Get these discounts →</button>
      <p className="fine">You pay once — 10% of what we verifiably save you.<br />$1 hold to check your card, released after. $0 if nothing.</p>
      <p className="links"><a onClick={onRescan}>Rescan</a> · <a onClick={() => setDetails(!details)}>{details ? 'Hide' : 'Show'} details</a></p>
      {details && <DevTable items={result.items} />}
    </div>
  );
}

function Hunting({ onBack }: { onBack: () => void }) {
  return (
    <div className="body">
      <div className="prog"><i style={{ width: '0%' }} /></div>
      <h1>Almost <em>there.</em></h1>
      <p>The hunt engine is the next build. This is where Walkaway opens each service in a background tab, walks the cancellation flow to the loyalty offer, accepts it, and backs out of anything that isn't one. Nothing runs today.</p>
      <div className="spacer" />
      <button className="btn ghost" onClick={onBack}>Back</button>
    </div>
  );
}

function ErrorScreen({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <div className="body">
      <h1>Hmm.</h1>
      <p className="err">{error ?? 'Something went wrong.'}</p>
      <div className="spacer" />
      <button className="btn" onClick={onRetry}>Try again</button>
    </div>
  );
}

function DevTable({ items }: { items: ScanItem[] }) {
  return (
    <table className="dev">
      <thead><tr><th>service</th><th>status</th><th>cookie</th><th>$/mo</th><th>est</th></tr></thead>
      <tbody>
        {items.map((i) => (
          <tr key={i.id} title={(i.url ?? '') + (i.note ? ' — ' + i.note : '')}>
            <td>{i.name}</td><td>{i.status}</td><td>{i.cookieHit ? '✓' : '–'}</td><td>{i.monthlyPrice ?? '–'}</td><td>{i.estSavings || '–'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

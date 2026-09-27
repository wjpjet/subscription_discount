import { getSettings } from './settings';
import { trace, tracing } from './trace';
import { sanitizeApiBody } from '../../shared/scrub.js';

export async function apiAvailable(): Promise<boolean> { return !!(await getSettings()).apiBase; }

// Chrome's fetch never times out on its own, and one hung call would pin a scan worker forever.
// Observed: classify ~1.5s, discover ~7s, agent-step a few seconds; the Worker itself gives up well before these.
const TIMEOUT_MS: Record<string, number> = { '/api/discover': 30_000, '/api/classify': 20_000, '/api/agent-step': 45_000 };
const DEFAULT_TIMEOUT_MS = 30_000;

/** What an API call was about, for the test log (never the page text; that is logged by the caller). */
function describe(path: string, body: any): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  if (path === '/api/discover') return { domains: (body.domains || []).length };
  if (path === '/api/classify') return { svc: body.domain };
  if (path === '/api/agent-step') return { svc: body.merchant?.domain, goal: body.goal, step: body.step, historyLen: (body.history || []).length, elements: (body.snapshot?.elements || []).length, textLength: (body.snapshot?.text || '').length, priorPath: !!body.priorPath };
  if (path === '/api/checkout' || path === '/api/settle') return { estimatedSavingsUsd: body.estimatedSavingsUsd, verifiedSavingsUsd: body.verifiedSavingsUsd };
  return {};
}

/**
 * POST to the backend. This is THE boundary where page data leaves the browser: the body is sent as a sanitizeApiBody()
 * copy — `snapshot` sanitized, `readiness` url/dialog, `history` url/target/note and `priorPath` lines scrubbed (tokens,
 * long numbers, card data, addresses out; emails kept for the classifier) — and callers keep raw values for local logic
 * (history targets are matched against raw page text). A call past its timeout throws `timeout: <path> after <n>s`.
 */
export async function apiPost<T>(path: string, body: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
  const s = await getSettings();
  if (!s.apiBase) throw new Error('No API URL configured — open Settings (⚙) and enter the backend URL.');
  const url = s.apiBase.replace(/\/+$/, '') + path;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS[path] ?? DEFAULT_TIMEOUT_MS;
  const out = sanitizeApiBody(body);
  const signal = AbortSignal.timeout(timeoutMs);
  const t0 = Date.now();
  let status = 0, j: any = {}, timedOut = false;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(s.clientKey ? { 'x-walkaway-key': s.clientKey } : {}) }, body: JSON.stringify(out), signal });
    status = res.status;
    j = await res.json().catch((e) => { if (signal.aborted) throw e; return {}; });   // a body cut off by the timeout is not an empty reply
    if (!res.ok || j.error) throw new Error(j.error || `API error ${res.status}`);
    return j as T;
  } catch (e: any) {
    let err = e;
    if (signal.aborted || e?.name === 'TimeoutError' || e?.name === 'AbortError') { timedOut = true; err = new Error(`timeout: ${path} after ${Math.round(timeoutMs / 1000)}s`); }
    if (tracing()) j = { ...j, error: j.error || String(err?.message || err) };
    throw err;
  } finally {
    if (tracing()) {
      const ms = Date.now() - t0;
      trace('api', {
        path, status, ms, serverMs: j.serverMs ?? null, networkMs: j.serverMs != null ? ms - j.serverMs : null,
        ok: !j.error && status >= 200 && status < 300, error: j.error || null, timedOut,
        model: j.model || null, provider: j.provider || null, usage: j.usage || null,
        ...describe(path, body),
      });
    }
  }
}

import { getSettings } from './settings';
import { trace, tracing } from './trace';

export async function apiAvailable(): Promise<boolean> { return !!(await getSettings()).apiBase; }

/** What an API call was about, for the test log (never the page text; that is logged by the caller). */
function describe(path: string, body: any): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  if (path === '/api/discover') return { domains: (body.domains || []).length };
  if (path === '/api/classify') return { svc: body.domain };
  if (path === '/api/agent-step') return { svc: body.merchant?.domain, goal: body.goal, step: body.step, historyLen: (body.history || []).length, elements: (body.snapshot?.elements || []).length, textLength: (body.snapshot?.text || '').length, priorPath: !!body.priorPath };
  if (path === '/api/checkout' || path === '/api/settle') return { estimatedSavingsUsd: body.estimatedSavingsUsd, verifiedSavingsUsd: body.verifiedSavingsUsd };
  return {};
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const s = await getSettings();
  if (!s.apiBase) throw new Error('No API URL configured — open Settings (⚙) and enter the backend URL.');
  const url = s.apiBase.replace(/\/+$/, '') + path;
  const t0 = Date.now();
  let status = 0, j: any = {};
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(s.clientKey ? { 'x-walkaway-key': s.clientKey } : {}) }, body: JSON.stringify(body) });
    status = res.status;
    j = await res.json().catch(() => ({}));
    if (!res.ok || j.error) throw new Error(j.error || `API error ${res.status}`);
    return j as T;
  } catch (e: any) {
    if (tracing()) j = { ...j, error: j.error || String(e?.message || e) };
    throw e;
  } finally {
    if (tracing()) {
      const ms = Date.now() - t0;
      trace('api', {
        path, status, ms, serverMs: j.serverMs ?? null, networkMs: j.serverMs != null ? ms - j.serverMs : null,
        ok: !j.error && status >= 200 && status < 300, error: j.error || null,
        model: j.model || null, provider: j.provider || null, usage: j.usage || null,
        ...describe(path, body),
      });
    }
  }
}

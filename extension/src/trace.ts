/**
 * Test-mode trace: a timestamped record of everything a scan does, for reviewing a live run.
 *
 * Off unless a run is started with traceStart(). Events land in memory and are mirrored to
 * browser.storage.local (key "testLog") at most every 1.5s, so closing the panel mid-run loses little.
 * The log never contains cookie values or passwords (they are never read), and long digit runs (card
 * or account numbers) are redacted from any page text before it is recorded.
 */
import { browser } from '#imports';

export interface TraceEvent { t: number; dt: number; kind: string; svc?: string; [k: string]: unknown }
export interface TraceLog { format: 'walkaway-test-log'; version: 1; meta: Record<string, unknown>; startedAt: number; endedAt: number | null; events: TraceEvent[]; summary?: Record<string, unknown> }

const KEY = 'testLog';
const MAX_BYTES = 7_000_000;            // storage.local allows ~10MB without unlimitedStorage
let log: TraceLog | null = null;
let pageText = true;
let timer: ReturnType<typeof setTimeout> | null = null;

export const tracing = () => log != null;
export const tracePageText = () => log != null && pageText;

export async function traceStart(meta: Record<string, unknown>, opts: { pageText: boolean }): Promise<void> {
  pageText = opts.pageText;
  const now = Date.now();
  log = { format: 'walkaway-test-log', version: 1, meta, startedAt: now, endedAt: null, events: [] };
  trace('run.start', { meta });
  await persist();
}

export function trace(kind: string, data: Record<string, unknown> = {}): void {
  if (!log) return;
  const t = Date.now();
  log.events.push({ t, dt: t - log.startedAt, kind, ...data });
  if (!timer) timer = setTimeout(() => { timer = null; void persist(); }, 1500);
}

export async function traceEnd(summary: Record<string, unknown>): Promise<TraceLog | null> {
  if (!log) return null;
  trace('run.end', { summary });
  log.endedAt = Date.now();
  log.summary = summary;
  if (timer) { clearTimeout(timer); timer = null; }
  await persist();
  const done = log;
  log = null;
  return done;
}

/** Time an async step and record it with its duration, whether it succeeded or threw. */
export async function timed<T>(kind: string, data: Record<string, unknown>, fn: () => Promise<T>, pick?: (r: T) => Record<string, unknown>): Promise<T> {
  if (!log) return fn();
  const t0 = Date.now();
  try {
    const r = await fn();
    trace(kind, { ...data, ms: Date.now() - t0, ok: true, ...(pick ? pick(r) : {}) });
    return r;
  } catch (e: any) {
    trace(kind, { ...data, ms: Date.now() - t0, ok: false, error: String(e?.message || e) });
    throw e;
  }
}

/** Page text for the log: long digit runs removed, length capped. Null when page text is switched off. */
export function logText(text: string | null | undefined, max = 3000): string | null {
  if (!tracePageText() || !text) return null;
  return redact(text).slice(0, max);
}
export function redact(text: string): string {
  return String(text)
    .replace(/\b(?:\d[ -]?){12,19}\b/g, '[digits]')          // card / account numbers
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[ssn]');
}
/** A compact description of a page snapshot, without the full element list. */
export function snapSummary(snap: any): Record<string, unknown> {
  if (!snap) return { snapshot: null };
  return {
    url: snap.url, title: snap.title, headings: (snap.headings || []).slice(0, 8),
    elements: (snap.elements || []).length, textLength: snap.textLength ?? (snap.text || '').length,
    hasPassword: !!snap.hasPassword, prices: (snap.prices || []).slice(0, 6).map((p: any) => `$${p.amount}${p.unit ? '/' + p.unit : ''}`),
    buttons: (snap.elements || []).filter((e: any) => e.tag === 'button' || e.role === 'button' || e.tag === 'a').slice(0, 30).map((e: any) => `[${e.id}] ${String(e.text || e.label || '').slice(0, 60)}`),
    text: logText(snap.text),
  };
}

async function persist(): Promise<void> {
  if (!log) return;
  let json = JSON.stringify(log);
  if (json.length > MAX_BYTES) {
    // Too big for storage: drop page text from the oldest events first, keep every event itself.
    for (const e of log.events) { if (json.length <= MAX_BYTES) break; if (typeof e.text === 'string') { e.text = '[dropped: log size cap]'; json = JSON.stringify(log); } }
  }
  try { await browser.storage.local.set({ [KEY]: log }); } catch { /* storage full or unavailable: the in-memory log still exists */ }
}

export async function lastLog(): Promise<TraceLog | null> {
  const v = await browser.storage.local.get(KEY);
  return (v[KEY] as TraceLog) || null;
}

/** Save the log as a JSON file via the browser's normal download flow. */
export function downloadLog(l: TraceLog): void {
  const stamp = new Date(l.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const blob = new Blob([JSON.stringify(l, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `walkaway-test-log-${stamp}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Test-mode trace: a timestamped record of everything a scan does, for reviewing a live run.
 *
 * Off unless a run is started with traceStart(). Events land in memory and are mirrored to
 * browser.storage.local (key "testLog") at most every 1.5s, so closing the panel mid-run loses little.
 * What the log never holds:
 * - cookie values, passwords and form-field values (never read or never recorded);
 * - secrets: every string in every event goes through redactForLog (shared/scrub.js), which replaces JWTs, keyed
 *   secrets (token, csrf/xsrf, session id, nonce, challenge, scnt, postkey, api key, auth…), Bearer tokens, hex runs
 *   of 32+ and base64 runs of 40+, digit runs of 12+ (card and account numbers, no upper bound) and SSNs;
 * - personal data: card tails and expiry, US street addresses, ZIPs, birthdates, and full emails (masked to ja***@example.com);
 * - URL secrets: URL fields also go through scrubUrl (secret-named or token-like query/fragment values → x, token path
 *   segments → [token], user:pass@ dropped).
 * Page text, headings and button labels are recorded only when "include page text" is on (scrubbed as above);
 * otherwise a page is summed up by its URL, title and counts.
 *
 * Recording ("record pages for replay", needs page text on): every page the scan reads and every walk step also
 * keeps the whole snapshot the model saw, scrubbed the same way and with form-field contents replaced by "[filled]",
 * as a `flow.page` event. `npm run flows` turns
 * them into replayable flows, so real cancellation flows become test cases without visiting the sites again.
 */
import { browser } from '#imports';
import { redactForLog, sanitizeSnapshot, scrubUrl, maskEmail } from '../../shared/scrub.js';

export { redactForLog };

export interface TraceEvent { t: number; dt: number; kind: string; svc?: string; [k: string]: unknown }
export interface TraceLog { format: 'walkaway-test-log'; version: 1; meta: Record<string, unknown>; startedAt: number; endedAt: number | null; events: TraceEvent[]; summary?: Record<string, unknown> }

const KEY = 'testLog';
const MAX_BYTES = 7_000_000;            // storage.local allows ~10MB without unlimitedStorage
const DROPPED = '[dropped: log size cap]';
let log: TraceLog | null = null;
let pageText = true;
let recording = false;
let persistFailed = false;
let timer: ReturnType<typeof setTimeout> | null = null;

export const tracing = () => log != null;
export const tracePageText = () => log != null && pageText;
export const traceRecording = () => log != null && pageText && recording;

export async function traceStart(meta: Record<string, unknown>, opts: { pageText: boolean; record?: boolean }): Promise<void> {
  pageText = opts.pageText;
  recording = !!opts.record;
  persistFailed = false;
  const now = Date.now();
  log = { format: 'walkaway-test-log', version: 1, meta: clean(meta) as Record<string, unknown>, startedAt: now, endedAt: null, events: [] };
  trace('run.start', { meta });
  await persist();
}

export function trace(kind: string, data: Record<string, unknown> = {}): void {
  if (!log) return;
  const t = Date.now();
  log.events.push({ t, dt: t - log.startedAt, kind, ...(clean(data) as Record<string, unknown>) });
  if (!timer) timer = setTimeout(() => { timer = null; void persist(); }, 1500);
}

export async function traceEnd(summary: Record<string, unknown>): Promise<TraceLog | null> {
  if (!log) return null;
  trace('run.end', { summary });
  log.endedAt = Date.now();
  log.summary = clean(summary) as Record<string, unknown>;
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

/** Page text for the log: scrubbed by redactForLog, length capped. Null when page text is switched off. */
export function logText(text: string | null | undefined, max = 3000): string | null {
  if (!tracePageText() || !text) return null;
  return redactForLog(text).slice(0, max);
}
/** Old name for redactForLog. */
export const redact = (text: string): string => redactForLog(text);
/** An email for the log: `ja***@example.com`, or null. */
export function maskForLog(email: string | null | undefined): string | null { return email ? maskEmail(email) : null; }
/** A URL for the log: secret query values and token path segments out, emails masked, length capped. Redacted piece by
 *  piece: a long run of letters and digits across path separators ("com/premium/…/1234") is a path, not one token.
 *  Never split at "=": "sid=…" must stay one piece for the keyed-secret rule to see it. */
export function logUrl(url: string | null | undefined): string | null {
  if (url == null) return null;
  const s = scrubUrl(String(url)).split(/([/?&#])/).map((p) => (/^[/?&#]$/.test(p) ? p : redactForLog(p))).join('');
  return s.length > 400 ? s.slice(0, 400) + '…' : s;
}

// Backstop over everything logged, so a caller that forgets cannot leak a token or a full email: each string goes
// through redactForLog, and URL-ish ones (by key or by shape) through scrubUrl too.
const URL_KEY = /(?:url|href)s?$|^(?:from|to)$/i;
const URL_VALUE = /^(?:https?:)?\/\/\S+$/i;
function clean(v: unknown, key = '', depth = 0): unknown {
  if (typeof v === 'string') return URL_KEY.test(key) || URL_VALUE.test(v) ? logUrl(v) : redactForLog(v);
  if (!v || typeof v !== 'object' || depth > 8) return v;
  if (Array.isArray(v)) return v.map((x) => clean(x, key, depth + 1));
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;      // Dates and the like serialize themselves
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) o[k] = clean(x, k, depth + 1);
  return o;
}

const CLICKABLE_ROLE = /^(button|link|menuitem\w*|option|switch|tab|radio|checkbox)$/;
function priceLabel(p: any): string {
  const amount = typeof p?.amount === 'number' ? p.amount.toFixed(2) : String(p?.amount);
  return `${p?.currency || 'USD'} ${amount}${p?.unit ? '/' + String(p.unit).replace(/^\//, '') : ''}`;
}

/**
 * A compact, scrubbed description of a page snapshot, without the full element list. Headings and button labels
 * appear only when page text is on; otherwise just their counts.
 */
export function snapSummary(snap: any): Record<string, unknown> {
  if (!snap) return { snapshot: null };
  const s: any = sanitizeSnapshot(snap);
  const full = tracePageText();
  const els: any[] = s.elements || [];
  const headings: string[] = s.headings || [];
  const buttons = els.filter((e) => e.tag === 'button' || e.tag === 'a' || e.tag === 'label' || CLICKABLE_ROLE.test(e.role || ''));
  const regions: Record<string, number> = {};
  for (const e of els) if (e.region) regions[e.region] = (regions[e.region] || 0) + 1;
  const id = s.identity;
  return {
    url: logUrl(s.url), title: s.title == null ? null : redactForLog(s.title).slice(0, 200),
    headingCount: headings.length, buttonCount: buttons.length,
    ...(full ? {
      headings: headings.slice(0, 8).map((h) => redactForLog(h).slice(0, 120)),
      buttons: buttons.slice(0, 30).map((e) => `[${e.id}] ${redactForLog(String(e.text || e.label || '')).slice(0, 60)}`),
    } : {}),
    elements: els.length, regions, textLength: s.textLength ?? (s.text || '').length,
    hasPassword: !!s.hasPassword, prices: (s.prices || []).slice(0, 6).map(priceLabel),
    gen: s.gen ?? null, opacityFallback: !!s.opacityFallback,
    frames: (s.frames || []).slice(0, 8).map((f: any) => ({ host: f.host, w: f.w, h: f.h })),
    identity: id ? {
      emails: (id.emails || []).map((e: any) => ({ value: maskEmail(e?.value), source: e?.source ?? null })),
      hintSources: Array.from(new Set((id.hints || []).map((h: any) => h?.source).filter(Boolean))),
    } : null,
    text: logText(s.text),
  };
}

/** The whole snapshot the model saw, scrubbed as it was sent (sanitizeSnapshot) and capped; trace() then masks every
 *  email and secret left in any string. Element ids are kept, so a recorded decision still points at its element. */
const LABEL_VALUE_TYPES = new Set(['submit', 'button', 'reset', 'image']);   // their value is the button's label
/** Where a link goes, without its query: return URLs, emails and names ride in query strings. */
function originPath(href: string): string {
  try { const u = new URL(href); return u.origin + u.pathname + (u.hash && !u.hash.includes('=') ? u.hash : ''); } catch { return '[link]'; }
}
function recordElement(e: any): any {
  if (!e || typeof e !== 'object') return e;
  const o = { ...e };
  // Any value is what someone typed or picked, except a button's own label: a <label> carries its (maybe hidden)
  // control's type and value, so the tag says nothing.
  if (o.value != null && o.value !== '' && !LABEL_VALUE_TYPES.has(String(o.type || ''))) o.value = '[filled]';
  if (o.tag === 'select' && o.text) o.text = '[selected]';
  if (typeof o.href === 'string') o.href = originPath(o.href);
  return o;
}
export function recordSnapshot(snap: any): Record<string, unknown> | null {
  if (!snap) return null;
  const s: any = sanitizeSnapshot(snap);
  return {
    url: typeof s.url === 'string' ? originPath(s.url) : s.url, title: s.title ?? '', headings: (s.headings || []).slice(0, 12), text: String(s.text || '').slice(0, 6000),
    textLength: s.textLength ?? String(s.text || '').length, hasPassword: !!s.hasPassword, prices: (s.prices || []).slice(0, 20),
    elements: (s.elements || []).slice(0, 120).map(recordElement), identity: s.identity ?? null, frames: s.frames ?? [],
  };
}
/** One recorded page of a flow (a probe page or a walk step), when recording is on. */
export function recordPage(data: Record<string, unknown>, snap: any): void {
  if (!traceRecording()) return;
  trace('flow.page', { ...data, snapshot: recordSnapshot(snap) });
}

async function persist(): Promise<void> {
  if (!log) return;
  let size = JSON.stringify(log).length;
  // Too big for storage: shed bulk from the oldest events first — page text, then button lists, then any other
  // top-level text — keeping every event itself. Savings are estimated per field, not by re-serializing the log.
  const shed = (holder: (e: any) => any, k: string, to: unknown) => {
    for (const e of log!.events as any[]) {
      if (size <= MAX_BYTES) return;
      const o = holder(e), v = o?.[k];
      if (v == null || JSON.stringify(v) === JSON.stringify(to)) continue;
      size -= JSON.stringify(v).length - JSON.stringify(to).length;
      o[k] = to;
    }
  };
  const page = (e: any) => (e.page && typeof e.page === 'object' ? e.page : null);
  if (size > MAX_BYTES) shed(page, 'text', DROPPED);
  if (size > MAX_BYTES) shed(page, 'buttons', []);
  if (size > MAX_BYTES) shed((e) => e, 'text', DROPPED);
  if (size > MAX_BYTES) shed((e) => e, 'snapshot', null);   // recorded pages go last: they are what a walk run is for
  try { await browser.storage.local.set({ [KEY]: log }); persistFailed = false; }
  catch (err: any) {
    // Storage full or unavailable: the in-memory log still exists (traceEnd returns it). Say so once, in the log.
    if (!persistFailed) { persistFailed = true; const t = Date.now(); log.events.push({ t, dt: t - log.startedAt, kind: 'trace.persist_failed', error: String(err?.message || err), size }); }
  }
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

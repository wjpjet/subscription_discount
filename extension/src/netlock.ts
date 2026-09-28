/**
 * The safety lock on a walk's tab: a wrong press can't reach the site.
 *
 * The walk has to start a cancellation to see the offer, and some sites label the final button like any other step.
 * So while a walk is in a cancellation flow, Chrome itself refuses every request from that tab that would change
 * something and names a cancellation in its address: POST, PUT, PATCH or DELETE to a URL with cancel, terminate,
 * unsubscribe, deactivate, pause or downgrade in it. Pages, surveys and offers still load (they are read with GET),
 * and a mis-pressed "Cancel plan" fails on the site's side. declarativeNetRequest session rules scoped by tabIds (one
 * substring rule per word), so nothing else in the browser is touched; session rules are gone when the browser restarts.
 *
 * It can't see inside request bodies (a GraphQL mutation to /graphql passes), so it is one layer under the click
 * rules, not a replacement. In test mode every changing request from a locked tab is logged ('netlock.request'),
 * blocked or not, so the pattern can be tightened from real flows. Held tabs stay locked; the accept after payment
 * lifts the lock only for its own press.
 */
import { browser } from '#imports';
import { scrubUrl } from '../../shared/scrub.js';
import { trace, tracing } from './trace';

/** The words, matched anywhere in the address and in any case: one Chrome substring rule (urlFilter) per word per tab.
 *  A single regex over all of them compiles past Chrome's 2KB limit and is skipped. */
export const LOCK_WORDS = ['cancel', 'terminat', 'unsubscri', 'deactivat', 'downgrade', 'pause',
  'end-membership', 'end_membership', 'endmembership', 'end-subscription', 'end_subscription', 'endsubscription'];
const CHANGING = ['post', 'put', 'patch', 'delete'];
const TYPES = ['main_frame', 'sub_frame', 'xmlhttprequest', 'ping', 'other'];
// Rule ids come from a reserved range (tab ids run into the billions, too big to fold into an id), allocated one call at a time.
const RULE_MIN = 700_000, RULE_MAX = 799_999;
type Rule = { id: number; condition?: { tabIds?: number[] } };
const ours = (r: Rule) => r.id >= RULE_MIN && r.id <= RULE_MAX;
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> { const run = chain.then(fn, fn); chain = run.catch(() => undefined); return run; }

/** Tabs locked from this panel, and the service each one walks (for the log). */
const locked = new Map<number, string>();
const dnr = () => (browser as any).declarativeNetRequest as undefined | {
  updateSessionRules(o: { removeRuleIds?: number[]; addRules?: unknown[] }): Promise<void>;
  getSessionRules(): Promise<Rule[]>;
};

/** Would the lock refuse this request? (What the rules do, for tests and the log.) */
export function lockBlocks(method: string, url: string): boolean {
  const u = String(url).toLowerCase();
  return CHANGING.includes(String(method).toLowerCase()) && LOCK_WORDS.some((w) => u.includes(w));
}

/** Lock a walk's tab. False when Chrome's rule engine is unavailable (an older build without the permission). */
export async function lockTab(tabId: number, svc: string): Promise<boolean> {
  const d = dnr();
  if (!d?.updateSessionRules) { trace('netlock.unavailable', { svc, tabId }); return false; }
  return serial(async () => {
    try {
      const rules = await d.getSessionRules();
      const old = rules.filter((r) => ours(r) && r.condition?.tabIds?.includes(tabId)).map((r) => r.id);
      const used = new Set(rules.map((r) => r.id).filter((id) => !old.includes(id)));
      const ids: number[] = [];
      for (let id = RULE_MIN; ids.length < LOCK_WORDS.length && id <= RULE_MAX; id++) if (!used.has(id)) ids.push(id);
      await d.updateSessionRules({ removeRuleIds: old, addRules: LOCK_WORDS.map((w, k) => ({
        id: ids[k], priority: 1, action: { type: 'block' },
        condition: { urlFilter: w, isUrlFilterCaseSensitive: false, requestMethods: CHANGING, tabIds: [tabId], resourceTypes: TYPES },
      })) });
      if (!locked.has(tabId)) trace('netlock.on', { svc, tabId });
      locked.set(tabId, svc);
      observe();
      return true;
    } catch (e: any) { trace('netlock.error', { svc, tabId, error: String(e?.message || e).slice(0, 200) }); return false; }
  });
}
/** Lift the lock (the accept's own press, a released or closed tab). Never throws. */
export async function unlockTab(tabId: number): Promise<void> {
  const svc = locked.get(tabId);
  locked.delete(tabId);
  const d = dnr();
  if (!d?.getSessionRules) return;
  await serial(async () => {
    try {
      const ids = (await d.getSessionRules()).filter((r) => ours(r) && r.condition?.tabIds?.includes(tabId)).map((r) => r.id);
      if (ids.length) await d.updateSessionRules({ removeRuleIds: ids });
      if (svc) trace('netlock.off', { svc, tabId });
    } catch { /* already gone */ }
  });
}
/** On panel open: drop the locks a closed panel left behind, except those on tabs still held on an offer. */
export async function unlockAllExcept(keep: number[]): Promise<number> {
  const d = dnr();
  if (!d?.getSessionRules) return 0;
  return serial(async () => {
    try {
      const stale = (await d.getSessionRules()).filter((r) => ours(r) && !(r.condition?.tabIds || []).some((t) => keep.includes(t))).map((r) => r.id);
      if (stale.length) await d.updateSessionRules({ removeRuleIds: stale });
      return stale.length;
    } catch { return 0; }
  });
}
export const isLocked = (tabId: number) => locked.has(tabId);

// Test mode: what did a locked tab try to send? Method, where (scrubbed, no query), a GraphQL operation name when the
// body is JSON with one (never the body itself), and whether the lock refused it.
let listening = false;
function observe(): void {
  const wr = (browser as any).webRequest;
  if (listening || !tracing() || !wr?.onBeforeRequest) return;
  listening = true;
  wr.onBeforeRequest.addListener((d: any) => {
    const svc = locked.get(d.tabId);
    if (!svc || !CHANGING.includes(String(d.method).toLowerCase())) return;
    let where = '';
    try { const u = new URL(d.url); where = scrubUrl(u.origin + u.pathname); } catch { where = '[bad url]'; }
    trace('netlock.request', { svc, method: d.method, type: d.type, url: where, op: operationName(d.requestBody), blocked: lockBlocks(d.method, d.url) });
  }, { urls: ['<all_urls>'] }, ['requestBody']);
}
function operationName(body: any): string | null {
  try {
    const raw = body?.raw?.[0]?.bytes;
    if (!raw) return null;
    const m = new TextDecoder().decode(raw).slice(0, 4000).match(/"operationName"\s*:\s*"([A-Za-z0-9_]{1,60})"/);
    return m?.[1] ?? null;
  } catch { return null; }
}

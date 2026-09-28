export type SnapshotRegion = 'dialog' | 'main' | 'page' | 'nav';
export interface SnapshotElement { id: number; tag: string; text: string; label?: string; role?: string; href?: string; newTab?: boolean; type?: string; name?: string; placeholder?: string; value?: string; checked?: boolean; expanded?: boolean; options?: string[]; disabled?: boolean; offscreen?: boolean; region?: SnapshotRegion }
export type PriceUnit = 'month' | 'year' | 'week' | 'quarter' | '';
/** `currency` is an ISO code ('USD' for a bare `$`); `unit` is normalized. `context` is ~120 chars before and 45
 *  after, whole words only; sanitizeSnapshot scrubs it and trims the head. */
export interface PagePrice { amount: number; currency: string; unit: PriceUnit; context: string }
/**
 * source: 'account-menu' | 'login-form' | 'form' | 'page-data' (a login-form email is remembered, not signed in).
 * An ambiguous source (a menu or avatars listing several people, several page-data addresses) yields none.
 */
export interface IdentityEmail { value: string; source: string }
export interface IdentityHint { source: string; text: string }
export interface PageIdentity { emails: IdentityEmail[]; hints: IdentityHint[] }
export interface PageFrame { host: string; w: number; h: number }
export interface PageSnapshot {
  url: string; title: string; headings: string[];
  /** VISIBLE text only, in priority order (open dialogs → main → rest → nav/aside), ≤ textChars. On a long page the
   *  short account / sign-in / sign-out lines of the rest and nav move up, after main's first ~1500 chars. */
  text: string;
  /** length of the full visible text before the cap */
  textLength: number;
  /** a VISIBLE password input exists (document or any open shadow root) */
  hasPassword: boolean;
  /** from the visible text only, ≤ 40 */
  prices: PagePrice[];
  /** ≤ maxElements: dialogs first, then up to min(15, maxElements/5) nav/page controls naming the account, sign in/out,
   *  billing or plan, then the rest by region (main → page → nav); listed in region order, ids 1..N. */
  elements: SnapshotElement[];
  /** this snapshot's generation; elements are tagged data-wa-id="<gen>:<id>" and <html data-wa-gen> holds it */
  gen: string;
  identity: PageIdentity;
  /** visible iframes ≥ 200×100 (diagnostic only; never read) */
  frames: PageFrame[];
  /** set when the ancestor-opacity rule was skipped because it would have hidden most of the page */
  opacityFallback?: boolean;
  scrollY: number; scrollHeight: number; viewportHeight: number;
}
export interface Readiness { url: string; readyState: string; visibleTextLen: number; interactiveCount: number; hasPassword: boolean; busy: boolean; loadingText: boolean; challenge: boolean; dialog: string }
/** The live element right before acting; `text` uses the same naming rules as the snapshot. */
export interface LiveElement { text: string; label: string; type: string; name: string; tag: string; disabled: boolean; checked?: boolean }
/** `expect` (click / accept_offer): the LiveElement `text` the caller checked; a different live text refuses the click. */
export interface PageAction { type: string; id?: number | null; gen?: string | null; text?: string | null; value?: string | null; direction?: string | null; expect?: string | null }
export function snapshotPage(opts?: { maxElements?: number; textChars?: number; domain?: string }): PageSnapshot;
/** null when the element is gone or `gen` is not the page's current generation. */
export function readElement(id: number, gen?: string | null): LiveElement | null;
/**
 * { ok:false, note:'page changed since it was read' } when `gen` is not the page's current generation, or when a
 * click's `expect` differs (whitespace-normalized) from the element's live text; nothing is clicked then.
 */
export function performAction(action: PageAction): { ok: boolean; note: string };
export function readinessProbe(): Readiness;

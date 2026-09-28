// A fake Chrome for tabs.ts/hunt.ts: tabs with a load lifecycle, scripting dispatched to fake pages, storage.
export const fake = { tabs: new Map(), nextId: 100, created: [], removed: [], updates: [], clicks: [], exec: [], fns: {}, pageFor: () => new Page({ url: 'about:blank' }), genCounter: 0, rules: new Map() };
/** Is a safety-lock rule (declarativeNetRequest session rule) on this tab right now? */
export const lockedTab = (tabId) => [...fake.rules.values()].some((r) => r.condition?.tabIds?.includes(tabId));
const L = { updated: new Set(), removed: new Set() };
const fire = (set, ...a) => { for (const f of [...set]) f(...a); };
export function navigate(tab, url, delay = 40) {
  const seq = tab.navSeq = (tab.navSeq || 0) + 1;
  tab.pendingUrl = url; tab.status = 'loading';
  setTimeout(() => fire(L.updated, tab.id, { status: 'loading' }), 0);
  setTimeout(() => {
    if (!fake.tabs.has(tab.id) || tab.navSeq !== seq) return;
    tab.pendingUrl = undefined; tab.url = url; tab.page = fake.pageFor(url, tab); tab.page.tab = tab;
    fire(L.updated, tab.id, { url });
    setTimeout(() => { if (!fake.tabs.has(tab.id) || tab.navSeq !== seq) return; if (tab.page.neverComplete) return; tab.status = 'complete'; fire(L.updated, tab.id, { status: 'complete' }); }, delay);
  }, delay);
}
export class Page {
  constructor(o) { Object.assign(this, { title: '', text: '', elements: [], hasPassword: false, errorPage: false, busy: false, loadingText: false, challenge: false, dialog: '', readyState: 'complete', gen: '' }, o); }
  snapshot() { this.gen = 'g' + (++fake.genCounter); return { url: this.url, title: this.title, headings: [], text: this.text, textLength: this.text.length, hasPassword: this.hasPassword, prices: [], elements: this.elements.map((e) => ({ id: e.id, tag: e.tag || 'button', text: e.text, ...(e.label ? { label: e.label } : {}), ...(e.href ? { href: e.href } : {}), ...(e.newTab ? { newTab: true } : {}), ...(e.type ? { type: e.type } : {}), ...(e.role ? { role: e.role } : {}), ...(e.checked != null ? { checked: e.checked } : {}) })), gen: this.gen, identity: { emails: [], hints: [] }, frames: [], scrollY: 0, scrollHeight: 1000, viewportHeight: 800 }; }
  readElement(id, gen) { if (gen && gen !== this.gen) return null; const e = this.elements.find((x) => x.id === id); return e ? { text: e.liveText ?? e.text, label: e.label || '', type: e.type || '', name: '', tag: e.tag || 'button', disabled: false, ...(e.checked != null ? { checked: e.checked } : {}) } : null; }
  performAction(a) {
    if (a.gen && a.gen !== this.gen && a.type !== 'scroll') return { ok: false, note: 'page changed since it was read' };
    if (a.type === 'scroll') return { ok: true, note: 'scrolled' };
    const e = this.elements.find((x) => x.id === a.id); if (!e) return { ok: false, note: 'element not found' };
    // The pinned page-side rule: with `expect`, the label is re-read at the click; if it changed since readElement, nothing is pressed.
    const n = (x) => String(x ?? '').replace(/\s+/g, ' ').trim();
    if (a.expect != null && n(e.liveText ?? e.text) !== n(a.expect)) return { ok: false, note: 'page changed since it was read' };
    fake.clicks.push({ tabId: this.tab.id, text: e.text, url: this.url, locked: lockedTab(this.tab.id), sameTab: !!a.sameTab }); if (e.onClick) e.onClick(this.tab, this); return { ok: true, note: `clicked "${e.text}"` };
  }
  readiness() { return { url: this.url, readyState: this.readyState, visibleTextLen: this.text.length, interactiveCount: this.elements.length, hasPassword: this.hasPassword, busy: this.busy, loadingText: this.loadingText, challenge: this.challenge, dialog: this.dialog }; }
}
const blank = () => new Page({ url: 'about:blank' });
function store() {
  let d = {};
  return { async get(k) { if (k == null) return { ...d }; const ks = Array.isArray(k) ? k : [k]; const o = {}; for (const x of ks) if (x in d) o[x] = JSON.parse(JSON.stringify(d[x])); return o; },
    async set(o) { for (const [k, v] of Object.entries(o)) d[k] = JSON.parse(JSON.stringify(v)); }, async remove(k) { for (const x of [].concat(k)) delete d[x]; }, clear() { d = {}; }, dump: () => d };
}
export const browser = {
  tabs: {
    async create({ url, active }) { const id = fake.nextId++; const tab = { id, url: '', status: 'loading', pendingUrl: url, active, discarded: false, page: blank() }; tab.page.tab = tab; fake.tabs.set(id, tab); fake.created.push({ id, url, active }); navigate(tab, url); return { id }; },
    async get(id) { const t = fake.tabs.get(id); if (!t) throw new Error(`No tab with id: ${id}.`); return { id, url: t.url, pendingUrl: t.pendingUrl, status: t.status, discarded: t.discarded, windowId: 1 }; },
    async update(id, p) { const t = fake.tabs.get(id); if (!t) throw new Error(`No tab with id: ${id}.`); fake.updates.push({ id, ...p }); if ('autoDiscardable' in p) t.autoDiscardable = p.autoDiscardable; if (p.url) { t.discarded = false; navigate(t, p.url); } return {}; },
    async remove(id) { if (!fake.tabs.has(id)) throw new Error(`No tab with id: ${id}.`); fake.tabs.delete(id); fake.removed.push(id); setTimeout(() => fire(L.removed, id), 0); },
    onUpdated: { addListener: (f) => L.updated.add(f), removeListener: (f) => L.updated.delete(f) },
    onRemoved: { addListener: (f) => L.removed.add(f), removeListener: (f) => L.removed.delete(f) },
  },
  windows: { async update() { return {}; } },
  scripting: {
    async executeScript({ target: { tabId }, func, args = [] }) {
      const t = fake.tabs.get(tabId); if (!t) throw new Error(`No tab with id: ${tabId}.`);
      const which = Object.keys(fake.fns).find((k) => fake.fns[k] === func) || 'readyState';
      fake.exec.push({ tabId, which, args });
      if (t.discarded) throw new Error('Cannot access contents of the page (discarded)');
      if (t.page.errorPage) throw new Error('Frame with ID 0 is showing error page');
      const p = t.page;
      const r = which === 'snapshotPage' ? p.snapshot() : which === 'readElement' ? p.readElement(...args) : which === 'performAction' ? p.performAction(...args) : which === 'readinessProbe' ? p.readiness() : p.readyState;
      return [{ result: r }];
    },
  },
  storage: { local: store(), session: store() },
  declarativeNetRequest: {
    async updateSessionRules({ removeRuleIds = [], addRules = [] }) { for (const id of removeRuleIds) fake.rules.delete(id); for (const r of addRules) fake.rules.set(r.id, JSON.parse(JSON.stringify(r))); },
    async getSessionRules() { return [...fake.rules.values()]; },
  },
  runtime: { getManifest: () => ({ version: 'test' }) },
};
export const listeners = L;

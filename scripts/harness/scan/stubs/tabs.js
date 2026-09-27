// Fake tabs: every URL resolves through globalThis.__pages { url: { final?, snap } }; anything else is a signed-out 404.
const tabs = new Map(); let next = 1;
function route(url) {
  const p = (globalThis.__pages || {})[url];
  if (!p) return { snap: { url, title: 'Page not found', headings: ['404 Not Found'], text: 'Sorry, this page could not be found.', textLength: 40, hasPassword: false, elements: [], prices: [], identity: { emails: [], hints: [] } } };
  return { snap: { textLength: (p.snap.text || '').length, hasPassword: false, prices: [], identity: { emails: [], hints: [] }, headings: [], elements: [], ...p.snap, url: p.final || url } };
}
export async function openTab(url) { const id = next++; tabs.set(id, route(url)); (globalThis.__opened ||= []).push(url); return id; }
export async function waitForPage() { return { kind: 'complete', ms: 1 }; }
export async function navigateTab(id, url) { tabs.set(id, route(url)); (globalThis.__opened ||= []).push(url); return true; }
export async function waitForContent(id) { const s = tabs.get(id).snap; return { kind: 'ready', ms: 1, probe: { visibleTextLen: 500, interactiveCount: 5, challenge: false, url: s.url, dialog: '' }, urlChanged: false }; }
export async function runInTab(id) { return structuredClone(tabs.get(id).snap); }
export async function closeTab(id) { tabs.delete(id); }
export function classifyTabError() { return 'other'; }
export async function closeOrphanTabs() { return 0; }
export async function ownedPausedTab() { return false; }

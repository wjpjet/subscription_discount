import { browser } from '#imports';
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export async function openTab(url: string, active: boolean): Promise<number> {
  const t = await browser.tabs.create({ url, active });
  if (t.id == null) throw new Error('Could not open a tab');
  return t.id;
}
/** Resolves true when the tab finished loading, false if it gave up after timeoutMs (the test log records which). */
export function waitForLoad(tabId: number, timeoutMs = 20000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (loaded: boolean) => { if (done) return; done = true; browser.tabs.onUpdated.removeListener(listener); clearTimeout(timer); resolve(loaded); };
    const listener = (id: number, info: any) => { if (id === tabId && info && info.status === 'complete') finish(true); };
    browser.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish(false), timeoutMs);
    browser.tabs.get(tabId).then((t) => { if (t.status === 'complete') finish(true); }).catch(() => finish(false));
  });
}
export async function runInTab<T>(tabId: number, func: (...args: any[]) => T, args: any[] = []): Promise<T> {
  const res = await browser.scripting.executeScript({ target: { tabId }, func, args });
  return res?.[0]?.result as T;
}
export async function closeTab(tabId: number) { try { await browser.tabs.remove(tabId); } catch { /* gone */ } }
export async function focusTab(tabId: number) {
  try { const t = await browser.tabs.get(tabId); await browser.tabs.update(tabId, { active: true }); if (t.windowId != null) await browser.windows.update(t.windowId, { focused: true }); } catch { /* gone */ }
}
export async function tabUrl(tabId: number): Promise<string> { try { return (await browser.tabs.get(tabId)).url || ''; } catch { return ''; } }
export async function navigateTab(tabId: number, url: string): Promise<boolean> { await browser.tabs.update(tabId, { url }); return waitForLoad(tabId); }
/** Is a tab we paused on still there? Users close tabs; the extension may have been reloaded. */
export async function tabAlive(tabId: number): Promise<boolean> { try { await browser.tabs.get(tabId); return true; } catch { return false; } }

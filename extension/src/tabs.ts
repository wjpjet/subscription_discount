import { browser } from '#imports';
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export async function openTab(url: string, active: boolean): Promise<number> {
  const t = await browser.tabs.create({ url, active });
  if (t.id == null) throw new Error('Could not open a tab');
  return t.id;
}
export function waitForLoad(tabId: number, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; browser.tabs.onUpdated.removeListener(listener); clearTimeout(timer); resolve(); };
    const listener = (id: number, info: any) => { if (id === tabId && info && info.status === 'complete') finish(); };
    browser.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
    browser.tabs.get(tabId).then((t) => { if (t.status === 'complete') finish(); }).catch(finish);
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
export async function navigateTab(tabId: number, url: string) { await browser.tabs.update(tabId, { url }); await waitForLoad(tabId); }

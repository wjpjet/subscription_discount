import { getSettings } from './settings';
export async function apiAvailable(): Promise<boolean> { return !!(await getSettings()).apiBase; }
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const s = await getSettings();
  if (!s.apiBase) throw new Error('No API URL configured — open Settings (⚙) and enter your Netlify site URL.');
  const url = s.apiBase.replace(/\/+$/, '') + path;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(s.clientKey ? { 'x-walkaway-key': s.clientKey } : {}) }, body: JSON.stringify(body) });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error || `API error ${res.status}`);
  return j as T;
}

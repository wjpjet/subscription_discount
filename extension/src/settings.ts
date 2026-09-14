import { browser } from '#imports';
export interface Settings { apiBase: string; clientKey: string; testMode: boolean; testDomain: string; testAccountUrl: string; testName: string; watch: boolean; maxSteps: number; skipPayment: boolean }
// Set WXT_API_BASE in extension/.env (e.g. https://your-site.netlify.app) before `npm run package:extension`.
export const DEFAULTS: Settings = { apiBase: (import.meta as any).env?.WXT_API_BASE || '', clientKey: '', testMode: false, testDomain: '', testAccountUrl: '', testName: 'Test service', watch: false, maxSteps: 25, skipPayment: true };
export async function getSettings(): Promise<Settings> { const v = await browser.storage.local.get('settings'); return { ...DEFAULTS, ...((v.settings as Partial<Settings>) || {}) }; }
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> { const next = { ...(await getSettings()), ...patch }; await browser.storage.local.set({ settings: next }); return next; }

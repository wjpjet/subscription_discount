import { browser } from '#imports';
export interface Settings { apiBase: string; clientKey: string; testMode: boolean; testDomain: string; testAccountUrl: string; testName: string; watch: boolean; maxSteps: number }
export const DEFAULTS: Settings = { apiBase: '', clientKey: '', testMode: false, testDomain: '', testAccountUrl: '', testName: 'Test service', watch: false, maxSteps: 25 };
export async function getSettings(): Promise<Settings> { const v = await browser.storage.local.get('settings'); return { ...DEFAULTS, ...((v.settings as Partial<Settings>) || {}) }; }
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> { const next = { ...(await getSettings()), ...patch }; await browser.storage.local.set({ settings: next }); return next; }

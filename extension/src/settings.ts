import { browser } from '#imports';
export interface Settings { apiBase: string; clientKey: string; restrictedMode: boolean; extraAllow: string; extraBlock: string; watch: boolean; maxSteps: number; skipPayment: boolean; maxHunts: number }
// Set WXT_API_BASE in extension/.env (e.g. https://your-site.netlify.app) before `npm run package:extension`.
// Restricted mode is ON by default in this build: only sites in allowlist.json (+ Settings) are scanned or hunted.
// Payment is required by default (Stripe test mode with the 4242 card while testing).
export const DEFAULTS: Settings = { apiBase: (import.meta as any).env?.WXT_API_BASE || '', clientKey: '', restrictedMode: true, extraAllow: '', extraBlock: '', watch: false, maxSteps: 25, skipPayment: false, maxHunts: 10 };
export async function getSettings(): Promise<Settings> { const v = await browser.storage.local.get('settings'); return { ...DEFAULTS, ...((v.settings as Partial<Settings>) || {}) }; }
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> { const next = { ...(await getSettings()), ...patch }; await browser.storage.local.set({ settings: next }); return next; }

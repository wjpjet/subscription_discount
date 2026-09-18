/**
 * Discovery: which subscription services is this browser signed into?
 *  1. Every cookie the browser has (needs <all_urls>, requested at Scan time) → registrable domains,
 *     keeping only domains with session-like cookies. Cookie VALUES are never read past the name.
 *  2. Those domain NAMES go to the brain (/api/discover), which decides which are subscription
 *     services, where the account page is, and what a typical loyalty offer looks like.
 *  3. Test mode: exactly one candidate — the configured test domain.
 */
import { browser } from '#imports';
import { etld1, isInfra, AUTH_COOKIE_RE } from '../../shared/domains.js';
import { apiPost, apiAvailable } from './api';
import type { Settings } from './settings';
import type { DiscoveredService } from './types';
import { allowlist, isBlocked } from './lists';

export interface Candidate { domain: string; name: string; accountUrl: string; source: 'ai' | 'allowlist'; typicalPrice: number | null; makesOffers: 'likely' | 'unlikely' | 'unknown'; discountPct: number; termMonths: number; confidence: number; notes?: string }
export interface DomainFeatures { domain: string; cookies: number; httpOnly: number; authLike: number }

export function originsFor(settings: Settings): string[] {
  if (!settings.restrictedMode) return ['<all_urls>'];
  return allowlist(settings.extraAllow).flatMap((e) => [`*://${e.domain}/*`, `*://*.${e.domain}/*`]);
}

export async function signedInDomains(): Promise<DomainFeatures[]> {
  const all = await browser.cookies.getAll({});
  const map = new Map<string, DomainFeatures>();
  for (const c of all) {
    const d = etld1(c.domain);
    if (!d || !d.includes('.') || isInfra(d)) continue;
    const f = map.get(d) || { domain: d, cookies: 0, httpOnly: 0, authLike: 0 };
    f.cookies++; if (c.httpOnly) f.httpOnly++; if (AUTH_COOKIE_RE.test(c.name)) f.authLike++;
    map.set(d, f);
  }
  return [...map.values()].filter((f) => f.httpOnly > 0 || f.authLike > 0).sort((a, b) => (b.httpOnly * 2 + b.authLike) - (a.httpOnly * 2 + a.authLike)).slice(0, 400);
}

export async function discoverCandidates(settings: Settings, onProgress: (msg: string) => void): Promise<{ candidates: Candidate[]; domainsChecked: number }> {
  if (settings.restrictedMode) {
    const entries = allowlist(settings.extraAllow).filter((e) => !isBlocked(e.domain, settings.extraBlock));
    if (!entries.length) throw new Error('Restricted mode is on but the allowlist is empty — edit extension/allowlist.json or add sites in Settings (⚙).');
    onProgress(`Restricted mode: checking ${entries.length} allowlisted site${entries.length === 1 ? '' : 's'}…`);
    // Every allowlisted site is probed; the account page decides whether you're signed in and what you pay.
    return { domainsChecked: entries.length, candidates: entries.map((e) => ({ domain: e.domain, name: e.name || e.domain, accountUrl: e.accountUrl || `https://${e.domain}/account`, source: 'allowlist' as const, typicalPrice: null, makesOffers: 'likely' as const, discountPct: 0.5, termMonths: 3, confidence: 1 })) };
  }
  if (!(await apiAvailable())) throw new Error('Scan needs the API URL — open Settings (⚙) and enter the backend URL, e.g. https://walkaway.<you>.workers.dev (or http://127.0.0.1:8787 under npm run cf:dev).');
  onProgress("Checking which sites you're signed into…");
  const feats = await signedInDomains();
  const domains = feats.map((f) => f.domain);
  // Small chunks, several in flight: every backend call stays short (Netlify functions time out at ~10s),
  // and the extension — a long-lived page — is the orchestrator.
  const CHUNK = 25, PARALLEL = 4;
  const chunks: string[][] = []; for (let i = 0; i < domains.length; i += CHUNK) chunks.push(domains.slice(i, i + CHUNK));
  const services: DiscoveredService[] = []; let done = 0, next = 0;
  onProgress(`Asking the brain which of ${domains.length} sites are subscription services… (0/${chunks.length})`);
  await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, async () => {
    while (next < chunks.length) {
      const mine = chunks[next++];
      const res = await apiPost<{ services: DiscoveredService[] }>('/api/discover', { domains: mine });
      services.push(...res.services); done++;
      onProgress(`Asking the brain which of ${domains.length} sites are subscription services… (${done}/${chunks.length})`);
    }
  }));
  const candidates: Candidate[] = services.filter((s) => s.isSubscription && !isBlocked(s.domain, settings.extraBlock)).map((s) => ({
    domain: s.domain, name: s.name || s.domain, accountUrl: s.accountUrl || `https://www.${s.domain}/account`, source: 'ai' as const,
    typicalPrice: s.typicalMonthlyPriceUsd ?? null, makesOffers: s.makesRetentionOffers,
    discountPct: s.typicalOfferDiscountPct ?? 0.5, termMonths: s.typicalOfferTermMonths ?? 3, confidence: s.confidence, notes: s.notes,
  }));
  return { candidates, domainsChecked: domains.length };
}

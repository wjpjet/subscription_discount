/**
 * Discovery: which subscription services is this browser signed into?
 *  1. Every cookie the browser has (needs <all_urls>, requested at Scan time) → registrable domains,
 *     keeping only domains with session-like cookies. Cookie VALUES are never read past the name.
 *  2. Those domain NAMES go to the brain (/api/discover), which decides which are subscription
 *     services and where the account page is.
 *  3. Restricted mode: exactly the allowlisted sites.
 */
import { browser } from '#imports';
import { etld1, isInfra, AUTH_COOKIE_RE } from '../../shared/domains.js';
import { apiPost, apiAvailable } from './api';
import { trace } from './trace';
import type { Settings } from './settings';
import type { DiscoveredService } from './types';
import { allowlist, isBlocked } from './lists';

export interface Candidate { domain: string; name: string; accountUrl: string; source: 'ai' | 'allowlist'; typicalPrice: number | null; makesOffers: 'likely' | 'unlikely' | 'unknown'; discountPct: number; termMonths: number; confidence: number; notes?: string }
export interface DomainFeatures { domain: string; cookies: number; httpOnly: number; authLike: number }

const MAX_SITES = 400;

export function originsFor(settings: Settings): string[] {
  if (!settings.restrictedMode) return ['<all_urls>'];
  return allowlist(settings.extraAllow).flatMap((e) => [`*://${e.domain}/*`, `*://*.${e.domain}/*`]);
}

export async function signedInDomains(): Promise<DomainFeatures[]> {
  const t0 = Date.now();
  const all = await browser.cookies.getAll({});
  const map = new Map<string, DomainFeatures>();
  let infra = 0, bare = 0;
  const infraSeen = new Set<string>();
  for (const c of all) {
    const d = etld1(c.domain);
    if (!d || !d.includes('.')) { bare++; continue; }
    if (isInfra(d)) { infra++; infraSeen.add(d); continue; }
    const f = map.get(d) || { domain: d, cookies: 0, httpOnly: 0, authLike: 0 };
    f.cookies++; if (c.httpOnly) f.httpOnly++; if (AUTH_COOKIE_RE.test(c.name)) f.authLike++;
    map.set(d, f);
  }
  const score = (f: DomainFeatures) => f.httpOnly * 2 + f.authLike;
  const kept = [...map.values()].filter((f) => f.httpOnly > 0 || f.authLike > 0).sort((a, b) => score(b) - score(a));
  const sent = kept.slice(0, MAX_SITES);
  // Counts and cookie NAMES' derived features only. No cookie value is ever read.
  trace('discover.cookies', {
    ms: Date.now() - t0, cookies: all.length, sites: map.size + infraSeen.size, infraSites: infraSeen.size, infraCookies: infra, bareHostCookies: bare,
    noSessionCookie: map.size - kept.length, signedInLike: kept.length, cappedAt: MAX_SITES, dropped: Math.max(0, kept.length - MAX_SITES),
    sites_sent: sent.map((f) => ({ d: f.domain, c: f.cookies, h: f.httpOnly, a: f.authLike })),
    sites_dropped_by_cap: kept.slice(MAX_SITES).map((f) => f.domain),
  });
  return sent;
}

export async function discoverCandidates(settings: Settings, onProgress: (msg: string) => void): Promise<{ candidates: Candidate[]; domainsChecked: number }> {
  if (settings.restrictedMode) {
    const all = allowlist(settings.extraAllow);
    const entries = all.filter((e) => !isBlocked(e.domain, settings.extraBlock));
    trace('discover.restricted', { allowlist: all.map((e) => e.domain), blocked: all.filter((e) => !entries.includes(e)).map((e) => e.domain) });
    if (!entries.length) throw new Error('Restricted mode is on but the allowlist is empty — edit extension/allowlist.json or add sites in Settings (⚙).');
    onProgress(`Restricted mode: checking ${entries.length} allowlisted site${entries.length === 1 ? '' : 's'}…`);
    // Every allowlisted site is probed; the account page decides whether you're signed in and what you pay.
    return { domainsChecked: entries.length, candidates: entries.map((e) => ({ domain: e.domain, name: e.name || e.domain, accountUrl: e.accountUrl || `https://${e.domain}/account`, source: 'allowlist' as const, typicalPrice: null, makesOffers: 'likely' as const, discountPct: 0.5, termMonths: 3, confidence: 1 })) };
  }
  if (!(await apiAvailable())) throw new Error('Scan needs the API URL — open Settings (⚙) and enter the backend URL, e.g. https://walkaway.<you>.workers.dev (or http://127.0.0.1:8787 under npm run cf:dev).');
  onProgress("Checking which sites you're signed into…");
  const feats = await signedInDomains();
  const domains = feats.map((f) => f.domain);
  // Small chunks, several in flight: every backend call stays short and the extension is the orchestrator.
  const CHUNK = 25, PARALLEL = 4;
  const chunks: string[][] = []; for (let i = 0; i < domains.length; i += CHUNK) chunks.push(domains.slice(i, i + CHUNK));
  const services: DiscoveredService[] = []; let done = 0, next = 0;
  const failed: string[] = [];
  onProgress(`Asking the brain which of ${domains.length} sites are subscription services… (0/${chunks.length})`);
  await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, async () => {
    while (next < chunks.length) {
      const mine = chunks[next++] ?? [];
      try {
        const res = await apiPost<{ services: DiscoveredService[] }>('/api/discover', { domains: mine });
        services.push(...res.services);
        const missing = mine.filter((d) => !res.services.some((s) => s.domain === d));
        if (missing.length) trace('discover.missing', { note: 'the model returned no verdict for these domains', domains: missing });
      } catch (e: any) {
        // One failed chunk should not sink the scan; the domains in it are recorded and skipped.
        failed.push(...mine);
        trace('discover.chunk_failed', { domains: mine, error: String(e?.message || e) });
      }
      done++;
      onProgress(`Asking the brain which of ${domains.length} sites are subscription services… (${done}/${chunks.length})`);
    }
  }));
  if (failed.length && failed.length === domains.length) throw new Error('Could not reach the brain to identify subscriptions. Check the API URL in Settings.');
  const subs = services.filter((s) => s.isSubscription);
  const blocked = subs.filter((s) => isBlocked(s.domain, settings.extraBlock));
  trace('discover.verdicts', {
    sent: domains.length, answered: services.length, failed: failed.length, subscriptions: subs.length, blocked: blocked.map((s) => s.domain),
    // Every subscription verdict in full; for the rest just the name, so false negatives can be spotted.
    subscription: subs.map((s) => ({ domain: s.domain, name: s.name, category: s.category, accountUrl: s.accountUrl, price: s.typicalMonthlyPriceUsd, offers: s.makesRetentionOffers, confidence: s.confidence, notes: s.notes })),
    not_subscription: services.filter((s) => !s.isSubscription).map((s) => s.domain),
  });
  const candidates: Candidate[] = subs.filter((s) => !isBlocked(s.domain, settings.extraBlock)).map((s) => ({
    domain: s.domain, name: s.name || s.domain, accountUrl: s.accountUrl || `https://www.${s.domain}/account`, source: 'ai' as const,
    typicalPrice: s.typicalMonthlyPriceUsd ?? null, makesOffers: s.makesRetentionOffers,
    discountPct: s.typicalOfferDiscountPct ?? 0.5, termMonths: s.typicalOfferTermMonths ?? 3, confidence: s.confidence, notes: s.notes,
  }));
  return { candidates, domainsChecked: domains.length };
}

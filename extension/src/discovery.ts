/**
 * Discovery: which subscription services is this browser signed into?
 *  1. Every cookie the browser has (needs <all_urls>, requested at Scan time) → registrable domains,
 *     keeping only domains with session-like cookies. Cookie VALUES are never read past the name.
 *  2. Those domain NAMES go to the brain (/api/discover), which says which are subscription services
 *     and where their account page is. Curated playbooks win on conflicts.
 *  3. Test mode: exactly one candidate — the configured test domain.
 */
import { browser } from '#imports';
import { etld1, isInfra, AUTH_COOKIE_RE } from '../../shared/domains.js';
import { playbookForDomain, type Playbook } from '../../shared/playbooks.js';
import { apiPost, apiAvailable } from './api';
import type { Settings } from './settings';
import type { DiscoveredService } from './types';

export interface Candidate { domain: string; name: string; accountUrl: string; source: 'curated' | 'ai' | 'test'; typicalPrice: number | null; makesOffers: 'likely' | 'unlikely' | 'unknown'; confidence: number; playbook?: Playbook; notes?: string }
export interface DomainFeatures { domain: string; cookies: number; httpOnly: number; authLike: number }

export function originsFor(settings: Settings): string[] {
  return settings.testMode && settings.testDomain ? [`*://${settings.testDomain}/*`] : ['<all_urls>'];
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
  if (settings.testMode) {
    if (!settings.testDomain || !settings.testAccountUrl) throw new Error('Test mode needs a test domain and an account URL — open Settings (⚙).');
    return { domainsChecked: 1, candidates: [{ domain: settings.testDomain, name: settings.testName || 'Test service', accountUrl: settings.testAccountUrl, source: 'test', typicalPrice: null, makesOffers: 'likely', confidence: 1 }] };
  }
  onProgress("Checking which sites you're signed into…");
  const feats = await signedInDomains();
  const domains = feats.map((f) => f.domain);
  const out: Candidate[] = [];
  if (await apiAvailable()) {
    onProgress(`Asking the brain which of ${domains.length} sites are subscription services…`);
    const res = await apiPost<{ services: DiscoveredService[] }>('/api/discover', { domains });
    for (const s of res.services) {
      if (!s.isSubscription) continue;
      const pb = playbookForDomain(s.domain);
      out.push({ domain: s.domain, name: s.name || s.domain, accountUrl: pb?.accountUrl || s.accountUrl || `https://www.${s.domain}/account`, source: pb ? 'curated' : 'ai', typicalPrice: pb?.typicalPrice ?? s.typicalMonthlyPriceUsd ?? null, makesOffers: pb ? (pb.hasInflowOffer ? 'likely' : 'unlikely') : s.makesRetentionOffers, confidence: pb ? pb.confidence : s.confidence, playbook: pb, notes: s.notes });
    }
  } else {
    for (const d of domains) { const pb = playbookForDomain(d); if (pb) out.push({ domain: d, name: pb.name, accountUrl: pb.accountUrl, source: 'curated', typicalPrice: pb.typicalPrice, makesOffers: pb.hasInflowOffer ? 'likely' : 'unlikely', confidence: pb.confidence, playbook: pb }); }
  }
  return { candidates: out, domainsChecked: domains.length };
}

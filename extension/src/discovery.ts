/**
 * Discovery: which subscription services is this browser signed into?
 *  1. Every cookie the browser has (needs <all_urls>, requested at Scan time) → registrable domains,
 *     keeping only domains with session-like cookies. Cookie VALUES are never read past the name.
 *  2. Domains in the hand-checked catalog (shared/services.js) become candidates directly, with an account URL
 *     we are confident in; their names are not sent anywhere.
 *  3. The remaining domain NAMES go to the brain (/api/discover), which decides which are subscriptions an
 *     individual pays for and where the account page is. Its account URLs are checked before use, work/B2B,
 *     usage-billed and regulated services are filtered out, and services that share an account are merged.
 *  4. Restricted mode: exactly the allowlisted sites.
 */
import { browser } from '#imports';
import { etld1, isInfra, AUTH_COOKIE_RE } from '../../shared/domains.js';
import { sensitiveReason, SENSITIVE_CATEGORY_RE } from '../../shared/sensitive.js';
import { CATALOG, catalogFor } from '../../shared/services.js';
import { isLoginUrl } from '../../shared/accounts.js';
import { scrubUrl } from '../../shared/scrub.js';
import { apiPost, apiAvailable } from './api';
import { trace } from './trace';
import type { Settings } from './settings';
import type { DiscoveredService } from './types';
import { allowlist, isBlocked, blockReason, hostOf } from './lists';

export interface Candidate {
  domain: string; name: string; accountUrl: string; source: 'ai' | 'allowlist' | 'catalog'; typicalPrice: number | null; makesOffers: 'likely' | 'unlikely' | 'unknown'; discountPct: number; termMonths: number; confidence: number; notes?: string;
  /** Other signed-in domains that reach the same account and bill (amazon.com + primevideo.com). */
  aliases: string[];
  /** Fallback account URLs, tried in order when accountUrl is a 404 or error page. */
  altUrls: string[];
  /** The catalog's own other account pages (checked by hand): the only ones the probe opens just to find a price. */
  knownAltUrls?: string[];
  /** 0..1 prior that an individual with a session here pays personally; probes run highest first. */
  payLikelihood: number;
  /** Stable service id (catalog id or the model's canonicalService), null when unknown. */
  canonical: string | null;
}
export interface DomainFeatures { domain: string; cookies: number; httpOnly: number; authLike: number; hostOnly: number; sameSiteNone: number }

const MAX_SITES = 400;
const CHUNK = 25;
const DEFAULTS = { typicalPrice: null, makesOffers: 'unknown' as const, discountPct: 0.5, termMonths: 3 };

export function originsFor(settings: Settings): string[] {
  if (!settings.restrictedMode) return ['<all_urls>'];
  return allowlist(settings.extraAllow).flatMap((e) => [`*://${e.domain}/*`, `*://*.${e.domain}/*`]);
}

/** Lower-case slug, so 'Amazon Prime' from one chunk and 'amazon_prime' from another are one key. */
export function normKey(s: string | null | undefined): string | null {
  const k = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return k || null;
}

/** Third-party-only: no host-only cookie and every cookie SameSite=None, the ad-tracker pattern. Recorded, not yet acted on. */
const thirdPartyOnly = (f: DomainFeatures) => f.hostOnly === 0 && f.sameSiteNone === f.cookies;

/** `extraBlock`: the Never-explore list from Settings, withheld here like the built-in never-touch sites. */
export async function signedInDomains(extraBlock = ''): Promise<DomainFeatures[]> {
  const t0 = Date.now();
  const all = await browser.cookies.getAll({});
  const map = new Map<string, DomainFeatures>();
  let infra = 0, bare = 0;
  const infraSeen = new Set<string>();
  for (const c of all) {
    const d = etld1(c.domain);
    if (!d || !d.includes('.')) { bare++; continue; }
    if (isInfra(d)) { infra++; infraSeen.add(d); continue; }
    const f = map.get(d) || { domain: d, cookies: 0, httpOnly: 0, authLike: 0, hostOnly: 0, sameSiteNone: 0 };
    f.cookies++; if (c.httpOnly) f.httpOnly++; if (AUTH_COOKIE_RE.test(c.name)) f.authLike++;
    if (c.hostOnly) f.hostOnly++; if (c.sameSite === 'no_restriction') f.sameSiteNone++;
    map.set(d, f);
  }
  const score = (f: DomainFeatures) => f.httpOnly * 2 + f.authLike;
  const signedIn = [...map.values()].filter((f) => f.httpOnly > 0 || f.authLike > 0).sort((a, b) => score(b) - score(a));
  // Banks, government, health, payroll and the like, and every site on your Never-explore list (which "applies
  // in every mode"), are withheld HERE, by cookie domain, before anything leaves the browser: their names are
  // never sent to the model. Account URLs and the hosts a page lands on are checked again in scan.ts before a
  // tab opens and before any page text is sent.
  const why = new Map(signedIn.map((f) => [f.domain, blockReason(f.domain, extraBlock)] as const));
  const withheld = signedIn.filter((f) => why.get(f.domain));
  const kept = signedIn.filter((f) => !why.get(f.domain));
  trace('discover.withheld', { count: withheld.length, sites: withheld.map((f) => ({ d: f.domain, why: why.get(f.domain) })) });
  const sent = kept.slice(0, MAX_SITES);
  // Counts and cookie NAMES' derived features only. No cookie value is ever read.
  trace('discover.cookies', {
    ms: Date.now() - t0, cookies: all.length, sites: map.size + infraSeen.size, infraSites: infraSeen.size, infraCookies: infra, bareHostCookies: bare,
    noSessionCookie: map.size - signedIn.length, signedInLike: signedIn.length, withheldSensitive: withheld.filter((f) => sensitiveReason(f.domain)).length,
    withheldNeverExplore: withheld.filter((f) => !sensitiveReason(f.domain)).length, cappedAt: MAX_SITES, dropped: Math.max(0, kept.length - MAX_SITES),
    thirdPartyOnly: sent.filter(thirdPartyOnly).length,
    sites_sent: sent.map((f) => ({ d: f.domain, c: f.cookies, h: f.httpOnly, a: f.authLike, ho: f.hostOnly, sn: f.sameSiteNone, ...(thirdPartyOnly(f) ? { thirdPartyOnly: true } : {}) })),
    sites_dropped_by_cap: kept.slice(MAX_SITES).map((f) => f.domain),
  });
  return sent;
}

export async function discoverCandidates(settings: Settings, onProgress: (msg: string) => void): Promise<{ candidates: Candidate[]; domainsChecked: number }> {
  const extra = settings.extraBlock;
  if (settings.restrictedMode) {
    const all = allowlist(settings.extraAllow);
    const entries = all.filter((e) => !isBlocked(e.domain, extra));
    trace('discover.restricted', { allowlist: all.map((e) => e.domain), blocked: all.filter((e) => !entries.includes(e)).map((e) => e.domain) });
    if (!entries.length) throw new Error('Restricted mode is on but the allowlist is empty — edit extension/allowlist.json or add sites in Settings (⚙).');
    onProgress(`Restricted mode: checking ${entries.length} allowlisted site${entries.length === 1 ? '' : 's'}…`);
    // Every allowlisted site is probed; the account page decides whether you're signed in and what you pay.
    // No URL given: the catalog's verified one, else the site root (signed-in chrome links onward from there).
    const replaced: { d: string; from: string; to: string; why: string }[] = [];
    const candidates = entries.map((e) => {
      let url = e.accountUrl || catalogFor(e.domain)?.accountUrl || `https://${e.domain}/`;
      if (isBlocked(hostOf(url), extra)) { replaced.push({ d: e.domain, from: scrubUrl(url), to: `https://${e.domain}/`, why: 'blocked host' }); url = `https://${e.domain}/`; }
      return { domain: e.domain, name: e.name || e.domain, accountUrl: url, source: 'allowlist' as const, typicalPrice: null, makesOffers: 'likely' as const, discountPct: 0.5, termMonths: 3, confidence: 1, aliases: [], altUrls: [], payLikelihood: 1, canonical: null };
    });
    if (replaced.length) trace('discover.url_replaced', { sites: replaced });
    return { domainsChecked: entries.length, candidates };
  }
  if (!(await apiAvailable())) throw new Error('Scan needs the API URL — open Settings (⚙) and enter the backend URL, e.g. https://walkaway.<you>.workers.dev (or http://127.0.0.1:8787 under npm run cf:dev).');
  onProgress("Checking which sites you're signed into…");
  const feats = await signedInDomains(extra);
  const domains = feats.map((f) => f.domain);
  const signedIn = new Set(domains);

  // Catalog first: well-known services get their verified account URL, and their names never reach the model.
  const catalogHits = new Map<string, string[]>();
  const toModel: string[] = [];
  for (const d of domains) { const e = catalogFor(d); if (e) catalogHits.set(e.id, [...(catalogHits.get(e.id) || []), d]); else toModel.push(d); }
  const catalogCands: Candidate[] = [], catalogBlocked: string[] = [];
  for (const [id, ds] of catalogHits) {
    const e = CATALOG.find((x) => x.id === id)!;
    const open = ds.filter((d) => !isBlocked(d, extra));
    const [url, ...alt] = [e.accountUrl, ...(e.altUrls || [])].filter((u) => !isBlocked(hostOf(u), extra));
    // The domain the account page is on leads (amazon.com for Prime), the other signed-in domains are aliases.
    const lead = url ? open.find((d) => d === etld1(hostOf(url))) || open[0] : undefined;
    if (!url || !lead) { catalogBlocked.push(...ds); continue; }
    catalogCands.push({ domain: lead, name: e.name, accountUrl: url, source: 'catalog', ...DEFAULTS, confidence: 1, aliases: open.filter((d) => d !== lead), altUrls: alt, knownAltUrls: [...alt], payLikelihood: 1, canonical: e.id });
  }
  trace('discover.catalog', { count: catalogCands.length, services: catalogCands.map((c) => ({ id: c.canonical, d: c.domain, aliases: c.aliases, url: scrubUrl(c.accountUrl), alt: c.altUrls.length })), blocked: catalogBlocked });

  // Small chunks, all in flight at once: every backend call stays short and the extension is the orchestrator.
  const chunks: string[][] = []; for (let i = 0; i < toModel.length; i += CHUNK) chunks.push(toModel.slice(i, i + CHUNK));
  const PARALLEL = Math.min(chunks.length, 12);
  const services: DiscoveredService[] = []; let done = 0, next = 0;
  const failed: string[] = [];
  const ask = async (mine: string[]) => {
    try { return await apiPost<{ services: DiscoveredService[] }>('/api/discover', { domains: mine }); }
    catch (e: any) {
      // Many chunks at once can trip the model's per-minute limit: one retry after a short, jittered pause.
      trace('discover.chunk_retry', { domains: mine.length, error: String(e?.message || e) });
      await new Promise((r) => setTimeout(r, 1200 + Math.random() * 1300));
      return apiPost<{ services: DiscoveredService[] }>('/api/discover', { domains: mine });
    }
  };
  if (chunks.length) onProgress(`Asking the brain which of ${toModel.length} sites are subscription services… (0/${chunks.length})`);
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (next < chunks.length) {
      const mine = chunks[next++] ?? [];
      try {
        const res = await ask(mine);
        services.push(...res.services);
        const missing = mine.filter((d) => !res.services.some((s) => s.domain === d));
        if (missing.length) trace('discover.missing', { note: 'the model returned no verdict for these domains', domains: missing });
      } catch (e: any) {
        // One failed chunk should not sink the scan; the domains in it are recorded and skipped.
        failed.push(...mine);
        trace('discover.chunk_failed', { domains: mine, error: String(e?.message || e) });
      }
      done++;
      onProgress(`Asking the brain which of ${toModel.length} sites are subscription services… (${done}/${chunks.length})`);
    }
  }));
  if (toModel.length && failed.length === toModel.length && !catalogCands.length) throw new Error('Could not reach the brain to identify subscriptions. Check the API URL in Settings.');

  // Filters over the model's verdicts. A missing field (older backend) keeps the service: never drop blind.
  const filtered: { d: string; why: string }[] = [];
  const dropWhy = (s: DiscoveredService): string | null => {
    // Second net: anything the model itself files under banking, credit, investing, insurance, health,
    // government or payroll is dropped even if it also called it a subscription.
    if (s.regulatedFinancialOrHealth === true) return 'regulated financial or health';
    if (SENSITIVE_CATEGORY_RE.test(s.category || '')) return `sensitive category: ${s.category}`;
    if (s.audience === 'business') return 'business audience (employers or merchants pay)';
    if (s.billingModel != null && s.billingModel !== 'subscription') return `billing model: ${s.billingModel}`;
    if (typeof s.payLikelihood === 'number' && s.payLikelihood < 0.1) return `pay likelihood ${s.payLikelihood}`;
    return null;
  };
  const subsAll = services.filter((s) => s.isSubscription);
  const subs = subsAll.filter((s) => { const why = dropWhy(s); if (why) filtered.push({ d: s.domain, why }); return !why; });
  const blocked = subs.filter((s) => isBlocked(s.domain, extra));
  trace('discover.verdicts', {
    sent: toModel.length, answered: services.length, failed: failed.length, subscriptions: subs.length, blocked: blocked.map((s) => s.domain),
    // Every subscription verdict in full; for the rest the domain and the model's kind, so false negatives can be spotted.
    subscription: subsAll.map((s) => ({ domain: s.domain, name: s.name, canonical: normKey(s.canonicalService), category: s.category, audience: s.audience ?? null, billing: s.billingModel ?? null, pay: s.payLikelihood ?? null, accountUrl: s.accountUrl ? scrubUrl(s.accountUrl) : null, price: s.typicalMonthlyPriceUsd, offers: s.makesRetentionOffers, confidence: s.confidence, notes: s.notes })),
    not_subscription: services.filter((s) => !s.isSubscription).map((s) => ({ d: s.domain, c: s.category })),
  });
  if (filtered.length) trace('discover.filtered', { sites: filtered });

  // Account URLs: keep a guess only when it is on this service's site (or a site it is known to share, or one
  // you're signed into), not blocked and not a sign-in page. Otherwise the site root, which links onward.
  const replaced: { d: string; from: string | null; to: string; why: string }[] = [];
  const checkUrl = (s: DiscoveredService): string => {
    const root = `https://${s.domain}/`;
    const bad = (why: string) => { replaced.push({ d: s.domain, from: s.accountUrl ? scrubUrl(s.accountUrl) : null, to: root, why }); return root; };
    if (!s.accountUrl) return bad('no account URL');
    let u: URL; try { u = new URL(s.accountUrl); } catch { return bad('does not parse'); }
    if (!/^https?:$/.test(u.protocol)) return bad('not a web URL');
    const host = u.hostname.toLowerCase(), reg = etld1(host);
    if (isBlocked(host, extra)) return bad('blocked host');
    if (isLoginUrl(u.href)) return bad('sign-in page');
    const entry = catalogFor(s.domain) || CATALOG.find((e) => e.id === normKey(s.canonicalService));
    if (reg === s.domain || entry?.domains.includes(reg) || signedIn.has(reg)) return u.href;
    return bad(`other site (${reg})`);
  };
  const aiCands: Candidate[] = subs.filter((s) => !isBlocked(s.domain, extra)).map((s) => ({
    domain: s.domain, name: s.name || s.domain, accountUrl: checkUrl(s), source: 'ai' as const,
    typicalPrice: s.typicalMonthlyPriceUsd ?? null, makesOffers: s.makesRetentionOffers,
    discountPct: s.typicalOfferDiscountPct ?? 0.5, termMonths: s.typicalOfferTermMonths ?? 3, confidence: s.confidence, notes: s.notes,
    aliases: [], altUrls: [], payLikelihood: typeof s.payLikelihood === 'number' ? s.payLikelihood : 0.5, canonical: normKey(s.canonicalService),
  }));
  if (replaced.length) trace('discover.url_replaced', { sites: replaced });

  // One candidate per account and bill: catalog first, then the model's most confident verdict. The others'
  // domains become aliases (the walk may use them) and their account URLs become fallbacks.
  const byKey = new Map<string, Candidate>();
  const merges: { key: string; kept: string; merged: string }[] = [];
  const ordered = [...catalogCands, ...aiCands.sort((a, b) => b.confidence - a.confidence)];
  for (const c of ordered) {
    const key = c.canonical || etld1(hostOf(c.accountUrl)) || c.domain;
    const k = byKey.get(key);
    if (!k) { byKey.set(key, c); continue; }
    k.aliases = [...new Set([...k.aliases, c.domain, ...c.aliases])].filter((d) => d !== k.domain);
    k.altUrls = [...new Set([...k.altUrls, c.accountUrl, ...c.altUrls])].filter((u) => u !== k.accountUrl);
    merges.push({ key, kept: k.domain, merged: c.domain });
  }
  if (merges.length) trace('discover.dedupe', { merges });
  const candidates = [...byKey.values()].sort((a, b) => (b.payLikelihood - a.payLikelihood) || (b.confidence - a.confidence));
  return { candidates, domainsChecked: domains.length };
}

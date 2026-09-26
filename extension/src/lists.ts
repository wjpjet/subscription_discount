/** Restricted-mode allowlist and always-on blocklist. Bundled JSON files + extra lines from Settings. */
import allowJson from '../allowlist.json';
import blockJson from '../blocklist.json';
import { etld1 } from '../../shared/domains.js';
import { sensitiveReason } from '../../shared/sensitive.js';
export interface AllowEntry { domain: string; name?: string; accountUrl?: string }
export interface BlockEntry { domain: string; reason?: string }

function parseAllowLines(text: string): AllowEntry[] {
  return (text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const parts = l.split('|').map((x) => x.trim()); return { domain: (parts[0] || '').toLowerCase(), name: parts[1] || undefined, accountUrl: parts[2] || undefined }; }).filter((e) => e.domain);
}
function parseBlockLines(text: string): BlockEntry[] {
  return (text || '').split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean).map((domain) => ({ domain }));
}
export function allowlist(extra: string): AllowEntry[] {
  const seen = new Set<string>(); const out: AllowEntry[] = [];
  for (const e of [...(allowJson as AllowEntry[]), ...parseAllowLines(extra)]) { const d = e.domain.toLowerCase(); if (!seen.has(d)) { seen.add(d); out.push({ ...e, domain: d }); } }
  return out;
}
export function blocklist(extra: string): BlockEntry[] { return [...(blockJson as BlockEntry[]), ...parseBlockLines(extra)]; }
/** Why a host must never be explored: the built-in never-touch rules (banks, government, health...)
 *  first, then your blocklist. Null when it's fine. Applies in every mode and cannot be overridden. */
export function blockReason(host: string, extra: string): string | null {
  const h = (host || '').toLowerCase(); const d = etld1(h);
  const s = sensitiveReason(h); if (s) return s;
  return blocklist(extra).some((b) => h === b.domain || h.endsWith('.' + b.domain) || d === b.domain) ? 'on your never-explore list' : null;
}
/** True if host is off limits: a never-touch site, or a blocklisted domain or a subdomain of one. */
export function isBlocked(host: string, extra: string): boolean { return blockReason(host, extra) != null; }
export function hostOf(url: string): string { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } }

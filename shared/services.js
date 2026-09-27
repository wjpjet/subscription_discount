// A small, hand-checked catalog of common consumer subscriptions whose account page we are sure of. Plain ESM,
// used by the extension and the backend.
//
// A catalog hit skips the model entirely: its name is never sent to /api/discover, it gets a verified account URL
// instead of a guess (the first live run's guesses 404'd on Walmart, Claude, Amazon and a dozen more), and every
// domain that reaches the same account and bill shares one id (amazon.com + primevideo.com, apple.com + icloud.com).
// Only URLs verified in the live log or long-stable belong here; a stale entry is worse than none.
// microsoftonline.com is deliberately absent: it is the work-tenant sign-in host, not a consumer account.
import { etld1 } from './domains.js';

/** @type {{ id: string, name: string, domains: string[], accountUrl: string, altUrls?: string[] }[]} */
export const CATALOG = [
  { id: 'netflix', name: 'Netflix', domains: ['netflix.com'], accountUrl: 'https://www.netflix.com/account' },
  { id: 'youtube-premium', name: 'YouTube Premium', domains: ['youtube.com'], accountUrl: 'https://www.youtube.com/paid_memberships' },
  { id: 'linkedin-premium', name: 'LinkedIn Premium', domains: ['linkedin.com'], accountUrl: 'https://www.linkedin.com/premium/manage' },
  { id: 'twitch', name: 'Twitch', domains: ['twitch.tv'], accountUrl: 'https://www.twitch.tv/subscriptions' },
  { id: 'peacock', name: 'Peacock', domains: ['peacocktv.com'], accountUrl: 'https://www.peacocktv.com/account/plans' },
  { id: 'hulu', name: 'Hulu', domains: ['hulu.com'], accountUrl: 'https://secure.hulu.com/account' },
  { id: 'patreon', name: 'Patreon', domains: ['patreon.com'], accountUrl: 'https://www.patreon.com/memberships' },
  { id: 'chatgpt', name: 'ChatGPT', domains: ['chatgpt.com', 'openai.com'], accountUrl: 'https://chatgpt.com/settings/billing' },
  { id: 'amazon-prime', name: 'Amazon Prime', domains: ['amazon.com', 'primevideo.com'], accountUrl: 'https://www.amazon.com/gp/video/settings', altUrls: ['https://www.amazon.com/gp/primecentral'] },
  { id: 'spotify', name: 'Spotify', domains: ['spotify.com'], accountUrl: 'https://www.spotify.com/account/overview/' },
  { id: 'claude', name: 'Claude', domains: ['claude.ai', 'claude.com'], accountUrl: 'https://claude.ai/settings/billing' },
  { id: 'microsoft', name: 'Microsoft 365', domains: ['microsoft.com', 'live.com', 'xbox.com', 'office.com', 'microsoft365.com'], accountUrl: 'https://account.microsoft.com/services' },
  { id: 'apple', name: 'Apple', domains: ['apple.com', 'icloud.com'], accountUrl: 'https://account.apple.com/' },
  { id: 'cursor', name: 'Cursor', domains: ['cursor.com', 'cursor.sh'], accountUrl: 'https://cursor.com/dashboard' },
  { id: 'disney-plus', name: 'Disney+', domains: ['disneyplus.com'], accountUrl: 'https://www.disneyplus.com/account' },
  { id: 'hbo-max', name: 'HBO Max', domains: ['hbomax.com', 'max.com'], accountUrl: 'https://auth.hbomax.com/subscription' },
  { id: 'paramount-plus', name: 'Paramount+', domains: ['paramountplus.com'], accountUrl: 'https://www.paramountplus.com/account/' },
  { id: 'dropbox', name: 'Dropbox', domains: ['dropbox.com'], accountUrl: 'https://www.dropbox.com/account/plan' },
  { id: 'adobe', name: 'Adobe', domains: ['adobe.com'], accountUrl: 'https://account.adobe.com/plans' },
  { id: 'audible', name: 'Audible', domains: ['audible.com'], accountUrl: 'https://www.audible.com/account/overview' },
  { id: 'grammarly', name: 'Grammarly', domains: ['grammarly.com'], accountUrl: 'https://account.grammarly.com/subscription' },
  { id: 'medium', name: 'Medium', domains: ['medium.com'], accountUrl: 'https://medium.com/me/settings/membership' },
  { id: 'strava', name: 'Strava', domains: ['strava.com'], accountUrl: 'https://www.strava.com/account' },
  { id: 'elevenlabs', name: 'ElevenLabs', domains: ['elevenlabs.io'], accountUrl: 'https://elevenlabs.io/app/subscription' },
  { id: 'suno', name: 'Suno', domains: ['suno.com'], accountUrl: 'https://suno.com/account' },
  { id: 'midjourney', name: 'Midjourney', domains: ['midjourney.com'], accountUrl: 'https://www.midjourney.com/account' },
  { id: 'crunchyroll', name: 'Crunchyroll', domains: ['crunchyroll.com'], accountUrl: 'https://www.crunchyroll.com/account/membership' },
];

const BY_DOMAIN = new Map(CATALOG.flatMap((e) => e.domains.map((d) => [d, e])));
function siteOf(domainOrHost) {
  let s = String(domainOrHost || '').trim().toLowerCase();
  if (s.includes('/')) { try { s = new URL(s.includes('://') ? s : `https://${s}`).hostname; } catch { return ''; } }
  return etld1(s.replace(/:\d+$/, ''));
}
/** The catalog entry for a domain, host or URL (matched by registrable domain), or null. */
export const catalogFor = (domainOrHost) => BY_DOMAIN.get(siteOf(domainOrHost)) || null;
/** The catalog id shared by every domain of the same account and bill, or null when it isn't in the catalog. */
export const canonicalKey = (domainOrHost) => catalogFor(domainOrHost)?.id ?? null;

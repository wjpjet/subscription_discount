/**
 * Merchant playbooks — the known-services list.
 * This is also the Scan's domain filter: we only ever look at these domains.
 * Cookie names are used for PRESENCE checks only (never read or sent).
 * Prices/discounts are typical values used for the estimate until the account page gives us real ones.
 */
export interface Playbook {
  id: string;
  name: string;
  domains: string[];
  accountUrl: string;
  /** Known session-cookie names. Empty = treat "any cookie on the domain" as a weak candidate. */
  sessionCookieNames?: string[];
  /** If the account URL redirects somewhere containing one of these, we're at a login wall. */
  loginUrlPatterns?: string[];
  /** Lower-case text fragments that only appear when signed in with a plan. */
  signedInHints: string[];
  /** Lower-case text fragments that appear when signed in but with no paid plan. */
  noPlanHints?: string[];
  typicalPrice: number; // USD / month
  hasInflowOffer: boolean;
  typicalDiscountPct: number; // 0–1, of the monthly price
  typicalTermMonths: number;
  confidence: number; // 0–1, how sure we are the service makes in-flow offers
}

export const PLAYBOOKS: Playbook[] = [
  { id: 'siriusxm', name: 'SiriusXM', domains: ['siriusxm.com'], accountUrl: 'https://www.siriusxm.com/account',
    loginUrlPatterns: ['/login', '/signin', '/sign-in'], signedInHints: ['manage subscription', 'your subscription', 'billing', 'radio id', 'account overview', 'my subscriptions'],
    noPlanHints: ['start your free trial', 'subscribe now', 'get started'], typicalPrice: 23.99, hasInflowOffer: true, typicalDiscountPct: 0.6, typicalTermMonths: 6, confidence: 0.7 },
  { id: 'nytimes', name: 'The New York Times', domains: ['nytimes.com'], accountUrl: 'https://myaccount.nytimes.com/seg/subscription', sessionCookieNames: ['NYT-S'],
    loginUrlPatterns: ['/auth/login', '/auth/enter-email', 'myaccount.nytimes.com/auth'], signedInHints: ['your subscription', 'manage subscription', 'billing', 'next billing', 'subscription details'],
    noPlanHints: ['subscribe for', 'choose your plan'], typicalPrice: 25, hasInflowOffer: true, typicalDiscountPct: 0.8, typicalTermMonths: 12, confidence: 0.7 },
  { id: 'hulu', name: 'Hulu', domains: ['hulu.com'], accountUrl: 'https://secure.hulu.com/account', sessionCookieNames: ['_hulu_session', '_hulu_uid'],
    loginUrlPatterns: ['/login', 'auth.hulu.com'], signedInHints: ['your subscription', 'manage plan', 'billing information', 'next billing', 'your plan'],
    noPlanHints: ['start your free trial', 'choose your plan'], typicalPrice: 17.99, hasInflowOffer: true, typicalDiscountPct: 0.45, typicalTermMonths: 3, confidence: 0.6 },
  { id: 'spotify', name: 'Spotify', domains: ['spotify.com'], accountUrl: 'https://www.spotify.com/account/overview/', sessionCookieNames: ['sp_dc'],
    loginUrlPatterns: ['accounts.spotify.com/login', '/login'], signedInHints: ['your plan', 'premium', 'manage your plan', 'next payment', 'subscription'],
    noPlanHints: ['get premium', 'try premium'], typicalPrice: 11.99, hasInflowOffer: false, typicalDiscountPct: 0, typicalTermMonths: 0, confidence: 0.5 },
  { id: 'adobe', name: 'Adobe Creative Cloud', domains: ['adobe.com'], accountUrl: 'https://account.adobe.com/plans',
    loginUrlPatterns: ['auth.services.adobe.com', '/signin', 'adobelogin'], signedInHints: ['your plans', 'manage plan', 'creative cloud', 'billing', 'plan details'],
    noPlanHints: ['buy now', 'start free trial'], typicalPrice: 59.99, hasInflowOffer: true, typicalDiscountPct: 0.33, typicalTermMonths: 6, confidence: 0.5 },
  { id: 'audible', name: 'Audible', domains: ['audible.com'], accountUrl: 'https://www.audible.com/account/overview', sessionCookieNames: ['session-id', 'at-main', 'x-main'],
    loginUrlPatterns: ['/signin', '/ap/signin'], signedInHints: ['your membership', 'membership', 'next billing', 'credits', 'account details'],
    noPlanHints: ['start your free trial', 'try audible'], typicalPrice: 14.95, hasInflowOffer: true, typicalDiscountPct: 0.5, typicalTermMonths: 3, confidence: 0.7 },
  { id: 'youtube', name: 'YouTube Premium', domains: ['youtube.com'], accountUrl: 'https://www.youtube.com/paid_memberships', sessionCookieNames: ['SID', 'SAPISID', '__Secure-3PSID'],
    loginUrlPatterns: ['accounts.google.com'], signedInHints: ['manage membership', 'membership', 'next billing', 'premium'],
    noPlanHints: ['get youtube premium', 'try it free', 'start free trial'], typicalPrice: 13.99, hasInflowOffer: true, typicalDiscountPct: 0.5, typicalTermMonths: 3, confidence: 0.5 },
  { id: 'paramount', name: 'Paramount+', domains: ['paramountplus.com'], accountUrl: 'https://www.paramountplus.com/account/',
    loginUrlPatterns: ['/account/signin', '/signin'], signedInHints: ['your plan', 'manage plan', 'billing', 'subscription', 'next billing'],
    noPlanHints: ['try it free', 'start free trial'], typicalPrice: 12.99, hasInflowOffer: true, typicalDiscountPct: 0.5, typicalTermMonths: 3, confidence: 0.5 },
  { id: 'peacock', name: 'Peacock', domains: ['peacocktv.com'], accountUrl: 'https://www.peacocktv.com/account',
    loginUrlPatterns: ['/signin', '/login'], signedInHints: ['your plan', 'manage plan', 'billing', 'subscription', 'next payment'],
    noPlanHints: ['get started', 'choose your plan'], typicalPrice: 10.99, hasInflowOffer: true, typicalDiscountPct: 0.5, typicalTermMonths: 3, confidence: 0.5 },
  { id: 'linkedin', name: 'LinkedIn Premium', domains: ['linkedin.com'], accountUrl: 'https://www.linkedin.com/premium/manage/', sessionCookieNames: ['li_at'],
    loginUrlPatterns: ['/login', '/checkpoint', '/uas/login'], signedInHints: ['manage premium', 'premium', 'billing', 'your subscription', 'next billing'],
    noPlanHints: ['try premium', 'start your free', 'try for free'], typicalPrice: 39.99, hasInflowOffer: true, typicalDiscountPct: 0.5, typicalTermMonths: 2, confidence: 0.5 },
  { id: 'nordvpn', name: 'NordVPN', domains: ['nordaccount.com', 'nordvpn.com'], accountUrl: 'https://my.nordaccount.com/dashboard/nordvpn/',
    loginUrlPatterns: ['/login'], signedInHints: ['subscription', 'manage subscription', 'your plan', 'expires', 'auto-renew'],
    noPlanHints: ['get nordvpn', 'choose a plan'], typicalPrice: 12.99, hasInflowOffer: true, typicalDiscountPct: 0.5, typicalTermMonths: 12, confidence: 0.4 },
  { id: 'headspace', name: 'Headspace', domains: ['headspace.com'], accountUrl: 'https://www.headspace.com/subscription/manage',
    loginUrlPatterns: ['/login'], signedInHints: ['subscription', 'manage subscription', 'billing', 'renews', 'your plan'],
    noPlanHints: ['start your free trial', 'subscribe'], typicalPrice: 12.99, hasInflowOffer: true, typicalDiscountPct: 0.5, typicalTermMonths: 3, confidence: 0.4 },
  { id: 'max', name: 'Max', domains: ['max.com'], accountUrl: 'https://www.max.com/account',
    loginUrlPatterns: ['/login', 'auth.max.com'], signedInHints: ['subscription', 'billing', 'your plan', 'manage subscription', 'next payment'],
    noPlanHints: ['sign up now', 'choose your plan'], typicalPrice: 16.99, hasInflowOffer: true, typicalDiscountPct: 0.5, typicalTermMonths: 3, confidence: 0.4 },
  { id: 'wsj', name: 'The Wall Street Journal', domains: ['wsj.com', 'dowjones.com'], accountUrl: 'https://customercenter.wsj.com/',
    loginUrlPatterns: ['sso.accounts.dowjones.com', '/login'], signedInHints: ['subscription', 'billing', 'your account', 'manage subscription'],
    noPlanHints: ['subscribe now'], typicalPrice: 38.99, hasInflowOffer: true, typicalDiscountPct: 0.7, typicalTermMonths: 12, confidence: 0.5 },
  { id: 'wapo', name: 'The Washington Post', domains: ['washingtonpost.com'], accountUrl: 'https://subscribe.washingtonpost.com/account/',
    loginUrlPatterns: ['/subscribe/signin', '/signin'], signedInHints: ['subscription', 'billing', 'manage', 'your subscription', 'renews'],
    noPlanHints: ['subscribe now', 'choose your plan'], typicalPrice: 12, hasInflowOffer: true, typicalDiscountPct: 0.75, typicalTermMonths: 12, confidence: 0.5 },
  // Known NOT to make in-flow offers — detected, shown as "kept", never attempted.
  { id: 'netflix', name: 'Netflix', domains: ['netflix.com'], accountUrl: 'https://www.netflix.com/account', sessionCookieNames: ['NetflixId', 'SecureNetflixId'],
    loginUrlPatterns: ['/login'], signedInHints: ['membership & billing', 'membership', 'plan details', 'next billing', 'manage membership'],
    noPlanHints: ['restart your membership', 'join netflix', 'finish sign-up'], typicalPrice: 15.49, hasInflowOffer: false, typicalDiscountPct: 0, typicalTermMonths: 0, confidence: 0.9 },
  { id: 'disneyplus', name: 'Disney+', domains: ['disneyplus.com'], accountUrl: 'https://www.disneyplus.com/account',
    loginUrlPatterns: ['/login', '/identity'], signedInHints: ['subscription', 'billing', 'your plan', 'manage'],
    noPlanHints: ['sign up now', 'choose your plan'], typicalPrice: 9.99, hasInflowOffer: false, typicalDiscountPct: 0, typicalTermMonths: 0, confidence: 0.8 },
  { id: 'prime', name: 'Amazon Prime', domains: ['amazon.com'], accountUrl: 'https://www.amazon.com/gp/primecentral', sessionCookieNames: ['session-id', 'at-main', 'x-main'],
    loginUrlPatterns: ['/ap/signin'], signedInHints: ['prime membership', 'manage membership', 'your membership', 'renews', 'membership benefits'],
    noPlanHints: ['try prime', 'start your 30-day', 'join prime'], typicalPrice: 14.99, hasInflowOffer: false, typicalDiscountPct: 0, typicalTermMonths: 0, confidence: 0.9 },
];

/** Host-permission patterns for every playbook domain — requested on first Scan. */
export const ORIGINS: string[] = Array.from(new Set(PLAYBOOKS.flatMap((p) => p.domains.map((d) => `https://*.${d}/*`))));

export function playbookById(id: string): Playbook | undefined {
  return PLAYBOOKS.find((p) => p.id === id);
}

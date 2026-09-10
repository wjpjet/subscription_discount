// Registrable-domain helper (eTLD+1) + infra denylist. Plain ESM, used by the extension and the backend.
const MULTI = new Set(['co.uk','org.uk','ac.uk','gov.uk','me.uk','com.au','net.au','org.au','co.nz','co.jp','ne.jp','or.jp','com.br','com.mx','com.ar','co.in','co.za','com.sg','com.hk','co.kr','com.tr','com.tw','co.il','com.my','com.ph','co.th']);
export function etld1(host) {
  host = String(host || '').toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  const p = host.split('.');
  if (p.length <= 2) return host;
  const last2 = p.slice(-2).join('.');
  return MULTI.has(last2) ? p.slice(-3).join('.') : last2;
}
const INFRA = /(^|\.)(google-analytics|googletagmanager|doubleclick|googlesyndication|googleadservices|adnxs|adsrvr|criteo|taboola|outbrain|scorecardresearch|quantserve|demdex|omtrdc|cloudflare|cloudfront|akamaihd|akamai|fastly|hubspot|intercom|zendesk|segment|mixpanel|amplitude|hotjar|optimizely|newrelic|sentry|stripe|paypal|braintreegateway|recaptcha|gstatic|googleapis|fbcdn|bing|duckduckgo|localhost|netlify|vercel|github|gitlab|bitbucket|npmjs|jsdelivr|unpkg)\.(com|net|io|org|app)$/i;
export function isInfra(domain) { return INFRA.test(domain) || domain === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(domain); }
export const AUTH_COOKIE_RE = /(sess|auth|token|sid$|^sid|login|logged|user|acct|account|jwt|refresh|remember|identity|_at$|^at-|secure)/i;

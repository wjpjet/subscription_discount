// Registrable-domain helper (eTLD+1) + infra denylist. Plain ESM, used by the extension and the backend.
const MULTI = new Set(['co.uk','org.uk','ac.uk','gov.uk','me.uk','com.au','net.au','org.au','co.nz','co.jp','ne.jp','or.jp','com.br','com.mx','com.ar','co.in','co.za','com.sg','com.hk','co.kr','com.tr','com.tw','co.il','com.my','com.ph','co.th']);
// Most ccTLDs sell names under a generic second level (foo.com.co, foo.gob.mx, foo.co.id). Without this,
// every *.com.co cookie collapsed into one pseudo-site "com.co" (first live run).
const SECOND_LEVEL = /^(com|co|net|org|gov|edu|ac|or|ne|go|gob|mil|nic|ltd|plc|sch|info|biz)\.[a-z]{2}$/;
// Shared hosting: every customer gets a subdomain, so each x.netlify.app is its own site. Without this, two
// allowlisted apps merged as "duplicates" and a walk's site set (and the server's) opened every *.netlify.app.
const HOSTING = new Set(['netlify.app', 'vercel.app', 'pages.dev', 'github.io', 'herokuapp.com', 'web.app', 'firebaseapp.com', 'workers.dev', 'onrender.com', 'fly.dev', 'glitch.me']);
export function etld1(host) {
  host = String(host || '').toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return host; // an IP is its own site ("1.1" is not)
  const p = host.split('.');
  if (p.length <= 2) return host;
  const last2 = p.slice(-2).join('.');
  return MULTI.has(last2) || SECOND_LEVEL.test(last2) || HOSTING.has(last2) ? p.slice(-3).join('.') : last2;
}
/** True when host is one of domains or a subdomain of one (dot boundary: "notnetflix.com" is not netflix.com). */
export function hostMatches(host, domains) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return !!h && (domains || []).some((d) => { d = String(d || '').toLowerCase().replace(/^\.+|\.+$/g, ''); return !!d && (h === d || h.endsWith('.' + d)); });
}
const INFRA = /(^|\.)(google-analytics|googletagmanager|doubleclick|googlesyndication|googleadservices|adnxs|adsrvr|criteo|taboola|outbrain|scorecardresearch|quantserve|demdex|omtrdc|cloudflare|cloudfront|akamaihd|akamai|fastly|hubspot|intercom|zendesk|segment|mixpanel|amplitude|hotjar|optimizely|newrelic|sentry|stripe|paypal|braintreegateway|recaptcha|gstatic|googleapis|fbcdn|bing|duckduckgo|localhost|netlify|vercel|github|gitlab|bitbucket|npmjs|jsdelivr|unpkg)\.(com|net|io|org|app)$/i;
// Registrable domains nobody subscribes to, hand-picked from the first live run's not_subscription verdicts
// (about half of the 267 names sent were these). The regex above can't reach them: many sit on .ms, .live,
// .bid, .me, .mx, .xyz... Dropped quietly before discovery, so their names never reach the model.
const INFRA_DOMAINS = new Set([
  // ad exchanges, SSPs/DSPs, ad networks, cookie sync and identity graphs
  'tappx.com', 'richaudience.com', 'a-mo.net', 'startappnetwork.com', 'infolinks.com', 'smilewanted.com', 'company-target.com', 'mediaalpha.com',
  'iqzonertb.live', 'mookie1.com', 'exactag.com', 'mediarithmics.com', 'adgrx.com', 'rtbwise.com', 'a-mx.com', 'measureadv.com', 'syncingbridge.com',
  '360yield.com', 'cadent.com', 'nexx360.io', 'stackadapt.com', 'presage.io', 'amazon-adsystem.com', 'contextweb.com', 'krushmedia.com', 'appier.net',
  'playdigo.com', 'rtb.mx', 'admanmedia.com', 'adroll.com', 'adprime.com', 'pgammedia.com', 'adsinteractive.com', 'loopme.me', 'minutemedia-prebid.com',
  'yellowblue.io', 'openwebmp.com', 'rezync.com', 'pacvue.com', 'applovin.com', 'optidigital.com', 'cxense.com', 'ad-stir.com', 'servenobid.com',
  'anyrtb.com', 'conversionsapigateway.com', 'mediavine.com', 'journeymv.com', 'pubnation.com', 'admixer.net', 'seedtag.com', 'semasio.net', 'kargo.com',
  'ml314.com', 'unrulymedia.com', 'connatix.com', 'extremereach.io', 'voltaxam.com', 'clinch.co', 'optable.co', 'cpmstar.com', 'feedad.com', 'eyeota.net',
  'pub.network', 'adtonos.com', '1rx.io', 'missena.io', 'id5-sync.com', 'pubmatic.com', 'rkdms.com', 'sharethrough.com', 'dotomi.com', 'bidr.io',
  'deepintent.com', 'mediawallahscript.com', 'bedrockplatform.bid', 'securedvisit.com', 'marphezis.com', 'usbrowserspeed.com', 'connectad.io', 'pmbmonetize.live',
  'rubiconproject.com', 'openx.net', 'casalemedia.com', 'indexww.com', 'bidswitch.net', 'rlcdn.com', 'agkn.com', 'bluekai.com', 'krxd.net',
  'everesttech.net', 'adform.net', 'smartadserver.com', 'teads.tv', 'yieldmo.com', 'lijit.com', 'sonobi.com', '3lift.com', 'triplelift.com',
  'mathtag.com', 'tapad.com', 'crwdcntrl.net', 'liadm.com', 'moatads.com', 'doubleverify.com', 'adsafeprotected.com', 'serving-sys.com', 'flashtalking.com',
  // analytics, tag managers, affiliate tracking
  'clarity.ms', 'tealiumiq.com', 'sjv.io', 'pxf.io', 'ojrq.net',
  // CDNs and content hosts
  'googleusercontent.com', 'stripecdn.com', 'streamtheworld.com', 'ytimg.com', 'ggpht.com', 'twimg.com', 'licdn.com', 'akamaized.net', 'facebook.net',
  // sign-in plumbing and workplace IT: never a personal subscription. Deliberately NOT on the never-touch list
  // (shared/sensitive.js): sign-in redirects pass through them (Microsoft 365 lands on login.microsoftonline.com).
  'microsoftonline.com', 'microsoftazuread-sso.com', 'okta.com', 'oktapreview.com', 'okta-emea.com', 'onelogin.com', 'duosecurity.com', 'auth0.com',
  'amazoncognito.com', 'b2clogin.com', 'service-now.com',
]);
export function isInfra(domain) {
  const d = String(domain || '').toLowerCase();
  // An app on shared hosting (someone's x.pages.dev) is a deploy, not a personal subscription, and its name can be
  // personal: dropped before discovery like the netlify/vercel/github hosts above, now that each is its own site.
  return INFRA.test(d) || INFRA_DOMAINS.has(etld1(d)) || HOSTING.has(d.split('.').slice(-2).join('.')) || d === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(d) || d.includes(':');
}
// Cookie names that suggest a session. Not bare "secure" (every __Secure- cookie, trackers included) or "user"
// (user_prefs, ajs_user_traits); Google's SID family (SID, APISID, __Secure-3PSID, __Secure-3PSIDTS) still counts.
export const AUTH_COOKIE_RE = /(sess|auth|token|sid(ts|cc)?$|^sid|login|logged|user_?id|userid|^uid$|acct|account|jwt|refresh|remember|identity|_at$|^at-)/i;

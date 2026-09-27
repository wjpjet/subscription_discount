// Whose account is this page showing, and is it a sign-in page at all? Consumer mail domains, work/team account
// signals, identity-provider hosts and sign-in URLs. Plain ESM, used by the extension and the backend.
//
// The first live run walked toward an employer's enterprise Cursor seat and a Google Workspace account, and showed
// a household member's Hulu as the owner's. None of these can take a consumer retention offer, and walking a
// team account risks the employer's billing, so they are recognised here by rules, not only by the model.
import { etld1 } from './domains.js';

/** Webmail and ISP mail domains: an address here belongs to a person, not an employer. */
export const CONSUMER_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'passport.com', 'icloud.com', 'me.com', 'mac.com',
  'yahoo.com', 'ymail.com', 'rocketmail.com', 'aol.com', 'aim.com', 'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me',
  'gmx.com', 'gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch', 'web.de', 't-online.de', 'freenet.de', 'posteo.de', 'mailbox.org',
  'fastmail.com', 'fastmail.fm', 'hey.com', 'zoho.com', 'zohomail.com', 'yandex.com', 'yandex.ru', 'ya.ru', 'mail.ru', 'inbox.ru', 'list.ru', 'bk.ru',
  'mail.com', 'email.com', 'usa.com', 'duck.com', 'tutanota.com', 'tutanota.de', 'tuta.io', 'tuta.com', 'hushmail.com', 'skiff.com',
  'qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net', 'sina.com', 'sohu.com', 'naver.com', 'daum.net', 'hanmail.net', 'kakao.com',
  'rediffmail.com', 'orange.fr', 'wanadoo.fr', 'free.fr', 'laposte.net', 'sfr.fr', 'libero.it', 'virgilio.it', 'tiscali.it', 'alice.it',
  'seznam.cz', 'wp.pl', 'o2.pl', 'interia.pl', 'onet.pl', 'uol.com.br', 'bol.com.br', 'terra.com.br', 'ig.com.br',
  'comcast.net', 'xfinity.com', 'verizon.net', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'pacbell.net', 'cox.net', 'charter.net', 'spectrum.net',
  'earthlink.net', 'optonline.net', 'frontier.com', 'windstream.net', 'centurylink.net', 'rogers.com', 'shaw.ca', 'sympatico.ca', 'telus.net',
  'btinternet.com', 'sky.com', 'virginmedia.com', 'talktalk.net', 'ntlworld.com', 'bigpond.com', 'optusnet.com.au', 'xtra.co.nz',
]);
// Global brands with a mailbox under many country domains (hotmail.co.uk, yahoo.fr, outlook.de, gmx.es, yandex.kz...).
const CONSUMER_MAIL_BRANDS = /^(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|aol|gmx|yandex|libero|protonmail)$/;
const EMAIL_RE = /^[^\s@<>()",;:]+@([a-z0-9-]+\.)+[a-z]{2,}$/i;

/** The lower-cased domain of an email address, or '' when it isn't one. */
export function emailDomain(email) {
  const e = String(email || '').trim().toLowerCase();
  return EMAIL_RE.test(e) ? e.slice(e.lastIndexOf('@') + 1) : '';
}
/** An address at a webmail or ISP mail provider (someone's own mailbox). */
export function isConsumerEmail(email) {
  const d = emailDomain(email); if (!d) return false;
  if (CONSUMER_MAIL_DOMAINS.has(d)) return true;
  // Only the brand's own registrable domain: outlook.company.com is a company host, not Outlook.
  return etld1(d) === d && CONSUMER_MAIL_BRANDS.test(d.split('.')[0]);
}
/** A valid address whose domain is not a consumer mail provider. Only ever a weak signal: plenty of people use
 *  a personal custom domain, so this alone never makes an account a work account. */
export const isWorkEmail = (email) => !!emailDomain(email) && !isConsumerEmail(email);

// Page cues that an account belongs to an organisation. STRONG ones name org administration outright; WEAK ones
// also appear on consumer pages (an "Enterprise" nav link, SSO on a sign-in page, seat counts in a plan table).
const STRONG = [
  ['team settings', /\bteam settings\b/i],
  ['members & groups', /\bmembers\s*(&|and)\s*groups\b/i],
  ['invite teammates', /\binvite (your )?(teammates|team ?members|members|your team|people to (your|the) (team|workspace|organi[sz]ation))\b/i],
  ['managed by your organization', /\b(managed|administered|controlled) by (your |an |the )?(organi[sz]ation|company|employer|admin(istrator)?|it (department|admin))/i],
  ['workspace admin', /\bworkspace (admins?|administrators?|billing|settings)\b/i],
  ['google workspace', /\bgoogle workspace\b/i],
  ['admin console', /\badmin (console|center|centre)\b/i],
  ["your organization's plan", /\byour (organi[sz]ation|company|employer)('s|’s)? (plan|subscription|account)\b/i],
  ['enterprise admin', /\benterprise (admins?|administrators?)\b/i],
  // Google One on a Workspace login: "Sign in with your personal account" / "switch to your personal account".
  ['personal-account prompt', /\b(switch to|sign in with|use) (your |a )?personal (google )?account\b/i],
];
const WEAK = [
  ['enterprise', /\benterprise\b/i],
  ['seats', /\b(per seat|seats?)\b/i],
  ['SAML', /\bsaml\b/i],
  ['SSO', /\bSSO\b|\bsingle sign-?on\b/i],
];
function snapTexts(snapshot) {
  const s = snapshot || {};
  const els = (s.elements || []).flatMap((e) => [e && e.text, e && e.label]);
  return [s.title, ...(s.headings || []), ...els, s.text].filter((t) => typeof t === 'string' && t);
}
/**
 * Why this signed-in page looks like a work, team or organisation account, or null. Reads the title, headings,
 * element texts/labels and visible text. Needs two distinct signals, at least one STRONG: Cursor's team dashboard
 * (Team Settings + Members & Groups + Invite Teammates) is caught; a Netflix account page, or a page whose only cue
 * is an "Enterprise" link, is not. `email`: the account's address (a work email is a WEAK signal); when omitted,
 * the first identity email in the snapshot is used; pass null for none.
 */
export function orgAccountReason(snapshot, email) {
  const texts = snapTexts(snapshot);
  const hits = (list) => list.filter(([, re]) => texts.some((t) => re.test(t))).map(([name]) => name);
  const strong = hits(STRONG);
  if (!strong.length) return null;
  const weak = hits(WEAK);
  const addr = email === undefined ? ((snapshot && snapshot.identity && snapshot.identity.emails) || [])[0]?.value : email;
  if (addr && isWorkEmail(addr)) weak.push('work email');
  const all = [...strong, ...weak];
  return all.length >= 2 ? `work or team account: ${all.slice(0, 4).join(', ')}` : null;
}

/** Sign-in hosts shared by many services (and the auth./login./sso./signin./accounts./id. subdomains most sites
 *  use): landing here says nothing about which account or plan the person has. */
export const IDP_HOST_RE = /^(login\.microsoftonline\.com|login\.live\.com|accounts\.google\.com|appleid\.apple\.com|idmsa\.apple\.com|account\.apple\.com|accounts\.shopify\.com)$|^(auth|login|sso|signin|accounts|id)\.|(^|\.)(microsoftonline\.com|okta\.com|oktapreview\.com|okta-emea\.com|onelogin\.com|auth0\.com|duosecurity\.com|b2clogin\.com|amazoncognito\.com)$/i;
function hostPart(hostOrUrl) {
  const s = String(hostOrUrl || '').trim().toLowerCase();
  if (!s.includes('/')) return s.replace(/:\d+$/, '').replace(/\.$/, '');
  try { return new URL(s.includes('://') ? s : `https://${s}`).hostname; } catch { return ''; }
}
export const isIdpHost = (host) => { const h = hostPart(host); return !!h && IDP_HOST_RE.test(h); };

/** A path segment that means a sign-in, sign-up or auth step (/login, /ap/signin, /users/sign_in, /oauth2/...). */
export const LOGIN_PATH_RE = /(^|\/)(login|log[-_]in|signin|sign[-_]in|signup|sign[-_]up|auth|sso|authorize|oauth2?|identity\/signin)(\/|\.|\?|#|$)/i;
/** True when the URL's path (or #/route) is a sign-in / sign-up / auth step. The query is ignored: ?next=/login
 *  is not a login page. A string that isn't a URL is tested as a path. */
export function isLoginUrl(url) {
  const s = String(url || '');
  if (!s) return false;
  try { const u = new URL(s); return LOGIN_PATH_RE.test(u.pathname + u.hash); } catch { return LOGIN_PATH_RE.test(s); }
}

// "Sign in", "Log in", "Sign up free", "Create account", "Sign in or create account"; not "Sign out", not
// LinkedIn's "Sign in & security" settings link.
const SIGN_IN_RE = /^(sign ?in|log ?in|sign ?up|create (an |your |a )?(free )?account|join (now|free|for free))(\s+(now|here|free|for free|to .{1,30}|with .{1,20}|or .{1,30}))?[\s›»→.!]*$/i;
/** A visible control (snapshot elements are the visible ones) whose text or label is a sign-in / sign-up action. */
export function hasSignInControl(snapshot) {
  return ((snapshot && snapshot.elements) || []).some((e) => e && [e.text, e.label].some((t) => typeof t === 'string' && t.trim().length <= 60 && SIGN_IN_RE.test(t.trim())));
}

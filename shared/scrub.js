// Scrubbers for page data that leaves the browser (the model payload) or lands in a test log.
// Plain ESM with no dependencies and no Node APIs: the extension, the Worker backend and the node scripts import it.
// Two tiers:
//   scrubSecrets / scrubPii / scrubUrl / sanitizeSnapshot / sanitizeApiBody — for the model. They keep what the classifier needs:
//     emails (accountEmail), prices, dates, promo codes, plan names, ordinary links.
//   redactForLog — for the test log. The same, plus every email masked to `ja***@example.com`.

const TOKEN = '[token]';
const SKIP_DONE = '(?!\\[(?:redacted|token|digits|card|exp|address|zip|ssn)\\])';   // never re-redact our own markers
// A quote as it appears in page text: plain, JSON-escaped (\") or JS-escaped (\x22 or its \u form) — script-ish text uses all three.
const Q = '(?:\\\\x2[27]|\\\\u002[27]|\\\\*["\'])';

// --- secrets -----------------------------------------------------------------------------------------------------

const JWT_G = /eyJ[\w-]{8,}\.[\w-]{8,}(?:\.[\w-]*)?/g;
// Keys whose value is a credential. The key must END in one of these stems ("inside" or "considerations" never match
// "sid"); `auth…` skips author/authority but keeps authorization. No bare code/state: promo codes and plan state stay.
const KEY_STEMS = '(?:[\\w-]*(?:token|session[\\w-]*id|sessid|sid|csrf|xsrf|api[_-]?key|secret|challenge|scnt|postkey|nonce|signature|passw(?:or)?d|ceid)|[\\w-]*auth(?!or(?!i[sz]))[\\w-]*)';
// Value: quoted (any 8+ chars), or bare 8+ chars WITH a digit — bare tokens have digits, prose ("OAuth: Connected") doesn't.
const BARE = '[^\\s"\'\\\\,;&}\\]<>)]';
const KEYED_G = new RegExp('(' + Q + '?' + KEY_STEMS + Q + '?\\s*[:=]\\s*)(?:(' + Q + ')' + SKIP_DONE + '[^"\'\\\\\\n<>]{8,}|' + SKIP_DONE + '(?=' + BARE + '*\\d)' + BARE + '{8,})', 'gi');
const BEARER_RE = /\b(Bearer\s+)(?=[\w.~+/-]*\d)[\w.~+/-]{8,}=*/gi;              // Authorization: Bearer <token>
const HEX_RE = /[0-9a-f]{32,}/gi;
const BLOB_RE = /[A-Za-z0-9+/_=-]{40,}/g;
const DIGITS_G = /\d(?:[ -]?\d){11,}/g;                              // no \b and no upper bound: glued 23-digit ids too
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const ISO_DATES_RE = /^\d{4}-\d{2}-\d{2}(?:[ -]\d{4}-\d{2}-\d{2})*$/;   // "2026-09-27 2026-10-27" is two dates, not an id

// Non-global copies for other modules' detectors (a shared /g regex keeps lastIndex between .test() calls).
export const JWT_RE = new RegExp(JWT_G.source);
export const KEYED_SECRET_RE = new RegExp(KEYED_G.source, 'i');
export const LONG_DIGITS_RE = new RegExp(DIGITS_G.source);

/** Random-looking run: has letters and digits (or is all digits) and few separators (slugs, paths and snake_case have many). */
function tokenLike(v, min) {
  v = String(v).replace(/=+$/, '');
  if (v.length < min || /\s/.test(v)) return false;
  if (/^eyJ[\w-]{8,}\./.test(v)) return true;
  if ((v.match(/[A-Za-z0-9_-]/g) || []).length < v.length * 0.85) return false;   // a URL or a sentence, not a token
  if (!/\d/.test(v) || !(/[A-Za-z]/.test(v) || /^\d+$/.test(v))) return false;
  return (v.match(/[-_./+~]/g) || []).length <= v.length / 8;
}

/** Remove credentials and long numbers: JWTs, keyed secrets (token/csrf/session id/nonce…), hex and base64 blobs, 12+ digit runs, SSNs. */
export function scrubSecrets(text) {
  if (text == null) return '';
  return String(text)
    .replace(JWT_G, TOKEN)
    .replace(KEYED_G, function (m, key, q) { return key + (q || '') + '[redacted]'; })
    .replace(BEARER_RE, '$1' + TOKEN)
    .replace(HEX_RE, TOKEN)
    .replace(BLOB_RE, function (m) { return tokenLike(m, 40) ? TOKEN : m; })
    .replace(DIGITS_G, function (m) { return ISO_DATES_RE.test(m) ? m : '[digits]'; })
    .replace(SSN_RE, '[ssn]');
}

/** Which secret patterns a string still contains (names only, never the values) — for log review and tests. */
export function secretKinds(text) {
  const s = String(text == null ? '' : text), out = [];
  const has = (re) => { re.lastIndex = 0; const r = re.test(s); re.lastIndex = 0; return r; };
  if (has(JWT_G)) out.push('jwt');
  if (has(KEYED_G)) out.push('keyed');
  if (has(BEARER_RE)) out.push('bearer');
  if (has(HEX_RE)) out.push('hex');
  if ((s.match(BLOB_RE) || []).some((m) => tokenLike(m, 40))) out.push('blob');
  if ((s.match(DIGITS_G) || []).some((m) => !ISO_DATES_RE.test(m))) out.push('digits');
  if (has(SSN_RE)) out.push('ssn');
  return out;
}

// --- personal data (not emails) ------------------------------------------------------------------------------------

const CARD_WORD_RE = /(?:visa|master\s?card|amex|american express|discover|diners|jcb|unionpay|maestro|card|debit|credit|paypal|bank|checking|savings|payment method|\[card\])[\s\S]{0,30}$/i;   // page text is line-based: the card may sit on the line above
const YEAR_RE = /^(?:19|20)\d\d$/;
// "ending in 4242" / "ends with 4242": a year after "ending" ("trial ending 2026") needs a card word just before it.
const CARD_ENDING_RE = /\b(?:ending|ends)(?:\s+(?:in|with))?\s*:?\s*(\d{4})(?![\d]|[-/.]\d)/gi;
// "•••• 4242", "**** 4242", "XXXX-XXXX-XXXX-4242"; and after a card word, lighter masks: "Visa ...4242", "Visa x-4242",
// "card #4242", "Visa •4242". A lone "·" is a separator ("Card · 2026"), so it is not a mask here.
const CARD_MASK_RE = /(?:[•●∙·*]{2,}|\b[xX]{4,})[\s•●∙·*xX-]*\d{4}(?!\d)/g;
const CARD_BRAND_TAIL_RE = /\b(visa|master\s?card|amex|american express|discover|diners|jcb|unionpay|maestro|card)(\s*)(?:\.{2,}|…|[xX]-?|#|-|[•●∙*])\s?\d{4}(?!\d)/gi;
// Unmasked forms ("Visa 4242", "VISA: 4242", "Visa (4242)", "Visa · 4242") only after a real brand: never after "card" or
// "Discover" ("Discover 1000 titles"), and never on a 19xx/20xx year ("Visa 2026 rewards").
const BRAND = 'visa|master\\s?card|amex|american express|diners(?:\\s+club)?|jcb|unionpay|maestro';
const CARD_BARE_RE = new RegExp('\\b((?:' + BRAND + ')(?:\\s+(?:debit|credit|card|prepaid))?)(\\s*[:(·•●∙*]?\\s*)(?!(?:19|20)\\d\\d(?!\\d))\\d{4}(?!\\d|[.,]\\d)', 'gi');
const LAST4_RE = /\b(last\s*(?:4|four)(?:\s*digits)?\s*[:#]?\s*)\d{4}(?!\d)/gi;   // "last four: 4242", "last 4 digits 4242"
// Card expiry. "exp 04/27", "Exp. date: 04-2027" and "expires 04/2027" always; "expires 10/17", "valid thru 04/27" (also
// dates or offer deadlines) and "expires April 2027" only near a card. Never MM/DD/YYYY.
const EXP_ABBR_RE = /\b(exp\.?(?:\s*date)?\s*:?\s*)(?:0?[1-9]|1[0-2])\s*[/-]\s*(?:20)?\d{2}(?![\d/]|-\d)/gi;
const EXP_WORDS = 'expir(?:y|es|ed|ing|ation)|valid\\s+(?:thru|through|until)', EXP_LABEL = '(?:' + EXP_WORDS + ')(?:\\s+(?:date|on))?\\s*:?\\s*';
const EXP_LONG_RE = new RegExp('\\b(' + EXP_LABEL + ')((?:0?[1-9]|1[0-2])\\s*[/-]\\s*((?:20)?\\d{2}))(?![\\d/]|-\\d)', 'gi');
const EXP_AFTER_CARD_RE = /(\[card\][\s,·|()-]{0,6})(?:0?[1-9]|1[0-2])[/-](?:20)?\d{2}(?![\d/]|-\d)/g;
const SUFFIX = 'Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Court|Ct|Place|Pl|Terrace|Ter|Circle|Cir|Parkway|Pkwy|Highway|Hwy|Square|Sq|Trail|Trl|Alley|Plaza|Pike|Crescent';
// Also street suffixes, but ordinary words in titles and plan names ("Game Pass", "Jurassic Park", "Hacksaw Ridge"):
// they count only when a unit or a "City, ST 12345" tail follows.
const WEAK_SUFFIX = 'Loop|Cove|Run|Ridge|Row|Path|Pass|Point|Pt|Crossing|Xing|Walk|Hill|Heights|Park|Grove|Glen|Bend|Commons|Landing|Meadows?';
const STATE = 'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|PR|GU|VI';
const DIR = '(?:N|S|E|W|NE|NW|SE|SW|North|South|East|West|NORTH|SOUTH|EAST|WEST)\\.?';
// Title case and the USPS all-caps form ("4521 OAK RIDGE DR APT 4"), but not lowercase: "2 TB drive" is no address.
const caps = (alts) => alts + '|' + alts.toUpperCase();
const UNIT = '(?:,?\\s*(?:(?:' + caps('Apt|Apartment|Unit|Suite|Ste|Fl|Floor') + '|apt|apartment|unit|suite|ste|fl|floor)\\b|#)\\.?\\s*#?[\\w-]{1,6})';
const CITY = '(?:[A-Z][A-Za-z]+\\.?\\s+){0,2}[A-Z][A-Za-z]+,?\\s+(?:' + STATE + ')\\b', ZIP5 = '\\d{5}(?:-\\d{4})?';
const NOT_ADDR = '(?!(?:' + caps('TB|GB|MB|KB|Months?|Days?|Years?|Weeks?|Screens?|Seats?|Users?|Devices?|Profiles?') + ')\\b)';   // "2 TB Drive", "3 Month Pass"
// "123 Main Street", "350 5th Ave NW, Apt 4B, Springfield, IL 62704-1234", "123 MAIN ST": number, 1-4 capitalised or
// all-caps words, a street suffix, then an optional direction, unit and "City, ST 12345" tail (required after a weak suffix).
const ADDRESS_RE = new RegExp('\\b\\d{1,6}[A-Za-z]?\\s+' + NOT_ADDR + '(?:' + DIR + '\\s+)?(?:[A-Z0-9][\\w\'.-]*\\s+){0,3}[A-Z][\\w\'.-]*\\s+(?:'
  + '(?:' + caps(SUFFIX) + ')\\b\\.?(?:\\s+' + DIR + '(?![\\w]))?' + UNIT + '?(?:,?\\s+' + CITY + '(?:,?\\s+' + ZIP5 + ')?)?'
  + '|(?:' + caps(WEAK_SUFFIX) + ')\\b\\.?(?:\\s+' + DIR + '(?![\\w]))?(?:' + UNIT + '(?:,?\\s+' + CITY + '(?:,?\\s+' + ZIP5 + ')?)?|,?\\s+' + CITY + ',?\\s+' + ZIP5 + '))', 'g');
// Lowercase ("ship to 123 main street") only right after a shipping or address cue; the state then needs a ZIP after it
// ("in", "me", "or" are words too).
const CUE_ADDRESS_RE = new RegExp('(\\b(?:ship(?:s|ped|ping)?|deliver(?:s|ed|ing|y)?)\\s+to\\s*:?\\s*|\\baddress\\s*:?\\s*)\\d{1,6}[a-z]?\\s+(?:[\\w\'.-]+\\s+){0,4}?'
  + '(?:' + SUFFIX + '|' + WEAK_SUFFIX + ')\\b\\.?(?:\\s+' + DIR + '(?![\\w]))?' + UNIT + '?(?:,?\\s+(?:[a-z]+\\.?\\s+){0,2}[a-z]+,?\\s+(?:' + STATE + ')\\b,?\\s+' + ZIP5 + ')?', 'gi');
// ZIPs only where they read as ZIPs: after a state code or a ZIP label, or as ZIP+4. A bare 5-digit number is often a
// usage count or credit balance the classifier needs ("50000 credits"), so it stays.
const ZIP_STATE_RE = new RegExp('\\b(' + STATE + '),?(\\s+)\\d{5}(?:-\\d{4})?\\b', 'g');
const ZIP_LABEL_RE = /\b(zip(?:\s*code)?|postal\s*code|postcode)(\s*[:#]?\s*)\d{5}(?:-\d{4})?\b/gi;
const ZIP4_RE = /\b\d{5}-\d{4}\b/g;
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?';
const DATE = '(?:\\d{1,4}[-/.]\\d{1,2}[-/.]\\d{1,4}|' + MONTH + '\\s+\\d{1,2}(?:st|nd|rd|th)?,?(?:\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+' + MONTH + '(?:,?\\s+\\d{4})?)';
const BIRTH_PROSE_RE = new RegExp('\\b(date of birth|birth\\s?date|birthday|d\\.?o\\.?b\\.?|born(?:\\s+on)?)(\\s*[:\\-]?\\s*)' + DATE, 'gi');
const BIRTH_KEY = '(?:birth_?date|birth_?day|date_?of_?birth|dob)';
const BIRTH_JSON_RE = new RegExp('(' + Q + BIRTH_KEY + Q + '\\s*:\\s*)(?:' + Q + '[^"\'\\\\\\n]*' + Q + '|[^\\s,;}\\]]+)', 'gi');
const BIRTH_PARAM_RE = new RegExp('\\b(' + BIRTH_KEY + '=)[^\\s&"\'<>]+', 'gi');
const EXP_MONTH_RE = new RegExp('\\b((?:exp\\.?|' + EXP_WORDS + ')(?:\\s+(?:date|on))?\\s*:?\\s*)' + MONTH + ',?\\s+(?:19|20)\\d{2}(?!\\d)', 'gi');

const nearCard = (str, offset) => CARD_WORD_RE.test(str.slice(Math.max(0, offset - 40), offset));
function cardEnding(m, digits, offset, str) { return !YEAR_RE.test(digits) || nearCard(str, offset) ? '[card]' : m; }
function expLong(m, label, date, yy, offset, str) {
  return nearCard(str, offset) || (yy.length === 4 && !/^valid/i.test(label)) ? label + '[exp]' : m;
}
function expMonth(m, label, offset, str) { return nearCard(str, offset) ? label + '[exp]' : m; }   // "April 2027" is a plan date too

/** Remove card tails and expiry, US street addresses and ZIPs, birthdates. Emails are left alone (the classifier needs them). */
export function scrubPii(text) {
  if (text == null) return '';
  return String(text)
    .replace(BIRTH_PROSE_RE, '$1$2[redacted]')
    .replace(BIRTH_JSON_RE, '$1"[redacted]"')
    .replace(BIRTH_PARAM_RE, '$1[redacted]')
    .replace(ADDRESS_RE, '[address]')
    .replace(CUE_ADDRESS_RE, '$1[address]')
    .replace(ZIP_STATE_RE, '$1$2[zip]')
    .replace(ZIP_LABEL_RE, '$1$2[zip]')
    .replace(ZIP4_RE, '[zip]')
    .replace(CARD_ENDING_RE, cardEnding)
    .replace(CARD_MASK_RE, '[card]')
    .replace(CARD_BRAND_TAIL_RE, '$1$2[card]')
    .replace(CARD_BARE_RE, '$1$2[card]')
    .replace(LAST4_RE, '$1[card]')
    .replace(EXP_ABBR_RE, '$1[exp]')
    .replace(EXP_LONG_RE, expLong)
    .replace(EXP_MONTH_RE, expMonth)
    .replace(EXP_AFTER_CARD_RE, '$1[exp]');
}

// --- emails --------------------------------------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+(@|%40)((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;
function maskLocal(local) {
  if (local.indexOf('***') >= 0) return local;                        // already masked
  return local.slice(0, local.length >= 4 ? 2 : local.length >= 2 ? 1 : 0) + '***';
}
/** `jane@example.com` → `ja***@example.com`. A value that is not an address is still never echoed in full. */
export function maskEmail(email) {
  const s = String(email == null ? '' : email).trim();
  if (!s) return '';
  const at = s.lastIndexOf('@');
  if (at < 1) return maskLocal(s);
  return maskLocal(s.slice(0, at)) + '@' + s.slice(at + 1).toLowerCase();
}
/** Mask every email address in a string (also URL-encoded ones, `you%40example.com`). */
export function maskEmails(text) {
  if (text == null) return '';
  return String(text).replace(EMAIL_RE, function (m, sep, domain) { return maskLocal(m.slice(0, m.length - sep.length - domain.length)) + sep + domain; });
}

// --- URLs ----------------------------------------------------------------------------------------------------------

// Parameter names: strong stems anywhere in the name, weak ones only as a whole word of it (so keyword, author,
// encode and statement stay). `code` is kept for promo/coupon/country/error codes.
const PARAM_STRONG_RE = /token|session|secret|passw|passcode|csrf|xsrf|nonce|jwt|signature|ticket|scnt|credential|assertion|saml/i;
const PARAM_WEAK = { sid: 1, auth: 1, code: 1, state: 1, key: 1, apikey: 1, sig: 1, otp: 1, pass: 1, pwd: 1, tk: 1, hash: 1, hmac: 1, verifier: 1, secret: 1 };
const CODE_OK = { promo: 1, coupon: 1, discount: 1, offer: 1, voucher: 1, referral: 1, ref: 1, country: 1, currency: 1, lang: 1, language: 1, locale: 1, postal: 1, zip: 1, area: 1, region: 1, product: 1, plan: 1, sku: 1, color: 1, colour: 1, iso: 1, status: 1, error: 1, response: 1, http: 1 };
function secretParam(name) {
  if (PARAM_STRONG_RE.test(name)) return true;
  const parts = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (parts.some((p) => CODE_OK[p]) && parts.indexOf('code') >= 0) return false;
  return parts.some((p) => PARAM_WEAK[p]);
}
function dec(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

/** Scrub `a=1&b=2` (no leading ?/#). Returns null when nothing changed, so untouched URLs stay byte-for-byte. */
function scrubParams(q, depth) {
  let changed = false;
  const out = q.split('&').map(function (part) {
    const eq = part.indexOf('=');
    if (eq < 0) { if (tokenLike(dec(part), 24)) { changed = true; return 'x'; } return part; }
    const name = part.slice(0, eq), raw = part.slice(eq + 1), val = dec(raw);
    if (!raw || val === 'x') return part;                             // empty, or scrubbed already
    if (secretParam(dec(name)) || tokenLike(val, 24)) { changed = true; return name + '=x'; }
    if (depth < 2 && /^https?:\/\//i.test(val)) {                     // a return URL can carry its own tokens
      const inner = scrubAbsolute(val, depth + 1);
      if (inner !== val) { changed = true; return name + '=' + encodeURIComponent(inner); }
    }
    return part;
  });
  return changed ? out.join('&') : null;
}

function scrubAbsolute(s, depth) {
  let u;
  try { u = new URL(s); } catch (e) { return s; }
  if (!/^(https?|wss?):$/.test(u.protocol)) return s;                 // mailto:, javascript:, data: — nothing to scrub
  let changed = !!(u.username || u.password);                         // user:pass@host is dropped
  const path = u.pathname.split('/').map(function (seg) {
    if (seg === '%5Btoken%5D') return TOKEN;                          // ours, re-encoded by the URL parser
    if (seg && tokenLike(dec(seg), 32)) { changed = true; return TOKEN; }
    return seg;
  }).join('/');
  let search = u.search.slice(1);
  if (search) { const q = scrubParams(search, depth); if (q != null) { changed = true; search = q; } }
  let hash = u.hash.slice(1);
  if (hash) {
    const qi = hash.indexOf('?'), head = qi >= 0 ? hash.slice(0, qi + 1) : '', body = qi >= 0 ? hash.slice(qi + 1) : hash;
    if (body.indexOf('=') >= 0) { const q = scrubParams(body, depth); if (q != null) { changed = true; hash = head + q; } }
    else if (tokenLike(dec(body), 24)) { changed = true; hash = head + TOKEN; }
  }
  if (!changed) return s;
  return u.protocol + '//' + u.host + path + (search ? '?' + search : '') + (hash ? '#' + hash : '');
}

const BASE = 'https://relative.invalid';
/**
 * Keep origin, path and parameter names. Values of secret-named params (token, session, state, code, sig, nonce…) or
 * token-like values (24+ chars, mostly [A-Za-z0-9_-]) become `x`; JWT or 32+ char token path segments become [token].
 * Relative URLs are handled too. Returns the input unchanged when nothing needs scrubbing or it doesn't parse.
 */
export function scrubUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return scrubAbsolute(url, 0);
  let abs;
  try { abs = new URL(url, BASE).href; } catch (e) { return url; }
  const out = scrubAbsolute(abs, 0);
  if (out === abs) return url;
  if (url.slice(0, 2) === '//') return out.replace(/^https:/, '');
  const rel = out.slice(BASE.length);
  return url[0] === '/' ? rel : rel.replace(/^\//, '');
}

// --- snapshots and logs ----------------------------------------------------------------------------------------------

const SECRET_FIELD_RE = /(passw|card|cvc|cvv|expir|ssn|social|routing|iban|swift)/i;
function clean(v) { return typeof v === 'string' ? scrubPii(scrubSecrets(v)) : v; }

function sanitizeElement(e) {
  if (!e || typeof e !== 'object') return e;
  const o = Object.assign({}, e);
  for (const k of ['text', 'label', 'placeholder', 'value']) if (typeof o[k] === 'string') o[k] = clean(o[k]);
  if (typeof o.href === 'string') o.href = scrubUrl(o.href);
  if (Array.isArray(o.options)) o.options = o.options.map(clean);
  const field = [e.name, e.placeholder, e.label, /^(input|textarea)$/i.test(e.tag || '') ? e.text : ''].filter(Boolean).join(' ');
  if ('value' in o && (/^(password|hidden)$/i.test(e.type || '') || SECRET_FIELD_RE.test(field))) delete o.value;
  return o;
}

// A price context is cut from raw page text with a wide head (~120 chars). A cut through "Visa ending in 4242" leaves
// " in 4242", which no card rule matches, so scrub the whole context first and only then keep ~70 chars before the
// price, starting on a word: a phrase cut at the far edge falls outside what is kept.
const PRICE_HEAD = 70, PRICE_KEEP = 130;
/**
 * Where `amount` is written in `ctx` ("1,299.99", "17,99", "9.5", "$8"), or -1. The LAST match: when the amount shows
 * up twice, cutting relative to the later one keeps less head, never more.
 */
function priceAt(ctx, amount) {
  if (typeof amount !== 'number' || !isFinite(amount) || amount < 0 || amount >= 1e15) return -1;
  const int = String(Math.floor(amount)), cents = Math.round((amount - Math.floor(amount)) * 100);
  let ip = '';
  for (let i = 0; i < int.length; i++) ip += (i && (int.length - i) % 3 === 0 ? "[,.'\\s]?" : '') + int[i];
  const cp = !cents ? '(?:[.,]00?)?' : '[.,]' + (cents % 10 ? String(cents).padStart(2, '0') : cents / 10 + '0?');
  const re = new RegExp('(?<![\\d.,])' + ip + cp + '(?!\\d|[.,]\\d)', 'g');
  let m, at = -1;
  while ((m = re.exec(ctx))) at = m.index;
  return at;
}
function priceContext(ctx, amount) {
  const c = clean(ctx), at = priceAt(c, amount);
  // Price not found (reworded or scrubbed): keep a context-sized tail rather than the wide head.
  const end = at < 0 ? c.length - PRICE_KEEP + PRICE_HEAD : at;
  if (end <= PRICE_HEAD) return c;
  const from = end - PRICE_HEAD, ws = c.slice(from - 1, end).search(/\s\S/);   // start on a word, never mid-word
  return ws < 0 ? c.slice(end) : c.slice(from + ws);
}

/**
 * A scrubbed COPY of a page snapshot for sending off the device (the input is never mutated): url and hrefs through
 * scrubUrl; title, headings, text, element text/label/placeholder/value, options, price contexts and identity hints
 * through scrubSecrets + scrubPii (price contexts then trimmed to ~70 chars before the price); password, hidden and
 * card/bank field values dropped. Emails stay.
 */
export function sanitizeSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return snap;
  const out = Object.assign({}, snap);
  if (typeof snap.url === 'string') out.url = scrubUrl(snap.url);
  if (typeof snap.title === 'string') out.title = clean(snap.title);
  if (typeof snap.text === 'string') out.text = clean(snap.text);
  if (Array.isArray(snap.headings)) out.headings = snap.headings.map(clean);
  if (Array.isArray(snap.elements)) out.elements = snap.elements.map(sanitizeElement);
  if (Array.isArray(snap.prices)) out.prices = snap.prices.map((p) => (p && typeof p === 'object' ? Object.assign({}, p, typeof p.context === 'string' ? { context: priceContext(p.context, p.amount) } : {}) : p));
  if (Array.isArray(snap.frames)) out.frames = snap.frames.map((f) => (f && typeof f === 'object' ? Object.assign({}, f) : f));
  if (snap.identity && typeof snap.identity === 'object') {
    const id = snap.identity;
    out.identity = Object.assign({}, id, {
      emails: Array.isArray(id.emails) ? id.emails.map((e) => (e && typeof e === 'object' ? Object.assign({}, e) : e)) : id.emails,
      hints: Array.isArray(id.hints) ? id.hints.map((h) => (h && typeof h === 'object' ? Object.assign({}, h, { text: clean(h.text) }) : clean(h))) : id.hints,
    });
  }
  return out;
}

/**
 * A scrubbed COPY of an API request body (the input is never mutated), so callers can keep passing raw values:
 * `snapshot` through sanitizeSnapshot; `readiness` url through scrubUrl and dialog through scrubSecrets + scrubPii;
 * each `history` step's url through scrubUrl and target/note (raw element text, click notes) through scrubSecrets +
 * scrubPii; each `priorPath` line likewise. Anything else, and a non-object body, passes through as is.
 */
export function sanitizeApiBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const out = Object.assign({}, body);
  if (body.snapshot) out.snapshot = sanitizeSnapshot(body.snapshot);
  const r = body.readiness;
  if (r && typeof r === 'object') out.readiness = Object.assign({}, r, typeof r.url === 'string' ? { url: scrubUrl(r.url) } : {}, typeof r.dialog === 'string' ? { dialog: clean(r.dialog) } : {});
  if (Array.isArray(body.history)) out.history = body.history.map((h) => {
    if (!h || typeof h !== 'object') return h;
    const o = Object.assign({}, h);
    if (typeof o.url === 'string') o.url = scrubUrl(o.url);
    if (typeof o.target === 'string') o.target = clean(o.target);
    if (typeof o.note === 'string') o.note = clean(o.note);
    return o;
  });
  if (Array.isArray(body.priorPath)) out.priorPath = body.priorPath.map(clean);
  return out;
}

/** For the test log: secrets, long numbers, card data, addresses and birthdates removed, emails masked. */
export function redactForLog(text) {
  return maskEmails(scrubPii(scrubSecrets(text)));
}

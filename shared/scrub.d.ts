/** JWTs, keyed secrets (token/csrf/session id/nonce/scnt…), Bearer tokens, hex/base64 blobs, 12+ digit runs and SSNs removed. Prices, dates and emails kept. */
export function scrubSecrets(text: string | null | undefined): string;
/** Card tails and expiry, US street addresses (title case, all caps, or lowercase after a shipping cue), ZIPs (after a state or label, or ZIP+4) and birthdates removed. Emails kept. */
export function scrubPii(text: string | null | undefined): string;
/** `jane@example.com` → `ja***@example.com`; a non-address is masked too, never echoed in full. */
export function maskEmail(email: string | null | undefined): string;
/** maskEmail for every address in a string (also `%40`-encoded ones). */
export function maskEmails(text: string | null | undefined): string;
/** Secret-named or token-like query/fragment values → `x`, token path segments → `[token]`, userinfo dropped. Unchanged when clean or unparseable. */
export function scrubUrl(url: string): string;
export function scrubUrl<T extends string | null | undefined>(url: T): T;
/** A scrubbed copy of a page snapshot for sending off the device; the input is never mutated. Emails stay. */
export function sanitizeSnapshot<T>(snap: T): T;
/** A scrubbed copy of an API request body: snapshot, readiness (url, dialog), history (url, target, note) and priorPath. */
export function sanitizeApiBody<T>(body: T): T;
/** For the test log: maskEmails(scrubPii(scrubSecrets(text))). */
export function redactForLog(text: string | null | undefined): string;
/** Names of the secret patterns still present ('jwt' | 'keyed' | 'bearer' | 'hex' | 'blob' | 'digits' | 'ssn'), never the values. */
export function secretKinds(text: string | null | undefined): string[];
/** Non-global detectors (safe for .test()). */
export const JWT_RE: RegExp;
export const KEYED_SECRET_RE: RegExp;
export const LONG_DIGITS_RE: RegExp;

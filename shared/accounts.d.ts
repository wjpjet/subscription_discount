export const CONSUMER_MAIL_DOMAINS: Set<string>;
export function emailDomain(email: string | null | undefined): string;
export function isConsumerEmail(email: string | null | undefined): boolean;
export function isWorkEmail(email: string | null | undefined): boolean;
/** The part of a snapshot read here; a PageSnapshot from shared/page-scripts.js fits. */
export interface OrgSnapshotLike {
  title?: string; headings?: string[]; text?: string;
  elements?: { text?: string; label?: string }[];
  identity?: { emails?: { value: string; source?: string }[] };
}
/** Short reason ("work or team account: team settings, members & groups") or null. email undefined → the first identity email; null → none. */
export function orgAccountReason(snapshot: OrgSnapshotLike | null | undefined, email?: string | null): string | null;
export const IDP_HOST_RE: RegExp;
/** Accepts a host or a URL. */
export function isIdpHost(host: string | null | undefined): boolean;
export const LOGIN_PATH_RE: RegExp;
export function isLoginUrl(url: string | null | undefined): boolean;
export function hasSignInControl(snapshot: { elements?: { text?: string; label?: string }[] } | null | undefined): boolean;

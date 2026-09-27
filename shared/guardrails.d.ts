export const STATES: string[]; export const ACTIONS: string[]; export const OUTCOMES: string[];
export const FINALIZE_RE: RegExp; export const ACCEPT_RE: RegExp; export const SENSITIVE_FIELD_RE: RegExp;
export const COMMIT_VERB_RE: RegExp; export const PLAN_CHANGE_RE: RegExp;
export const CONFIRM_PAGE_RE: RegExp; export const CANCEL_VERB_RE: RegExp; export const OFFER_TEXT_RE: RegExp;
type Text = string | null | undefined;
/** What the guardrails read from a history step (HuntStep and the test driver's steps both fit). */
export interface GuardStep { state?: string; action?: { type?: string } | null; target?: string | null; ok?: boolean | null }
type History = ReadonlyArray<GuardStep | null | undefined> | null | undefined;
export function elementText(el: { text?: Text; label?: Text; value?: Text; placeholder?: Text } | null | undefined): string;
export function isFinalizeText(text: Text): boolean; export function isAcceptText(text: Text): boolean;
export function isPlanChangeText(text: Text): boolean; export function isCommitText(text: Text): boolean;
export function actsOnCancel(text: Text): boolean;
export function looksLikeConfirmPage(pageText: Text): boolean;
/** Why this button must not be clicked (finalize/decline, commit verb, cancel verb on a confirm or mid-flow offer page), or null. */
export function clickRefusal(elementText: Text, pageText: Text, history?: History): string | null;
export function isFinalizeClick(elementText: Text, pageText: Text, history?: History): boolean;
/** The accept-phase rule: not finalize/commit/plan-change/cancel, and accept-like or exactly the recorded label (never an empty one). */
export function acceptLooksRight(text: Text, recordedText: Text, pageText: Text, history?: History): boolean;
export function sameSite(url: Text, domains: string | ReadonlyArray<string | null | undefined> | null | undefined): boolean;
/** Backs out of a navigate or link click (element href) to a never-touch host, even on the site set; in goal 'find', a
 *  click on an accept-like button inside the cancel flow (or on an offer page) is handled as accept_offer (offer_found). */
export function applyGuardrails(ctx: { decision: any; snapshot: any; history: any[]; merchantDomain: string | ReadonlyArray<string>; step: number; maxSteps: number; goal?: string }): { decision: any; notes: string[] };

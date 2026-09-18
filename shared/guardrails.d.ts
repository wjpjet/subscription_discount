export const STATES: string[]; export const ACTIONS: string[]; export const OUTCOMES: string[];
export const FINALIZE_RE: RegExp; export const ACCEPT_RE: RegExp; export const SENSITIVE_FIELD_RE: RegExp;
export function isFinalizeText(text: string): boolean; export function isAcceptText(text: string): boolean;
export const CONFIRM_PAGE_RE: RegExp; export const CANCEL_VERB_RE: RegExp;
export function looksLikeConfirmPage(pageText: string | null | undefined): boolean;
export function isFinalizeClick(elementText: string | null | undefined, pageText: string | null | undefined): boolean;
export function applyGuardrails(ctx: { decision: any; snapshot: any; history: any[]; merchantDomain: string; step: number; maxSteps: number; goal?: string }): { decision: any; notes: string[] };

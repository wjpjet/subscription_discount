export type PageKind = 'account_billing' | 'account_other' | 'login' | 'reauth' | 'not_found' | 'error' | 'loading' | 'bot_challenge' | 'marketing' | 'other';
/** Same shape as PageClass in extension/src/types.ts (kept structurally identical). */
export interface MockPageClass {
  pageEvidence: string; pageKind: PageKind; signedIn: boolean; accountType: 'personal' | 'work_or_team' | 'unknown';
  billedVia: 'direct' | 'bundle_or_partner' | 'app_store' | 'carrier' | 'employer' | 'unknown';
  accountName: string | null; accountEmail: string | null; isPlanPage: boolean; hasPaidPlan: boolean | null; planName: string | null;
  currentPriceIndex: number | null; priceEvidence: string | null;
  monthlyPriceUsd: number | null; cycleChargeUsd: number | null; cadence: string; renewalDate: string | null; isTrial: boolean; trialEndsOn: string | null;
  priceAfterTrialUsd: number | null; offerApplied: boolean; offerText: string | null;
  detailsLinkId: number | null; confidence: number; notes: string;
}
export const PAGE_KINDS: PageKind[];
export const ACCOUNT_TYPES: MockPageClass['accountType'][];
export const BILLED_VIA: MockPageClass['billedVia'][];
/** Normalizes a price unit (legacy mo/yr/annually/wk included) to 'month' | 'year' | 'week' | 'quarter' | ''. */
export function normUnit(unit: string | null | undefined): string;
export function mockClassifyState(snapshot: any): string;
export function mockDecide(input: any): any;
/** Heuristic classification; `domain` is the service's domain (used for the same-site details-link check). */
export function mockClassify(snapshot: any, domain?: string): MockPageClass;
/** Server-side checks on any classification (model, mock, fallback); returns a new, complete object. */
export function guardPageClass(cls: any, snapshot: any, domain?: string): MockPageClass;
export function blankPageClass(notes?: string): MockPageClass;
export function mockDiscover(domains: string[]): any[];

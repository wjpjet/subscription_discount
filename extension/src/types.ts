export type PageKind = 'account_billing' | 'account_other' | 'login' | 'reauth' | 'not_found' | 'error' | 'loading' | 'bot_challenge' | 'marketing' | 'other';
export type AccountType = 'personal' | 'work_or_team' | 'unknown';
export type BilledVia = 'direct' | 'bundle_or_partner' | 'app_store' | 'carrier' | 'employer' | 'unknown';
/** What /api/classify (or mockClassify) reports about one page, in the order the model decides it. Mirrors the zod
 *  PageClass in netlify/functions/lib/brain.mjs and MockPageClass in shared/brain-mock.d.ts. Money/renewal/trial
 *  fields are already nulled by the server guard unless the page shows a confirmed paid plan. An older backend
 *  omits pageEvidence, pageKind, accountType, billedVia, accountName, isPlanPage, currentPriceIndex, priceEvidence
 *  and detailsLinkId, so readers should tolerate undefined there. */
export interface PageClass {
  pageEvidence: string; pageKind: PageKind; signedIn: boolean; accountType: AccountType; billedVia: BilledVia;
  accountName: string | null; accountEmail: string | null; isPlanPage: boolean; hasPaidPlan: boolean | null; planName: string | null;
  currentPriceIndex: number | null; priceEvidence: string | null;   // index into the numbered PRICES list; ≤ 80-char quote
  monthlyPriceUsd: number | null; cycleChargeUsd: number | null; cadence: string; renewalDate: string | null; isTrial: boolean; trialEndsOn: string | null; priceAfterTrialUsd: number | null; offerApplied: boolean; offerText: string | null;
  detailsLinkId: number | null;   // element id of a same-site <a> that likely shows the plan/price; null when this page does
  confidence: number; notes: string;
}
export interface Offer { description: string; newMonthlyPriceUsd: number | null; discountPct: number | null; termMonths: number | null; freeMonths: number | null;
  /** The price before the discount when the offer shows it ("$89.99 $44.99/month"). Missing from an older backend. */
  regularMonthlyPriceUsd?: number | null }
export interface FinishDetails { beforeMonthlyPriceUsd: number | null; afterMonthlyPriceUsd: number | null; termMonths: number | null; savingsUsd: number | null; summary: string }
export interface AgentAction { type: string; id?: number | null; text?: string | null; value?: string | null; url?: string | null; direction?: 'up' | 'down' | null; reason?: string | null; offer?: Offer | null; outcome?: string | null; details?: FinishDetails | null }
export interface Decision { state: string; reasoning: string; action: AgentAction }
export interface StepResponse { brain: string; model: string; proposed: AgentAction; decision: Decision; guardrails: string[] }
export type DiscoveryKind = 'adtech_tracking' | 'infrastructure' | 'employer_or_work' | 'retail_travel' | 'social_or_media_free' | 'financial_or_health' | 'unknown';
/** One row of /api/discover. For a non-subscription, category is its kind and name is the domain. The fields after
 *  `notes` are new: an older backend omits them, so treat a missing value as "keep" when filtering. */
export interface DiscoveredService { domain: string; isSubscription: boolean; name: string; category: string; accountUrl: string | null; typicalMonthlyPriceUsd: number | null; makesRetentionOffers: 'likely' | 'unlikely' | 'unknown'; typicalOfferDiscountPct: number | null; typicalOfferTermMonths: number | null; confidence: number; notes: string;
  canonicalService?: string | null;   // lower-case slug shared by every domain that reaches the same account and bill
  audience?: 'consumer' | 'business' | 'both' | null; billingModel?: 'subscription' | 'usage' | 'in_person_membership' | 'one_time' | 'free' | null;
  payLikelihood?: number | null;      // 0..1 prior that one individual with a session here pays personally (0 for non-subscriptions)
  regulatedFinancialOrHealth?: boolean; kind?: DiscoveryKind | null }
export interface Settlement { feeCents: number; estimatedFeeCents: number; adjusted: boolean; charged: boolean; waived?: boolean; paymentIntentId?: string; receiptUrl?: string | null; needsAction?: boolean; error?: string; status?: string }
export interface CheckoutResult { setupIntentId: string; customerId: string | null; paymentMethodId: string | null; email: string | null }

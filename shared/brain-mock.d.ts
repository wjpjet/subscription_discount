export function mockClassifyState(snapshot: any): string;
export function mockDecide(input: any): any;
export function mockClassify(snapshot: any): { signedIn: boolean; hasPaidPlan: boolean | null; planName: string | null; accountEmail: string | null; monthlyPriceUsd: number | null; cycleChargeUsd: number | null; cadence: string; renewalDate: string | null; isTrial: boolean; trialEndsOn: string | null; priceAfterTrialUsd: number | null; offerApplied: boolean; offerText: string | null; confidence: number; notes: string };
export function mockDiscover(domains: string[]): any[];

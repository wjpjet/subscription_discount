export interface Playbook { id: string; name: string; domains: string[]; accountUrl: string; sessionCookieNames?: string[]; loginUrlPatterns?: string[]; signedInHints: string[]; noPlanHints?: string[]; typicalPrice: number; hasInflowOffer: boolean; typicalDiscountPct: number; typicalTermMonths: number; confidence: number }
export const PLAYBOOKS: Playbook[];
export function playbookForDomain(domain: string): Playbook | undefined;

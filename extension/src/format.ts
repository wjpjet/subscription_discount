export function money(n: number | null | undefined): string { if (n == null || isNaN(n)) return '–'; return '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }); }
export function outcomeLabel(o: string): string { return ({ discount_applied: 'Discount applied', offer_found: 'Offer found', no_offer_backed_out: 'No offer — backed out', blocked_needs_you: 'Needs you (login)', ai_declined: 'AI declined this site', may_have_cancelled: 'May have been cancelled — check it', error: 'Could not complete' } as Record<string, string>)[o] || o; }
export const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
/** Host of a URL without "www.", or '' when there is none or it doesn't parse. */
export function hostLabel(url: string | null | undefined): string { try { return url ? new URL(url).hostname.replace(/^www\./, '') : ''; } catch { return ''; } }

/** One tag per scan status, in the owner's words. Statuses come from scan.ts (ItemStatus). */
const STATUS_LABEL: Record<string, string> = {
  login_wall: 'Signed out', no_paid_plan: 'Free plan', wrong_page: "Couldn't find the account page", not_loaded: "Page didn't load",
  needs_you: 'Needs you', work_account: 'Work account', billed_elsewhere: 'Billed elsewhere', unconfirmed: 'Plan not shown',
  error: "Couldn't check", sensitive: 'Skipped · sensitive', duplicate: 'Same account', checking: 'Checking…',
};
/** Why a row is listed without an offer. For a confirmed plan it says what the find pass did with it. */
export function keptLabel(i: { status: string; offerApplied?: boolean; findOutcome?: string | null }): string {
  if (i.status !== 'signed_in') return STATUS_LABEL[i.status] || 'Not checked';
  if (i.offerApplied) return 'Promo active · kept';
  if (i.findOutcome === 'may_have_cancelled') return 'May have been cancelled · check it';
  if (i.findOutcome === 'no_offer_backed_out') return 'No offer this time · left alone';
  if (i.findOutcome === 'blocked_needs_you') return 'Needs you to sign in';
  if (i.findOutcome === 'not_walked') return 'Not walked · read-only';
  if (i.findOutcome == null) return 'Not checked';
  return "Couldn't check · left alone";
}

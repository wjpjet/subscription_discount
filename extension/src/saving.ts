/**
 * The one line that explains a deal, in a person's words. Pure: no browser APIs, so it is unit-tested
 * under plain Node (scripts/test-saving.cjs).
 *
 *   "$17.99/mo → $9/mo for 3 months, from Oct 10"
 *   "Free until Oct 10, then $9/mo instead of $17.99 for 3 months"
 *   "2 months free from Oct 10, then $17.99/mo"
 *   "$120/yr → $96 at your next renewal, Mar 3 2027"
 * and, with no offer, what they pay today: "$17.99/mo · renews Oct 10" (just "renews Oct 17" when no price
 * was seen; never "–/mo").
 *
 * It also sorts a finished scan into the reveal screen's sections (groupReveal) and writes the count lines
 * around them, pure for the same reason.
 */
import { money, plural } from './format';
import type { Offer } from './types';

export interface SavingInput {
  hasOffer: boolean; offer: Offer | null; estSavings: number;
  monthlyPrice: number | null; cycleCharge: number | null; cadence: string; renewalDate: string | null;
  isTrial: boolean; trialEndsOn: string | null; priceAfterTrial: number | null;
}

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(String(s));
  return isNaN(d.getTime()) ? null : d;
}
export function fmtDate(d: Date | null, today = new Date()): string {
  if (!d) return '';
  const y = d.getFullYear() !== today.getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${MONTH[d.getMonth()]} ${d.getDate()}${y}`;
}
/** Round half up the way a price is printed: 8.995 → 9.00, not 8.99. */
const round2 = (x: number) => Math.round(x * 100 + 1e-9) / 100;
const per = (cadence: string) => (cadence === 'year' ? 'yr' : cadence === 'week' ? 'wk' : cadence === 'quarter' ? 'qtr' : 'mo');
const months = (n: number) => `${n} month${n === 1 ? '' : 's'}`;

/** What they pay today, for rows with no offer. '' when nothing about the bill was seen. */
export function payingLine(i: SavingInput, today = new Date()): string {
  const cad = per(i.cadence);
  const renewal = parseDate(i.renewalDate);
  if (i.isTrial) {
    const end = parseDate(i.trialEndsOn) || renewal;
    const after = i.priceAfterTrial ?? (i.monthlyPrice ? i.monthlyPrice : null);   // a trial's $0 today is not its price
    return `Free${end ? ` until ${fmtDate(end, today)}` : ' trial'}${after != null ? `, then ${money(after)}/${cad}` : ''}`;
  }
  const now = i.cycleCharge ?? i.monthlyPrice;
  return [now != null ? `${money(now)}/${cad}` : '', renewal ? `renews ${fmtDate(renewal, today)}` : ''].filter(Boolean).join(' · ');
}
/** Monthly equivalent of today's price (a yearly charge / 12), for sorting and the dev table; null when no price was seen. */
export function monthlyOf(i: { monthlyPrice: number | null; cycleCharge: number | null; cadence: string }): number | null {
  if (i.monthlyPrice != null) return i.monthlyPrice;
  const c = i.cycleCharge;
  if (c == null) return null;
  return i.cadence === 'year' ? round2(c / 12) : i.cadence === 'quarter' ? round2(c / 3) : i.cadence === 'week' ? round2((c * 52) / 12) : c;
}

/** The deal in one line: what they pay now → what they'll pay, for how long, from when. */
export function dealLine(i: SavingInput, today = new Date()): string {
  if (!i.hasOffer || !i.offer) return payingLine(i, today);
  const o = i.offer;
  const cad = per(i.cadence);
  const renewal = parseDate(i.renewalDate);
  const start = i.isTrial ? (parseDate(i.trialEndsOn) || renewal) : renewal;
  const from = start ? `from ${fmtDate(start, today)}` : 'from your next charge';
  let pct = o.discountPct ?? 0; if (pct > 1) pct /= 100;
  // What it costs without the offer. A trial shows $0 today and some pages show no price: the offer's own "was"
  // price stands in ("$89.99 $44.99/month"), else its new price undone by its percentage. Never "instead of $0".
  const known = (i.isTrial ? i.priceAfterTrial : null) ?? i.monthlyPrice;
  const regular = o.regularMonthlyPriceUsd ?? (o.newMonthlyPriceUsd != null && pct > 0 && pct < 1 ? round2(o.newMonthlyPriceUsd / (1 - pct)) : null);
  const base = known != null && known > 0 ? known : regular;
  const term = o.termMonths ?? 0;

  if (i.cadence === 'year') {
    const yearNow = i.cycleCharge ?? (base ?? 0) * 12;
    const next = o.newMonthlyPriceUsd != null ? round2(o.newMonthlyPriceUsd * 12) : pct ? round2(yearNow * (1 - pct)) : null;
    return `${money(yearNow)}/yr → ${next != null ? money(next) : o.description} at your next renewal${renewal ? `, ${fmtDate(renewal, today)}` : ''}`;
  }
  if (o.freeMonths && !o.newMonthlyPriceUsd) {
    return `${months(o.freeMonths)} free ${from}${base != null ? `, then ${money(base)}/${cad}` : ''}`;
  }
  const newPrice = o.newMonthlyPriceUsd != null ? o.newMonthlyPriceUsd : pct && base != null ? round2(base * (1 - pct)) : null;
  if (newPrice == null) return `${o.description || 'Offer'} ${from}`;
  const was = base != null && base > newPrice ? base : null;
  const forTerm = term ? ` for ${months(term)}` : '';
  if (i.isTrial) return `Free until ${start ? fmtDate(start, today) : 'the trial ends'}, then ${money(newPrice)}/${cad}${was != null ? ` instead of ${money(was)}` : ''}${forTerm}`;
  return was != null ? `${money(was)}/${cad} → ${money(newPrice)}/${cad}${forTerm}, ${from}` : `${money(newPrice)}/${cad}${forTerm}, ${from}`;
}

// ---- The reveal screen: which section each service lands in, and the lines around them ----

/** What grouping needs from a scan row. Structural, so this file stays free of browser code; ScanItem satisfies it. */
export interface RevealItem extends SavingInput {
  id: string; domain: string; name: string; status: string; planName: string | null; email: string | null;
  accountName?: string | null; dupOf?: string | null; aliases?: readonly string[];
}
/** scan.ts owns the status lists (PAYING, NEEDS_LOOK); they are passed in so there is one source of truth. */
export interface StatusSets { paying: readonly string[]; needsLook: readonly string[] }
export interface RevealGroups<T> { offers: T[]; trials: T[]; paying: T[]; needsLook: T[]; work: T[]; free: T[]; signedOut: T[]; sensitive: T[]; duplicates: T[] }
type GroupKey = keyof RevealGroups<unknown>;
const GROUP_OF: Record<string, GroupKey> = { work_account: 'work', no_paid_plan: 'free', login_wall: 'signedOut', sensitive: 'sensitive', duplicate: 'duplicates' };

/**
 * Sections in reveal order. Offers first (best first), then offers on free trials (their own section: accepting
 * one turns a trial the person might have cancelled into paid months), then the plans they pay for (dearest first,
 * unpriced last), then what needs a look. A status this build doesn't know (an older saved scan's 'unknown') asks
 * for a look rather than being hidden.
 */
export function groupReveal<T extends RevealItem>(items: readonly T[], s: StatusSets): RevealGroups<T> {
  const g: RevealGroups<T> = { offers: [], trials: [], paying: [], needsLook: [], work: [], free: [], signedOut: [], sensitive: [], duplicates: [] };
  for (const i of items) {
    if (i.status === 'duplicate') g.duplicates.push(i);
    else if (i.hasOffer) (i.isTrial ? g.trials : g.offers).push(i);
    else if (s.paying.includes(i.status)) g.paying.push(i);
    else if (s.needsLook.includes(i.status)) g.needsLook.push(i);
    else g[GROUP_OF[i.status] ?? 'needsLook'].push(i);
  }
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  // Needs a look follows the NEEDS_LOOK order: signed in with the plan not shown (likeliest to be paying) first.
  const lookRank = (i: T) => { const k = s.needsLook.indexOf(i.status); return k < 0 ? s.needsLook.length : k; };
  g.offers.sort((a, b) => b.estSavings - a.estSavings || byName(a, b));
  g.trials.sort((a, b) => b.estSavings - a.estSavings || byName(a, b));
  g.paying.sort((a, b) => (monthlyOf(b) ?? -1) - (monthlyOf(a) ?? -1) || byName(a, b));
  g.needsLook.sort((a, b) => lookRank(a) - lookRank(b) || byName(a, b));
  for (const k of ['work', 'free', 'signedOut', 'sensitive'] as const) g[k].sort(byName);
  return g;
}

/** A paying row's second line: plan · price · renewal · who, each only when known ("Premium plan · renews Oct 17"). */
export function paidSubLine(i: RevealItem, today = new Date()): string {
  return [i.planName, payingLine(i, today), i.email || i.accountName].filter(Boolean).join(' · ');
}

/** Sites folded into this row: the hidden duplicates (by name, or by domain when the name is the same), then aliases. */
export function alsoLabel(i: RevealItem, all: readonly RevealItem[]): string {
  const seen = new Set([i.domain.toLowerCase(), i.name.toLowerCase()]);
  const out: string[] = [];
  const add = (x: string) => { const k = x.toLowerCase(); if (x && !seen.has(k)) { seen.add(k); out.push(x); } };
  for (const d of all) {
    if (d === i || !d.dupOf || (d.dupOf !== i.id && d.dupOf !== i.domain)) continue;
    add(d.name.toLowerCase() === i.name.toLowerCase() ? d.domain : d.name);
    seen.add(d.domain.toLowerCase());
  }
  for (const a of i.aliases || []) add(a);
  return out.length ? `also: ${out.slice(0, 3).join(', ')}${out.length > 3 ? ` +${out.length - 3}` : ''}` : '';
}

/** The line under the total. Never "0 made an offer" when no cancellation flow was opened. */
export function countLine(found: number, offers: number, o: { readOnly: boolean; walked: boolean }): string {
  const head = `${plural(found, 'subscription')} found`;
  if (offers > 0) return `${head} · ${offers} made an offer · untick anything you'd rather leave alone`;
  if (o.readOnly) return `${head} · offers not checked (read-only test)`;
  return o.walked ? `${head} · none made an offer this time` : head;
}

/** One line for the rows the scanning screen doesn't list: "12 signed out · 3 free plans · 2 need a look · 1 work account". */
export function bucketLine(items: readonly RevealItem[], s: StatusSets): string {
  const g = groupReveal(items, s);
  const look = g.needsLook.length;
  return [
    g.signedOut.length && `${g.signedOut.length} signed out`,
    g.free.length && plural(g.free.length, 'free plan'),
    look && `${look} ${look === 1 ? 'needs' : 'need'} a look`,
    g.work.length && plural(g.work.length, 'work account'),
    g.sensitive.length && `${g.sensitive.length} skipped (sensitive)`,
    g.duplicates.length && plural(g.duplicates.length, 'duplicate'),
  ].filter(Boolean).join(' · ');
}

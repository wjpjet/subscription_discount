/**
 * The one line that explains a deal, in a person's words. Pure: no browser APIs, so it is unit-tested
 * under plain Node (scripts/test-saving.cjs).
 *
 *   "$17.99/mo → $9/mo for 3 months, from Oct 10"
 *   "Free until Oct 10, then $9/mo instead of $17.99 for 3 months"
 *   "2 months free from Oct 10, then $17.99/mo"
 *   "$120/yr → $96 at your next renewal, Mar 3 2027"
 * and, with no offer, what they pay today: "$17.99/mo, next charge Oct 10".
 */
import { money } from './format';
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
const per = (cadence: string) => (cadence === 'year' ? 'yr' : cadence === 'week' ? 'wk' : 'mo');
const months = (n: number) => `${n} month${n === 1 ? '' : 's'}`;

/** What they pay today, for rows with no offer. */
export function payingLine(i: SavingInput, today = new Date()): string {
  const cad = per(i.cadence);
  const renewal = parseDate(i.renewalDate);
  if (i.isTrial) {
    const end = parseDate(i.trialEndsOn) || renewal;
    const after = i.priceAfterTrial ?? i.monthlyPrice;
    return `Free${end ? ` until ${fmtDate(end, today)}` : ' trial'}${after != null ? `, then ${money(after)}/${cad}` : ''}`;
  }
  return `${money(i.cycleCharge ?? i.monthlyPrice)}/${cad}${renewal ? `, next charge ${fmtDate(renewal, today)}` : ''}`;
}

/** The deal in one line: what they pay now → what they'll pay, for how long, from when. */
export function dealLine(i: SavingInput, today = new Date()): string {
  if (!i.hasOffer || !i.offer) return payingLine(i, today);
  const o = i.offer;
  const cad = per(i.cadence);
  const renewal = parseDate(i.renewalDate);
  const start = i.isTrial ? (parseDate(i.trialEndsOn) || renewal) : renewal;
  const from = start ? `from ${fmtDate(start, today)}` : 'from your next charge';
  const base = i.isTrial && i.priceAfterTrial != null ? i.priceAfterTrial : (i.monthlyPrice ?? 0);
  let pct = o.discountPct ?? 0; if (pct > 1) pct /= 100;
  const term = o.termMonths ?? 0;

  if (i.cadence === 'year') {
    const yearNow = i.cycleCharge ?? base * 12;
    const next = o.newMonthlyPriceUsd != null ? round2(o.newMonthlyPriceUsd * 12) : pct ? round2(yearNow * (1 - pct)) : null;
    return `${money(yearNow)}/yr → ${next != null ? money(next) : o.description} at your next renewal${renewal ? `, ${fmtDate(renewal, today)}` : ''}`;
  }
  if (o.freeMonths && !o.newMonthlyPriceUsd) {
    return `${months(o.freeMonths)} free ${from}, then ${money(base)}/${cad}`;
  }
  const newPrice = o.newMonthlyPriceUsd != null ? o.newMonthlyPriceUsd : pct ? round2(base * (1 - pct)) : null;
  if (newPrice == null) return `${o.description || 'Offer'} ${from}`;
  if (i.isTrial) return `Free until ${start ? fmtDate(start, today) : 'the trial ends'}, then ${money(newPrice)}/${cad} instead of ${money(base)}${term ? ` for ${months(term)}` : ''}`;
  return `${money(base)}/${cad} → ${money(newPrice)}/${cad}${term ? ` for ${months(term)}` : ''}, ${from}`;
}

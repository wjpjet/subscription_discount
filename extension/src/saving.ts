/**
 * The two plain lines a person sees per subscription: what they pay today and when, then what the
 * offer changes and when. Pure: no browser APIs, so it can be unit-tested with plain Node.
 *
 *   now:   "Paying $17.99/mo · next charge Oct 10"            or  "Free trial until Oct 10, then $17.99/mo"
 *   offer: "50% off for 3 months → $9.00/mo Oct 10 – Jan 10, back to $17.99/mo after · saves $26.99"
 *          "2 months free → $0 Oct 10 – Dec 10, then $17.99/mo · saves $35.98"
 *          "20% off your next year → $96 on Mar 3 2027 · saves $24"
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
export function addMonths(d: Date, n: number): Date { const x = new Date(d.getTime()); x.setMonth(x.getMonth() + n); return x; }
export function fmtDate(d: Date | null, today = new Date()): string {
  if (!d) return '';
  const y = d.getFullYear() !== today.getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${MONTH[d.getMonth()]} ${d.getDate()}${y}`;
}
/** Round half up the way a price is printed: 8.995 → 9.00, not 8.99. */
const round2 = (x: number) => Math.round(x * 100 + 1e-9) / 100;   // 8.995*100 is 899.4999… in floating point
const per = (cadence: string) => (cadence === 'year' ? 'yr' : cadence === 'week' ? 'wk' : 'mo');

export function savingLines(i: SavingInput, today = new Date()): { now: string; offer: string } {
  const cad = per(i.cadence);
  const renewal = parseDate(i.renewalDate);
  const trialEnd = parseDate(i.trialEndsOn) || renewal;
  const paying = i.cycleCharge ?? i.monthlyPrice;
  const fd = (d: Date | null) => fmtDate(d, today);

  let now: string;
  if (i.isTrial) {
    const after = i.priceAfterTrial ?? i.monthlyPrice;
    now = `Free trial${trialEnd ? ` until ${fd(trialEnd)}` : ''}${after != null ? `, then ${money(after)}/${cad}` : ''}`;
  } else {
    now = `Paying ${money(paying)}/${cad}${renewal ? ` · next charge ${fd(renewal)}` : ''}`;
  }
  if (!i.hasOffer || !i.offer) return { now, offer: '' };

  const o = i.offer;
  const base = i.isTrial && i.priceAfterTrial != null ? i.priceAfterTrial : (i.monthlyPrice ?? 0);
  const start = i.isTrial ? trialEnd : renewal;
  const term = o.termMonths ?? o.freeMonths ?? 0;
  const end = start && term ? addMonths(start, term) : null;
  const when = start ? (end ? `${fd(start)} – ${fd(end)}` : `from ${fd(start)}`) : (term ? `for ${term} month${term === 1 ? '' : 's'} from your next charge` : 'from your next charge');
  const saves = ` · saves ${money(i.estSavings)}`;
  let pct = o.discountPct ?? 0; if (pct > 1) pct /= 100;

  if (i.cadence === 'year') {
    const yearNow = i.cycleCharge ?? base * 12;
    const next = o.newMonthlyPriceUsd != null ? o.newMonthlyPriceUsd * 12 : pct ? round2(yearNow * (1 - pct)) : null;
    return { now, offer: `${pct ? `${Math.round(pct * 100)}% off your next year` : o.description} → ${next != null ? money(next) : '?'} on ${renewal ? fd(renewal) : 'your next renewal'}${saves}` };
  }
  if (o.freeMonths && !o.newMonthlyPriceUsd) {
    return { now, offer: `${o.freeMonths} month${o.freeMonths === 1 ? '' : 's'} free → $0 ${when}, then ${money(base)}/${cad}${saves}` };
  }
  const newPrice = o.newMonthlyPriceUsd != null ? o.newMonthlyPriceUsd : pct ? round2(base * (1 - pct)) : null;
  const head = pct ? `${Math.round(pct * 100)}% off${term ? ` for ${term} month${term === 1 ? '' : 's'}` : ''}` : o.newMonthlyPriceUsd != null ? `${money(o.newMonthlyPriceUsd)}/${cad} instead of ${money(base)}` : o.description;
  const arrow = newPrice != null && pct ? ` → ${money(newPrice)}/${cad}` : '';
  return { now, offer: `${head}${arrow} ${when}${end ? `, back to ${money(base)}/${cad} after` : ''}${saves}` };
}

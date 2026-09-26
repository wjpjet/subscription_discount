import { handle } from './lib/http.mjs';
import { classify } from './lib/brain.mjs';
import { BRAIN, describeBrain } from './lib/llm.mjs';
import { sensitiveReason, financialPageReason } from '../../shared/sensitive.js';

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };

export default async (req) => handle(req, async (body) => {
  if (!body.snapshot || typeof body.snapshot !== 'object') throw new Error('snapshot required');
  const never = sensitiveReason(String(body.domain || '')) || sensitiveReason(hostOf(body.snapshot.url)) || financialPageReason(body.snapshot.text);
  if (never) return { brain: BRAIN, model: 'none (refused before the model)', provider: 'none', sensitive: never, result: { signedIn: false, hasPaidPlan: null, planName: null, accountEmail: null, monthlyPriceUsd: null, cycleChargeUsd: null, cadence: 'unknown', renewalDate: null, isTrial: false, trialEndsOn: null, priceAfterTrialUsd: null, offerApplied: false, offerText: null, confidence: 1, notes: 'refused: ' + never }, usage: null };
  const { _usage, _provider, ...result } = await classify({ domain: String(body.domain || ''), snapshot: body.snapshot });
  return { brain: BRAIN, model: describeBrain(), provider: _provider, result, usage: _usage || null };
});
export const config = { path: '/api/classify' };

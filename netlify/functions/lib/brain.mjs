import { z } from 'zod';
import { generateStructured, AIDeclined, BRAIN } from './llm.mjs';
import { STATES, ACTIONS, OUTCOMES } from '../../../shared/guardrails.js';
import { mockDecide, mockClassify, mockDiscover } from '../../../shared/brain-mock.js';

export const Decision = z.object({
  state: z.enum(STATES),
  reasoning: z.string().describe('One or two sentences: what this screen is and why this action.'),
  action: z.object({
    type: z.enum(ACTIONS),
    id: z.number().int().nullable().describe('Element id from the snapshot (click/type/select/accept_offer).'),
    text: z.string().nullable().describe('Text to type (type only).'),
    value: z.string().nullable().describe('Option to choose (select only).'),
    url: z.string().nullable().describe('Same-site URL (navigate only).'),
    direction: z.enum(['up', 'down']).nullable(),
    reason: z.string().nullable().describe('Why (back_out / wait).'),
    offer: z.object({ description: z.string(), newMonthlyPriceUsd: z.number().nullable(), discountPct: z.number().nullable(), termMonths: z.number().nullable(), freeMonths: z.number().nullable() }).nullable().describe('The offer being accepted (accept_offer only).'),
    outcome: z.enum(OUTCOMES).nullable().describe('finish only.'),
    details: z.object({ beforeMonthlyPriceUsd: z.number().nullable(), afterMonthlyPriceUsd: z.number().nullable(), termMonths: z.number().nullable(), savingsUsd: z.number().nullable(), summary: z.string() }).nullable().describe('finish only.'),
  }),
});

export const PageClass = z.object({
  signedIn: z.boolean(),
  hasPaidPlan: z.boolean().nullable(),
  planName: z.string().nullable(),
  monthlyPriceUsd: z.number().nullable().describe('Current recurring price normalized to per month.'),
  cadence: z.enum(['month', 'year', 'week', 'unknown']),
  renewalDate: z.string().nullable(),
  offerApplied: z.boolean().describe('True if a promotional/loyalty price is currently applied.'),
  offerText: z.string().nullable(),
  confidence: z.number(),
  notes: z.string(),
});

export const Discovery = z.object({
  services: z.array(z.object({
    domain: z.string(),
    isSubscription: z.boolean().describe('A consumer service with recurring paid plans.'),
    name: z.string(),
    category: z.string(),
    accountUrl: z.string().nullable().describe('Best-guess URL of the signed-in account / subscription / billing page.'),
    typicalMonthlyPriceUsd: z.number().nullable(),
    makesRetentionOffers: z.enum(['likely', 'unlikely', 'unknown']).describe('Does this service show a discount/loyalty offer during its cancellation flow?'),
    typicalOfferDiscountPct: z.number().nullable().describe('If known: typical discount as a fraction of the monthly price, e.g. 0.5.'),
    typicalOfferTermMonths: z.number().nullable().describe('If known: how many months the offer usually lasts.'),
    confidence: z.number(),
    notes: z.string(),
  })),
});

const HUNT_SYSTEM = `You are Walkaway, an agent operating a signed-in browser tab on a subscription service, on the user's behalf.

MISSION
Find the subscription/billing settings, begin the cancellation flow, and proceed through its steps (reason surveys, "are you sure" interstitials) ONLY until one of these happens:
 (a) A retention / loyalty offer appears that keeps the SAME subscription active at a lower price or with free months → call accept_offer on the button that accepts it. Then, on the confirmation screen, call finish with outcome discount_applied and the numbers.
 (b) You reach the final confirmation step and no such offer was made → call back_out. Do not press anything on that screen.
The user wants to KEEP the subscription. Finalizing a cancellation is a failure, never a success.

HARD RULES
- Never click anything that confirms, completes, or proceeds with cancellation, declines an offer ("no thanks", "continue cancelling"), turns off auto-renew, pauses, downgrades, or deletes/closes the account. If the only options are those, call back_out.
- Once an offer is on screen, the only valid actions are accept_offer or back_out.
- Do not accept pauses, downgrades, plan switches, or offers that change the product. Only discounts / free months on the current plan. If several qualifying offers exist, pick the largest saving.
- Never type into password or payment fields. If a login page appears, finish with outcome blocked_needs_you.
- navigate only to URLs on this service's own domain. Prefer clicking visible elements; use navigate for obvious account/settings paths when no link is visible.
- One action per step. If nothing changed after an action, try a different element; after three fruitless steps, back_out.
- Classify the screen honestly in "state". Use about_to_finalize_cancel when the screen's primary purpose is confirming cancellation. Use ambiguous when unsure — ambiguity resolves to back_out, never forward.

OUTPUT
Return exactly one decision: the screen state, a one-sentence reasoning, and one action. Element ids refer to the numbered elements in the snapshot.`;

const CLASSIFY_SYSTEM = `You read a snapshot of a subscription service's account/billing page and report the signed-in subscription state precisely. Normalize prices to USD per month. If the page is a login wall, signedIn=false. If signed in but there is no paid plan, hasPaidPlan=false. Report an applied promotional/loyalty price when the page shows one.`;

const DISCOVER_SYSTEM = `You classify website domains. For each domain, decide whether it is a consumer service with recurring paid subscriptions (streaming, news, software, VPN, fitness, dating, cloud storage, memberships, etc.). Use your knowledge of the company. Infrastructure, ad-tech, banks, retailers without memberships, social networks without paid tiers, and unknown domains are not subscriptions. For real services give your best-guess signed-in account/subscription page URL, a typical monthly price in USD, whether the service is known to present a discount or loyalty offer during its cancellation flow, and if known the typical discount fraction and term in months.`;

export function renderSnapshot(s) {
  const lines = [`URL: ${s.url}`, `TITLE: ${s.title || ''}`];
  if (s.headings && s.headings.length) lines.push(`HEADINGS: ${s.headings.join(' | ')}`);
  if (s.hasPassword) lines.push('NOTE: a password field is present (login page?)');
  if (s.prices && s.prices.length) lines.push('PRICES: ' + s.prices.slice(0, 12).map((p) => `$${p.amount}${p.unit ? '/' + p.unit : ''} («${p.context.trim()}»)`).join(' ; '));
  lines.push('ELEMENTS:');
  for (const e of s.elements || []) {
    const bits = [`[${e.id}] <${e.tag}${e.role ? ' role=' + e.role : ''}${e.type ? ' type=' + e.type : ''}>`];
    if (e.text) bits.push(`"${e.text}"`);
    if (e.label && e.label !== e.text) bits.push(`label="${e.label}"`);
    if (e.href) bits.push(`href=${e.href}`);
    if (e.name) bits.push(`name=${e.name}`);
    if (e.placeholder) bits.push(`placeholder="${e.placeholder}"`);
    if (e.value) bits.push(`value="${e.value}"`);
    if (e.checked != null) bits.push(e.checked ? 'checked' : 'unchecked');
    if (e.options) bits.push(`options=${JSON.stringify(e.options)}`);
    if (e.disabled) bits.push('DISABLED');
    if (e.offscreen) bits.push('(offscreen)');
    lines.push('  ' + bits.join(' '));
  }
  lines.push('PAGE TEXT (truncated):', (s.text || '').slice(0, 3500));
  return lines.join('\n');
}
function renderHistory(history) {
  if (!history || !history.length) return '(none)';
  return history.slice(-12).map((h) => `step ${h.step}: [${h.state}] ${h.action ? h.action.type : ''}${h.action && h.action.id != null ? ' #' + h.action.id : ''}${h.target ? ' "' + h.target + '"' : ''}${h.note ? ' — ' + h.note : ''} @ ${h.url || ''}`).join('\n');
}
const NULLS = { id: null, text: null, value: null, url: null, direction: null, reason: null, offer: null, outcome: null, details: null };

export async function decide(input) {
  if (BRAIN === 'mock') return mockDecide(input);
  const { merchant, goal, step, maxSteps, history, snapshot } = input;
  const user = [
    `SERVICE: ${merchant.name || merchant.domain} (${merchant.domain})`,
    `GOAL: ${goal === 'verify' ? 'VERIFY — this is the account/billing page after the run. Do not act; call finish with the current monthly price and whether a promotional price is applied.' : 'HUNT — reach the loyalty offer and accept it; never finalize a cancellation.'}`,
    `STEP: ${step} of ${maxSteps}`, `HISTORY:\n${renderHistory(history)}`, `CURRENT PAGE:\n${renderSnapshot(snapshot)}`,
  ].join('\n\n');
  try {
    const { output, provider, model } = await generateStructured({ system: HUNT_SYSTEM, user, schema: Decision, maxTokens: 8000 });
    return { ...output, _provider: provider, _model: model };
  } catch (e) {
    if (e instanceof AIDeclined) return { state: 'ambiguous', reasoning: e.message, action: { ...NULLS, type: 'back_out', reason: 'ai_declined: ' + e.message }, _provider: 'none' };
    throw e; // outage → HTTP 500 → the extension retries, then stops without acting
  }
}

export async function classify(input) {
  if (BRAIN === 'mock') return { ...mockClassify(input.snapshot), _provider: 'mock' };
  try {
    const { output, provider } = await generateStructured({ system: CLASSIFY_SYSTEM, user: `DOMAIN: ${input.domain}\n\n${renderSnapshot(input.snapshot)}`, schema: PageClass, maxTokens: 3000, effort: 'low' });
    return { ...output, _provider: provider };
  } catch (e) {
    console.error('[classify] falling back to heuristics:', e.message);
    return { ...mockClassify(input.snapshot), notes: 'heuristic fallback: ' + e.message, _provider: 'fallback' };
  }
}

const discoverCache = new Map();
export async function discover(domains) {
  if (BRAIN === 'mock') return mockDiscover(domains);
  const out = [], todo = [];
  for (const d of domains) { if (discoverCache.has(d)) out.push(discoverCache.get(d)); else todo.push(d); }
  for (let i = 0; i < todo.length; i += 25) {   // small chunks: each call stays well under a 10s function timeout
    const chunk = todo.slice(i, i + 25);
    const { output } = await generateStructured({ system: DISCOVER_SYSTEM, user: `Classify these domains:\n${chunk.join('\n')}`, schema: Discovery, maxTokens: 6000, effort: 'low' });
    const byDomain = new Map((output.services || []).map((s) => [s.domain.toLowerCase(), s]));
    for (const d of chunk) {
      const r = byDomain.get(d.toLowerCase()) || { domain: d, isSubscription: false, name: d, category: 'unknown', accountUrl: null, typicalMonthlyPriceUsd: null, makesRetentionOffers: 'unknown', typicalOfferDiscountPct: null, typicalOfferTermMonths: null, confidence: 0.1, notes: 'not returned by model' };
      discoverCache.set(d, r); out.push(r);
    }
  }
  return out;
}

// One tiny call per tier before a run: fail fast with the real API error instead of 100 identical failures.
import { z } from 'zod';
function hint(msg) {
  if (/404|not found|NOT_FOUND/i.test(msg)) return 'That model id is not available to this key. Run `npm run models` to list the ids your key can use, then set GEMINI_MODEL / GEMINI_MODEL_FAST (or --model / --fast-model).';
  if (/API key|401|403|PERMISSION_DENIED|UNAUTHENTICATED/i.test(msg)) return 'Check GEMINI_API_KEY / ANTHROPIC_API_KEY in .env (root of the repo).';
  if (/think/i.test(msg)) return 'This model rejects the thinking setting; try --thinking=default (and --fast-thinking=default).';
  if (/quota|429|RESOURCE_EXHAUSTED/i.test(msg)) return 'Rate limit or quota — lower --concurrency, or check the billing/quota page for this key.';
  return '';
}
export async function preflight() {
  if ((process.env.WALKAWAY_BRAIN || '') === 'mock') return { brain: 'mock' };
  const llm = await import('../../netlify/functions/lib/llm.mjs');
  if (llm.BRAIN === 'mock') return { brain: 'mock' };
  const schema = z.object({ ok: z.boolean() });
  const t0 = Date.now();
  try {
    const main = await llm.generateStructured({ system: 'You answer with JSON only.', user: 'Return {"ok": true}.', schema, maxTokens: 200, tier: 'main' });
    const fast = await llm.generateStructured({ system: 'You answer with JSON only.', user: 'Return {"ok": true}.', schema, maxTokens: 200, tier: 'fast' });
    return { brain: 'llm', provider: main.provider, model: main.model, fastModel: fast.model, ms: Date.now() - t0, thinking: `${llm.THINKING_STEP}/${llm.THINKING_FAST}` };
  } catch (e) {
    const msg = String((e && e.message) || e);
    throw new Error(`Preflight failed: ${msg}${hint(msg) ? '\n  → ' + hint(msg) : ''}`);
  }
}

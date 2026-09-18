// One tiny call per tier before a run: fail fast with the real API error instead of 100 identical failures.
import { z } from 'zod';
function hint(msg) {
  if (/404|not found|NOT_FOUND|model_not_available/i.test(msg)) return 'That model id is not available to this key. Run `npm run models` for Gemini/Anthropic ids; for an OpenAI-compatible host, check its own model list. Then set the matching --model / --openai-model.';
  if (/API key|401|403|PERMISSION_DENIED|UNAUTHENTICATED|invalid_api_key/i.test(msg)) return 'Check GEMINI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY in .env (root of the repo).';
  if (/think|reasoning/i.test(msg)) return 'This model rejects the thinking setting; try --thinking=default (or --openai-thinking=default).';
  if (/response_format|json_schema|schema/i.test(msg)) return 'This endpoint may not support strict JSON-schema output. The provider layer falls back automatically, so if this still failed the endpoint likely rejects json_object too.';
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
    const main = await llm.generateStructured({ system: 'You answer with JSON only.', user: 'Return {"ok": true}.', schema, maxTokens: 2000, tier: 'main' });   // thinking shares this budget
    const fast = await llm.generateStructured({ system: 'You answer with JSON only.', user: 'Return {"ok": true}.', schema, maxTokens: 2000, tier: 'fast' });
    // Report the thinking setting for the provider that actually answered, not always Gemini's.
    const thinking = main.provider === 'openai'
      ? `${llm.OPENAI_THINKING_STEP}/${llm.OPENAI_THINKING_FAST}`
      : `${llm.THINKING_STEP}/${llm.THINKING_FAST}`;
    return { brain: 'llm', provider: main.provider, model: main.model, fastModel: fast.model, ms: Date.now() - t0, thinking };
  } catch (e) {
    const msg = String((e && e.message) || e);
    throw new Error(`Preflight failed: ${msg}${hint(msg) ? '\n  → ' + hint(msg) : ''}`);
  }
}

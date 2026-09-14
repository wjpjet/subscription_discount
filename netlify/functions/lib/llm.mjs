// Provider layer. Every brain call is "system + user → JSON matching a zod schema".
//   AI_PROVIDER = "anthropic" | "gemini" | "gemini,anthropic" (fallback order). Default: whichever keys exist.
//   ANTHROPIC_API_KEY + AGENT_MODEL (default claude-opus-5) + AGENT_EFFORT (default medium)
//   GEMINI_API_KEY   + GEMINI_MODEL (default gemini-3.8-flash)
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const ANTHROPIC_MODEL = process.env.AGENT_MODEL || 'claude-opus-5';
export const ANTHROPIC_MODEL_FAST = process.env.AGENT_MODEL_FAST || ANTHROPIC_MODEL;   // classify/discover
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';            // navigation steps
export const GEMINI_MODEL_FAST = process.env.GEMINI_MODEL_FAST || 'gemini-3.1-flash-lite'; // classify/discover: cheapest Lite, accuracy-neutral in the suite
export const EFFORT = process.env.AGENT_EFFORT || 'medium';
// Gemini thinking per task: "default" (model decides), "off", "low"|"medium"|"high" (3.x thinkingLevel), or a token budget like "512".
export const THINKING_STEP = process.env.GEMINI_THINKING_STEP || 'default';
export const THINKING_FAST = process.env.GEMINI_THINKING_FAST || 'off';
// Models disagree on how to switch thinking off/low: try shapes in order, remember what each model accepted.
const THINK_CANDIDATES = {
  off: [{ thinkingLevel: 'minimal' }, { thinkingBudget: 0 }, { thinkingLevel: 'low' }, null],
  low: [{ thinkingLevel: 'low' }, { thinkingBudget: 512 }, null],
  medium: [{ thinkingLevel: 'medium' }, null],
  high: [{ thinkingLevel: 'high' }, null],
};
function thinkingCandidates(mode) {
  if (!mode || mode === 'default') return [null];
  if (THINK_CANDIDATES[mode]) return THINK_CANDIDATES[mode];
  if (/^\d+$/.test(mode)) return [{ thinkingBudget: Number(mode) }, { thinkingLevel: 'low' }, null];
  return [{ thinkingLevel: mode }, null];
}
const acceptedShape = new Map(); // `${model}:${mode}` → index into the candidate list;

/** The model declined (safety refusal / blocked). Distinct from an outage. */
export class AIDeclined extends Error {}

export function providerOrder() {
  const explicit = (process.env.AI_PROVIDER || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (explicit.length) return explicit;
  const order = [];
  if (process.env.GEMINI_API_KEY) order.push('gemini');            // default brain: Gemini Flash
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) order.push('anthropic');
  return order;
}
export const BRAIN = process.env.WALKAWAY_BRAIN || (providerOrder().length ? 'llm' : 'mock');
export function describeBrain() { return BRAIN === 'mock' ? 'mock' : providerOrder().map((p) => (p === 'gemini' ? `gemini:${GEMINI_MODEL}${GEMINI_MODEL_FAST !== GEMINI_MODEL ? '+' + GEMINI_MODEL_FAST : ''}(think:${THINKING_STEP}/${THINKING_FAST})` : `anthropic:${ANTHROPIC_MODEL}`)).join(' → '); }
export const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, calls: 0 };
export function addUsage(a, b) { if (!b) return a; return { inputTokens: a.inputTokens + (b.inputTokens || 0), outputTokens: a.outputTokens + (b.outputTokens || 0), thinkingTokens: a.thinkingTokens + (b.thinkingTokens || 0), calls: a.calls + (b.calls || 0) }; }

let anthropic;
async function callAnthropic({ system, user, schema, maxTokens, effort, model }) {
  anthropic ||= new Anthropic();
  const res = await anthropic.messages.parse({
    model,
    max_tokens: maxTokens,
    cache_control: { type: 'ephemeral' },
    system,
    output_config: { format: zodOutputFormat(schema), effort },
    messages: [{ role: 'user', content: user }],
  });
  if (res.stop_reason === 'refusal') throw new AIDeclined(`anthropic declined${res.stop_details && res.stop_details.category ? ' (' + res.stop_details.category + ')' : ''}`);
  if (!res.parsed_output) throw new Error('anthropic: no parseable output');
  const u = res.usage || {};
  return { output: res.parsed_output, provider: 'anthropic', model, usage: { inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), outputTokens: u.output_tokens || 0, thinkingTokens: 0, calls: 1 } };
}

export function geminiSchema(zodSchema) {
  const js = zodToJsonSchema(zodSchema, { target: 'openApi3', $refStrategy: 'none' });
  const strip = (o) => {
    if (Array.isArray(o)) return o.map(strip);
    if (o && typeof o === 'object') { const out = {}; for (const [k, v] of Object.entries(o)) { if (['$schema', 'additionalProperties', 'default', '$ref', 'definitions'].includes(k)) continue; out[k] = strip(v); } return out; }
    return o;
  };
  return strip(js);
}
async function callGemini({ system, user, schema, maxTokens, model, thinking }) {
  const key = process.env.GEMINI_API_KEY; if (!key) throw new Error('GEMINI_API_KEY not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const base = { responseMimeType: 'application/json', responseSchema: geminiSchema(schema), maxOutputTokens: maxTokens, temperature: 0.2 };
  const post = (gc) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: gc }) });
  const mode = thinking || 'default', cands = thinkingCandidates(mode), memo = `${model}:${mode}`;
  let res;
  for (let i = acceptedShape.get(memo) || 0; i < cands.length; i++) {
    const gc = { ...base }; if (cands[i]) gc.thinkingConfig = cands[i];
    res = await post(gc);
    if (res.status === 400 && cands[i] && i < cands.length - 1) {
      const txt = await res.text();
      console.warn(`[gemini] ${model}: thinking ${JSON.stringify(cands[i])} rejected (${txt.replace(/\s+/g, ' ').slice(0, 90)}) — trying the next shape`);
      continue;
    }
    if (!res.ok) { const e = new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`); e.status = res.status; throw e; }
    if (acceptedShape.get(memo) !== i) { acceptedShape.set(memo, i); if (i > 0) console.warn(`[gemini] ${model}: using thinking shape ${JSON.stringify(cands[i])} for mode "${mode}"`); }
    break;
  }
  const j = await res.json();
  const cand = j.candidates && j.candidates[0];
  if (!cand) throw new AIDeclined(`gemini declined (${(j.promptFeedback && j.promptFeedback.blockReason) || 'no candidates'})`);
  if (cand.finishReason && !['STOP', 'MAX_TOKENS'].includes(cand.finishReason)) throw new AIDeclined(`gemini declined (${cand.finishReason})`);
  // Thinking models may return their thoughts as extra parts (flagged `thought: true`) — keep only the answer.
  const text = ((cand.content && cand.content.parts) || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  let parsed; try { parsed = JSON.parse(text); } catch { throw new Error('gemini: response was not valid JSON'); }
  const v = schema.safeParse(parsed);
  if (!v.success) throw new Error('gemini: schema mismatch: ' + v.error.issues.slice(0, 3).map((i) => i.path.join('.') + ' ' + i.message).join('; '));
  const u = j.usageMetadata || {};
  return { output: v.data, provider: 'gemini', model, usage: { inputTokens: u.promptTokenCount || 0, outputTokens: u.candidatesTokenCount || 0, thinkingTokens: u.thoughtsTokenCount || 0, calls: 1 } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transient = (e) => e && (e.status === 429 || e.status >= 500 || e instanceof TypeError || /fetch failed|ECONN|ETIMEDOUT|socket/i.test(String(e.message)));

/** Try providers in order. A decline moves to the next provider; an outage retries once then moves on. */
/** tier "main" = navigation steps; tier "fast" = classification / discovery (cheaper model, thinking off by default). */
export async function generateStructured({ system, user, schema, maxTokens = 8000, effort = EFFORT, tier = 'main', thinking }) {
  const order = providerOrder();
  if (!order.length) throw new Error('No AI provider configured — set ANTHROPIC_API_KEY or GEMINI_API_KEY.');
  const fast = tier === 'fast';
  let declined = null, failure = null;
  for (const p of order) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return p === 'gemini'
          ? await callGemini({ system, user, schema, maxTokens, model: fast ? GEMINI_MODEL_FAST : GEMINI_MODEL, thinking: thinking ?? (fast ? THINKING_FAST : THINKING_STEP) })
          : await callAnthropic({ system, user, schema, maxTokens, effort: fast ? 'low' : effort, model: fast ? ANTHROPIC_MODEL_FAST : ANTHROPIC_MODEL });
      }
      catch (e) {
        if (e instanceof AIDeclined) { declined = e; break; }
        failure = e; console.error(`[llm] ${p} attempt ${attempt + 1}:`, e.message);
        if (attempt === 0 && transient(e)) { await sleep(900); continue; }
        break;
      }
    }
  }
  if (declined && !failure) throw declined;
  if (declined) throw declined;
  throw failure;
}

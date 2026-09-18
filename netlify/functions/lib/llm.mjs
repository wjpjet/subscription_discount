// Provider layer. Every brain call is "system + user → JSON matching a zod schema".
//   AI_PROVIDER = "anthropic" | "gemini" | "gemini,anthropic" (fallback order). Default: whichever keys exist.
//   ANTHROPIC_API_KEY + AGENT_MODEL (default claude-opus-5) + AGENT_EFFORT (default medium)
//   GEMINI_API_KEY   + GEMINI_MODEL (default gemini-3.8-flash)
//   OPENAI_API_KEY   + OPENAI_BASE_URL + OPENAI_MODEL  — any OpenAI-compatible endpoint
//     (Z.ai/GLM, OpenRouter, Together, Fireworks, Novita, SiliconFlow, DeepSeek...). Provider id: "openai".
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// These are `let`, not `const`, and re-read by refreshConfig(). ESM live bindings mean importers see
// the new values. Cloudflare Workers evaluate module scope before request bindings exist, so the
// Worker entry calls refreshConfig() once the environment is populated; on Node it is a no-op repeat.
export let ANTHROPIC_MODEL, ANTHROPIC_MODEL_FAST, GEMINI_MODEL, GEMINI_MODEL_FAST, EFFORT, THINKING_STEP, THINKING_FAST, BRAIN;
export let OPENAI_BASE_URL, OPENAI_MODEL, OPENAI_MODEL_FAST, OPENAI_THINKING_STEP, OPENAI_THINKING_FAST;
export function refreshConfig() {
  ANTHROPIC_MODEL = process.env.AGENT_MODEL || 'claude-opus-5';
  ANTHROPIC_MODEL_FAST = process.env.AGENT_MODEL_FAST || ANTHROPIC_MODEL;         // classify/discover
  GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';                  // navigation steps
  GEMINI_MODEL_FAST = process.env.GEMINI_MODEL_FAST || 'gemini-3.1-flash-lite';   // classify/discover: cheapest Lite, accuracy-neutral in the suite
  EFFORT = process.env.AGENT_EFFORT || 'medium';
  // Gemini thinking per task: "default" (model decides), "off", "low"|"medium"|"high" (3.x thinkingLevel), or a token budget like "512".
  THINKING_STEP = process.env.GEMINI_THINKING_STEP || 'default';
  THINKING_FAST = process.env.GEMINI_THINKING_FAST || 'off';
  OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || '').replace(/\/+$/, '');
  OPENAI_MODEL = process.env.OPENAI_MODEL || '';
  OPENAI_MODEL_FAST = process.env.OPENAI_MODEL_FAST || OPENAI_MODEL;
  OPENAI_THINKING_STEP = process.env.OPENAI_THINKING_STEP || 'default';
  OPENAI_THINKING_FAST = process.env.OPENAI_THINKING_FAST || 'off';
  BRAIN = process.env.WALKAWAY_BRAIN || (providerOrder().length ? 'llm' : 'mock');
}
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
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL) order.push('openai');
  if (process.env.GEMINI_API_KEY) order.push('gemini');            // default brain: Gemini Flash
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) order.push('anthropic');
  return order;
}
refreshConfig();   // initial read; safe to call again once bindings exist
export function describeBrain() {
  if (BRAIN === 'mock') return 'mock';
  return providerOrder().map((p) => {
    if (p === 'gemini') return `gemini:${GEMINI_MODEL}${GEMINI_MODEL_FAST !== GEMINI_MODEL ? '+' + GEMINI_MODEL_FAST : ''}(think:${THINKING_STEP}/${THINKING_FAST})`;
    if (p === 'openai') return `openai:${OPENAI_MODEL}${OPENAI_MODEL_FAST !== OPENAI_MODEL ? '+' + OPENAI_MODEL_FAST : ''}(think:${OPENAI_THINKING_STEP}/${OPENAI_THINKING_FAST}) @ ${OPENAI_BASE_URL}`;
    return `anthropic:${ANTHROPIC_MODEL}`;
  }).join(' → ');
}
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
  let parsed; try { parsed = JSON.parse(text); } catch {
    const u0 = j.usageMetadata || {};
    if (cand.finishReason === 'MAX_TOKENS' || !text.trim()) throw new Error(`gemini: output truncated before the JSON (finishReason=${cand.finishReason}, thinking tokens=${u0.thoughtsTokenCount || 0}, maxOutputTokens=${maxTokens}) — raise maxTokens or lower thinking`);
    throw new Error('gemini: response was not valid JSON: ' + text.slice(0, 120).replace(/\s+/g, ' '));
  }
  const v = schema.safeParse(parsed);
  if (!v.success) throw new Error('gemini: schema mismatch: ' + v.error.issues.slice(0, 3).map((i) => i.path.join('.') + ' ' + i.message).join('; '));
  const u = j.usageMetadata || {};
  return { output: v.data, provider: 'gemini', model, usage: { inputTokens: u.promptTokenCount || 0, outputTokens: u.candidatesTokenCount || 0, thinkingTokens: u.thoughtsTokenCount || 0, calls: 1 } };
}

/** JSON Schema for OpenAI-style `strict` structured output: every object closed, every property required.
 *  Our zod schemas use .nullable() rather than .optional(), so "all properties required" is already true. */
export function strictSchema(zodSchema) {
  const js = zodToJsonSchema(zodSchema, { target: 'jsonSchema7', $refStrategy: 'none' });
  const walk = (o) => {
    if (Array.isArray(o)) return o.map(walk);
    if (!o || typeof o !== 'object') return o;
    const out = {};
    for (const [k, v] of Object.entries(o)) { if (k === '$schema' || k === 'definitions' || k === '$ref') continue; out[k] = walk(v); }
    if (out.type === 'object' && out.properties) { out.additionalProperties = false; out.required = Object.keys(out.properties); }
    return out;
  };
  return walk(js);
}

// Providers disagree on how to ask for schema-constrained JSON, and on how to turn reasoning off.
// Same approach as the Gemini thinking shapes: try in order, remember what this model accepted.
const FORMAT_CANDIDATES = [
  (name, schema) => ({ response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } } }),
  (name, schema) => ({ response_format: { type: 'json_schema', json_schema: { name, schema } } }),
  () => ({ response_format: { type: 'json_object' } }),
  () => ({}),
];
const OA_THINK_CANDIDATES = {
  off: [{ thinking: { type: 'disabled' } }, { enable_thinking: false }, { reasoning_effort: 'minimal' }, { reasoning_effort: 'none' }, null],
  low: [{ reasoning_effort: 'low' }, { thinking: { type: 'enabled' } }, null],
  medium: [{ reasoning_effort: 'medium' }, { thinking: { type: 'enabled' } }, null],
  high: [{ reasoning_effort: 'high' }, { thinking: { type: 'enabled' } }, null],
};
function oaThinkingCandidates(mode) {
  if (!mode || mode === 'default') return [null];
  return OA_THINK_CANDIDATES[mode] || [{ reasoning_effort: mode }, null];
}

/** Any OpenAI-compatible /chat/completions endpoint (Z.ai/GLM, OpenRouter, Together, Fireworks, ...). */
async function callOpenAICompat({ system, user, schema, maxTokens, model, thinking }) {
  const key = process.env.OPENAI_API_KEY; if (!key) throw new Error('OPENAI_API_KEY not set');
  const baseUrl = OPENAI_BASE_URL; if (!baseUrl) throw new Error('OPENAI_BASE_URL not set');
  if (!model) throw new Error('OPENAI_MODEL not set');
  const url = `${baseUrl}/chat/completions`;
  const js = strictSchema(schema);
  const mode = thinking || 'default';
  const thinkCands = oaThinkingCandidates(mode);
  const fKey = `oa-format:${model}`, tKey = `oa-think:${model}:${mode}`;

  const post = (fmt, think) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model, max_tokens: maxTokens, temperature: 0.2,
      messages: [
        // When the endpoint has no schema mode, the schema has to travel in the prompt instead.
        { role: 'system', content: fmt.response_format && fmt.response_format.type === 'json_schema' ? system : `${system}\n\nReply with JSON only, matching this JSON Schema exactly:\n${JSON.stringify(js)}` },
        { role: 'user', content: user },
      ],
      ...fmt, ...(think || {}),
    }),
  });

  let res, usedF = acceptedShape.get(fKey) || 0, usedT = acceptedShape.get(tKey) || 0;
  outer:
  for (let fi = usedF; fi < FORMAT_CANDIDATES.length; fi++) {
    const fmt = FORMAT_CANDIDATES[fi]('walkaway_result', js);
    for (let ti = usedT; ti < thinkCands.length; ti++) {
      res = await post(fmt, thinkCands[ti]);
      if (res.ok) { usedF = fi; usedT = ti; break outer; }
      if (res.status === 400 || res.status === 422) {
        const txt = (await res.text()).replace(/\s+/g, ' ').slice(0, 120);
        if (ti < thinkCands.length - 1) { console.warn(`[openai] ${model}: thinking ${JSON.stringify(thinkCands[ti])} rejected (${txt}) — next shape`); continue; }
        if (fi < FORMAT_CANDIDATES.length - 1) { console.warn(`[openai] ${model}: response_format ${JSON.stringify(fmt.response_format || null)} rejected (${txt}) — next shape`); usedT = acceptedShape.get(tKey) || 0; continue outer; }
      }
      const e = new Error(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`); e.status = res.status; throw e;
    }
  }
  if (acceptedShape.get(fKey) !== usedF) { acceptedShape.set(fKey, usedF); if (usedF > 0) console.warn(`[openai] ${model}: using response_format shape #${usedF}`); }
  if (acceptedShape.get(tKey) !== usedT) { acceptedShape.set(tKey, usedT); if (usedT > 0) console.warn(`[openai] ${model}: using thinking shape ${JSON.stringify(thinkCands[usedT])} for "${mode}"`); }

  const j = await res.json();
  const choice = j.choices && j.choices[0];
  if (!choice) throw new AIDeclined('openai declined (no choices)');
  if (choice.finish_reason === 'content_filter') throw new AIDeclined('openai declined (content_filter)');
  const msg = choice.message || {};
  if (msg.refusal) throw new AIDeclined(`openai declined (${String(msg.refusal).slice(0, 120)})`);
  // Reasoning models return their chain in a separate field (reasoning_content), so `content` is clean JSON.
  let text = (msg.content || '').trim();
  if (!text) throw new Error(`openai: empty content (finish_reason=${choice.finish_reason}) — raise maxTokens or lower thinking`);
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);   // some endpoints wrap JSON in a code fence
  if (fence) text = fence[1].trim();
  let parsed; try { parsed = JSON.parse(text); } catch {
    if (choice.finish_reason === 'length') throw new Error(`openai: output truncated before the JSON (maxTokens=${maxTokens}) — raise maxTokens or lower thinking`);
    throw new Error('openai: response was not valid JSON: ' + text.slice(0, 120).replace(/\s+/g, ' '));
  }
  const v = schema.safeParse(parsed);
  if (!v.success) throw new Error('openai: schema mismatch: ' + v.error.issues.slice(0, 3).map((i) => i.path.join('.') + ' ' + i.message).join('; '));
  const u = j.usage || {};
  const reasoning = (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || u.reasoning_tokens || 0;
  return { output: v.data, provider: 'openai', model, usage: { inputTokens: u.prompt_tokens || 0, outputTokens: (u.completion_tokens || 0) - reasoning, thinkingTokens: reasoning, calls: 1 } };
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
        if (p === 'gemini') return await callGemini({ system, user, schema, maxTokens, model: fast ? GEMINI_MODEL_FAST : GEMINI_MODEL, thinking: thinking ?? (fast ? THINKING_FAST : THINKING_STEP) });
        if (p === 'openai') return await callOpenAICompat({ system, user, schema, maxTokens, model: fast ? OPENAI_MODEL_FAST : OPENAI_MODEL, thinking: thinking ?? (fast ? OPENAI_THINKING_FAST : OPENAI_THINKING_STEP) });
        return await callAnthropic({ system, user, schema, maxTokens, effort: fast ? 'low' : effort, model: fast ? ANTHROPIC_MODEL_FAST : ANTHROPIC_MODEL });
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

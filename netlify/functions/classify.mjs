import { handle } from './lib/http.mjs';
import { classify } from './lib/brain.mjs';
import { BRAIN, describeBrain } from './lib/llm.mjs';
import { sensitiveReason, financialPageReason } from '../../shared/sensitive.js';
import { blankPageClass } from '../../shared/brain-mock.js';

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
// The extension's readinessProbe result; only the fields the prompt prints (its url is the snapshot's anyway).
const READINESS_KEYS = ['readyState', 'visibleTextLen', 'interactiveCount', 'hasPassword', 'busy', 'loadingText', 'challenge', 'dialog'];
const pickReadiness = (r) => (r && typeof r === 'object' && !Array.isArray(r) ? Object.fromEntries(READINESS_KEYS.filter((k) => k in r).map((k) => [k, typeof r[k] === 'string' ? r[k].slice(0, 120) : r[k]])) : null);

export default async (req) => handle(req, async (body) => {
  if (!body.snapshot || typeof body.snapshot !== 'object') throw new Error('snapshot required');
  const never = sensitiveReason(String(body.domain || '')) || sensitiveReason(hostOf(body.snapshot.url)) || financialPageReason(body.snapshot.text);
  if (never) return { brain: BRAIN, model: 'none (refused before the model)', provider: 'none', sensitive: never, result: { ...blankPageClass('refused: ' + never), confidence: 1 }, usage: null };
  const { _usage, _provider, ...result } = await classify({ domain: String(body.domain || ''), name: String(body.name || '').slice(0, 120), snapshot: body.snapshot, readiness: pickReadiness(body.readiness) });
  return { brain: BRAIN, model: describeBrain(), provider: _provider, result, usage: _usage || null };
});
export const config = { path: '/api/classify' };

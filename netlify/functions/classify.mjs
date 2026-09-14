import { handle } from './lib/http.mjs';
import { classify } from './lib/brain.mjs';
import { BRAIN, describeBrain } from './lib/llm.mjs';

export default async (req) => handle(req, async (body) => {
  if (!body.snapshot || typeof body.snapshot !== 'object') throw new Error('snapshot required');
  const { _usage, _provider, ...result } = await classify({ domain: String(body.domain || ''), snapshot: body.snapshot });
  return { brain: BRAIN, model: describeBrain(), provider: _provider, result, usage: _usage || null };
});
export const config = { path: '/api/classify' };

import { handle } from './lib/http.mjs';
import { classify } from './lib/brain.mjs';
import { BRAIN, describeBrain } from './lib/llm.mjs';

export default async (req) => handle(req, async (body) => {
  if (!body.snapshot || typeof body.snapshot !== 'object') throw new Error('snapshot required');
  const result = await classify({ domain: String(body.domain || ''), snapshot: body.snapshot });
  return { brain: BRAIN, model: describeBrain(), result };
});
export const config = { path: '/api/classify' };

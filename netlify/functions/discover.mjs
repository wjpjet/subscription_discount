import { handle } from './lib/http.mjs';
import { discover } from './lib/brain.mjs';
import { BRAIN, describeBrain } from './lib/llm.mjs';
import { etld1, isInfra } from '../../shared/domains.js';

export default async (req) => handle(req, async (body) => {
  const raw = Array.isArray(body.domains) ? body.domains : [];
  const domains = [...new Set(raw.map((d) => etld1(String(d))).filter((d) => d && d.includes('.') && !isInfra(d)))].slice(0, 400);
  const { services, usage } = await discover(domains);
  return { brain: BRAIN, model: describeBrain(), services, usage };
});
export const config = { path: '/api/discover' };

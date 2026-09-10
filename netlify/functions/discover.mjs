import { handle } from './lib/http.mjs';
import { discover } from './lib/brain.mjs';
import { BRAIN, MODEL } from './lib/anthropic.mjs';
import { etld1, isInfra } from '../../shared/domains.js';

export default async (req) => handle(req, async (body) => {
  const raw = Array.isArray(body.domains) ? body.domains : [];
  const domains = [...new Set(raw.map((d) => etld1(String(d))).filter((d) => d && d.includes('.') && !isInfra(d)))].slice(0, 400);
  const services = await discover(domains);
  return { brain: BRAIN, model: MODEL, services };
});
export const config = { path: '/api/discover' };

import { handle } from './lib/http.mjs';
import { decide } from './lib/brain.mjs';
import { BRAIN, describeBrain } from './lib/llm.mjs';
import { applyGuardrails } from '../../shared/guardrails.js';

export default async (req) => handle(req, async (body) => {
  const { merchant, snapshot } = body;
  if (!merchant || !merchant.domain) throw new Error('merchant.domain required');
  if (!snapshot || !Array.isArray(snapshot.elements)) throw new Error('snapshot.elements required');
  const step = Number(body.step || 0), maxSteps = Math.min(Number(body.maxSteps || 25), 40);
  const history = Array.isArray(body.history) ? body.history : [];
  const goal = body.goal === 'verify' ? 'verify' : 'hunt';
  const { _usage, _provider, _model, ...proposed } = await decide({ merchant, goal, step, maxSteps, history, snapshot });
  const { decision, notes } = applyGuardrails({ decision: proposed, snapshot, history, merchantDomain: merchant.domain, step, maxSteps, goal });
  return { brain: BRAIN, model: _model || describeBrain(), provider: _provider, proposed: proposed.action, decision, guardrails: notes, usage: _usage || null };
});
export const config = { path: '/api/agent-step' };

import { handle } from './lib/http.mjs';
import { decide } from './lib/brain.mjs';
import { BRAIN, describeBrain } from './lib/llm.mjs';
import { applyGuardrails } from '../../shared/guardrails.js';
import { sensitiveReason, financialPageReason } from '../../shared/sensitive.js';
import { etld1 } from '../../shared/domains.js';

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
// A registrable domain (netflix.com, foo.co.uk), never a bare suffix (com, co.uk), which would open every site
// under it to navigate. localhost and IPs are the testbeds.
const registrable = (d) => d === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(d) || (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && etld1('x.' + d) !== 'x.' + d);

/**
 * The other registrable domains the account lives on (cursor.sh signs in on cursor.com), as the extension saw
 * them. The client is not trusted: at most 5 entries, strings only, registrable, and never a sensitive site.
 */
export function siteDomainsOf(merchant) {
  const own = String(merchant.domain || '').toLowerCase();
  const out = [];
  for (const x of Array.isArray(merchant.siteDomains) ? merchant.siteDomains : []) {
    if (typeof x !== 'string') continue;
    const d = etld1(x.trim());   // a host (www.cursor.com) counts as its registrable domain
    if (d === own || out.includes(d) || !registrable(d) || sensitiveReason(d)) continue;
    out.push(d); if (out.length === 5) break;
  }
  return out;
}

// goal: 'find'   — the scan: walk to the offer and PAUSE (accept_offer becomes offer_found; nothing is accepted)
//       'hunt'   — accept the offer and reach the confirmation
//       'verify' — read the billing page after the run
export default async (req) => handle(req, async (body) => {
  const { snapshot } = body;
  if (!body.merchant || !body.merchant.domain) throw new Error('merchant.domain required');
  if (!snapshot || !Array.isArray(snapshot.elements)) throw new Error('snapshot.elements required');
  const step = Number(body.step || 0), maxSteps = Math.min(Number(body.maxSteps || 25), 40);
  const history = Array.isArray(body.history) ? body.history.filter((h) => h && typeof h === 'object') : [];
  const goal = ['verify', 'find', 'hunt'].includes(body.goal) ? body.goal : 'hunt';
  const priorPath = Array.isArray(body.priorPath) ? body.priorPath.slice(0, 20).map((p) => String(p).slice(0, 200)) : null;
  // Only the checked site set reaches the model's prompt and the navigate rule, never the client's raw list.
  const { siteDomains: _unchecked, ...rest } = body.merchant;
  const siteDomains = siteDomainsOf(body.merchant);
  const merchant = siteDomains.length ? { ...rest, siteDomains } : rest;
  // Backstop for the extension's own check: a bank, government, health or similar site or page is never
  // sent to the model and never acted on. The answer is always "back out".
  const never = sensitiveReason(merchant.domain) || sensitiveReason(hostOf(snapshot.url)) || financialPageReason(snapshot.text);
  if (never) {
    const action = { type: 'back_out', id: null, text: null, value: null, url: null, direction: null, reason: 'sensitive site: ' + never, offer: null, outcome: null, details: null };
    return { brain: BRAIN, model: 'none (refused before the model)', provider: 'none', proposed: action, decision: { state: 'ambiguous', reasoning: 'Refused: ' + never, action }, guardrails: ['never-touch: ' + never], usage: null };
  }
  const { _usage, _provider, _model, ...proposed } = await decide({ merchant, goal, step, maxSteps, history, snapshot, priorPath });
  const { decision, notes } = applyGuardrails({ decision: proposed, snapshot, history, merchantDomain: [merchant.domain, ...siteDomains], step, maxSteps, goal });
  return { brain: BRAIN, model: _model || describeBrain(), provider: _provider, proposed: proposed.action, decision, guardrails: notes, usage: _usage || null };
});
export const config = { path: '/api/agent-step' };

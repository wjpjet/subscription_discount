// Cloudflare Worker entry. Serves the same /api/* handlers Netlify runs, unchanged.
//
// Why Workers: every request here spends its whole life awaiting the model, and Workers bills CPU
// only — waiting on fetch() is not billed — with no wall-clock limit for HTTP-triggered Workers.
// See HISTORY.md for the measured numbers behind that choice.
//
// The handlers are Web-standard `(Request) => Response`, which is what both platforms speak, so
// nothing in netlify/functions/ needed rewriting. Only two things differ:
//   1. Secrets arrive as the `env` argument, not process.env. We copy them across once per isolate.
//   2. Module scope runs before `env` exists, so llm.mjs re-reads its config via refreshConfig().
import { refreshConfig } from '../netlify/functions/lib/llm.mjs';
import discover from '../netlify/functions/discover.mjs';
import classify from '../netlify/functions/classify.mjs';
import agentStep from '../netlify/functions/agent-step.mjs';
import checkout from '../netlify/functions/checkout.mjs';
import checkoutStatus from '../netlify/functions/checkout-status.mjs';
import settle from '../netlify/functions/settle.mjs';
import timeoutProbe from '../netlify/functions/timeout-probe.mjs';

const routes = {
  '/api/discover': discover,
  '/api/classify': classify,
  '/api/agent-step': agentStep,
  '/api/checkout': checkout,
  '/api/checkout-status': checkoutStatus,
  '/api/settle': settle,
  '/api/timeout-probe': timeoutProbe,
};

let bound = false;
/** Copy Worker bindings into process.env once, then let llm.mjs re-read its config from them. */
function bindEnv(env) {
  if (bound) return;
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') process.env[k] = v;
  refreshConfig();
  bound = true;
}

export default {
  async fetch(request, env, ctx) {
    bindEnv(env);
    const { pathname } = new URL(request.url);
    const handler = routes[pathname];
    if (handler) return handler(request, ctx);
    // Anything that is not an API route falls through to the static assets bound to this Worker.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};

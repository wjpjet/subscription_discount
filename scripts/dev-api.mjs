// Local API server for the Netlify Functions (no netlify-cli needed): `npm run api:dev` → http://127.0.0.1:8787
import http from 'node:http';
const routes = {
  '/api/discover': () => import('../netlify/functions/discover.mjs'),
  '/api/classify': () => import('../netlify/functions/classify.mjs'),
  '/api/agent-step': () => import('../netlify/functions/agent-step.mjs'),
  '/api/checkout': () => import('../netlify/functions/checkout.mjs'),
  '/api/checkout-status': () => import('../netlify/functions/checkout-status.mjs'),
  '/api/settle': () => import('../netlify/functions/settle.mjs'),
};
const PORT = Number(process.env.PORT || 8787);
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const load = routes[url.pathname];
  if (!load) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"not found"}'); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  const headers = {}; for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
  const request = new Request('http://localhost' + req.url, { method: req.method, headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined });
  const mod = await load();
  const response = await mod.default(request, {});
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, '127.0.0.1', () => console.log(`walkaway api → http://127.0.0.1:${PORT}  (brain: ${process.env.WALKAWAY_BRAIN || ((process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY) ? 'llm' : 'mock')})`));

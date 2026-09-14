// Standalone API server for the same functions Netlify runs. Local: `npm run api:dev` → http://127.0.0.1:8787
// Production alternative (no 10s limit): HOST=0.0.0.0 PORT=8787 node --env-file=.env scripts/api-server.mjs
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
const HOST = process.env.HOST || '127.0.0.1';
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
}).listen(PORT, HOST, () => console.log(`walkaway api → http://${HOST}:${PORT}  (brain: ${process.env.WALKAWAY_BRAIN || ((process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY) ? 'llm' : 'mock')})`));

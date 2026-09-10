const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, x-walkaway-key', 'Access-Control-Max-Age': '86400' };
export function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } }); }
const buckets = new Map();
function rateLimited(ip, limit = 90, windowMs = 60_000) {
  const now = Date.now(); const b = buckets.get(ip) || { n: 0, t: now };
  if (now - b.t > windowMs) { b.n = 0; b.t = now; }
  b.n++; buckets.set(ip, b); return b.n > limit;
}
/** Wrap a handler: CORS, POST-only, optional shared key, per-IP rate limit, JSON errors. */
export async function handle(req, fn) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const key = process.env.WALKAWAY_CLIENT_KEY;
  if (key && req.headers.get('x-walkaway-key') !== key) return json({ error: 'unauthorized' }, 401);
  const ip = req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || 'local';
  if (rateLimited(ip)) return json({ error: 'rate limited' }, 429);
  let body; try { body = await req.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }
  try { return json(await fn(body)); } catch (e) { console.error(e); return json({ error: String((e && e.message) || e) }, 500); }
}

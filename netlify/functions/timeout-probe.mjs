// Diagnostic: how long may a synchronous function actually run on THIS site?
// Netlify's docs say 60s and is not configurable, but support threads in Sept 2026 still show
// sites cut off at 10s, so the only trustworthy answer is measured, not read.
// Disabled unless ALLOW_TIMEOUT_PROBE=1 is set in the site's environment variables. Turn it off again
// when you are done: it does nothing but hold a function open.
import { handle } from './lib/http.mjs';

export default async (req) => handle(req, async (body) => {
  if (process.env.ALLOW_TIMEOUT_PROBE !== '1') throw new Error('probe disabled (set ALLOW_TIMEOUT_PROBE=1 to enable)');
  const ms = Math.min(Math.max(Number(body.ms || 1000), 0), 120_000);
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, ms));
  return { requestedMs: ms, actualMs: Date.now() - t0 };
});
export const config = { path: '/api/timeout-probe' };

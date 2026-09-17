// Find the real synchronous-function time limit of a deployed site.
//   node scripts/probe-timeout.mjs https://your-site.netlify.app
// Needs ALLOW_TIMEOUT_PROBE=1 in that site's environment variables (remove it afterwards).
const base = (process.argv[2] || process.env.SITE_URL || '').replace(/\/$/, '');
if (!base) { console.error('usage: node scripts/probe-timeout.mjs https://your-site.netlify.app'); process.exit(1); }

const STEPS = [2000, 5000, 9000, 11000, 15000, 20000, 26000, 30000, 45000, 55000];
console.log(`probing ${base}/api/timeout-probe\n`);
console.log('requested   result');
let lastOk = 0, firstFail = null;
for (const ms of STEPS) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/api/timeout-probe`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ms }),
      signal: AbortSignal.timeout(ms + 30_000),
    });
    const text = await res.text();
    const took = Date.now() - t0;
    let j = null; try { j = JSON.parse(text); } catch {}
    if (res.ok && j && !j.error) { lastOk = ms; console.log(`${String(ms / 1000 + 's').padEnd(11)} ok        (round trip ${(took / 1000).toFixed(1)}s)`); }
    else { firstFail ??= ms; console.log(`${String(ms / 1000 + 's').padEnd(11)} HTTP ${res.status}  after ${(took / 1000).toFixed(1)}s  ${(j && j.error) || text.slice(0, 120)}`); }
  } catch (e) {
    firstFail ??= ms;
    console.log(`${String(ms / 1000 + 's').padEnd(11)} failed    after ${((Date.now() - t0) / 1000).toFixed(1)}s  ${e.message}`);
  }
  if (firstFail && ms > firstFail) break;
}
console.log(`\nlongest call that completed: ${lastOk / 1000}s`);
if (firstFail) console.log(`first call that did not: ${firstFail / 1000}s  → your real ceiling is between those two`);
else console.log('nothing failed up to 55s — the documented 60s limit is what you have');

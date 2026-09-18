// How long does one backend call actually take? Answers "will a 10-second function timeout bite us?"
//   npm run latency                         (12 scenarios, real brain from .env)
//   node scripts/latency.mjs --limit=25 --concurrency=1 --model=gemini-3.8-flash --thinking=low
//   node scripts/latency.mjs --provider=openai --openai-model=<id> --openai-base=https://...
// Prints p50/p90/p95/p99/max per endpoint and the share of calls over each timeout budget.
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm'; import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { hunt, classifyPage, sleep, loginTestbed, timings } from './lib/driver.mjs';
import { serveTestbed } from './lib/testbed-server.mjs';
import { preflight } from './lib/preflight.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true]; }));
const PORT = Number(process.env.SUITE_PORT || 8793), BASE = `http://127.0.0.1:${PORT}`;   // SUITE_PORT lets two runs coexist
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
process.env.WALKAWAY_RATE_LIMIT = '0';
if (args.model) process.env.GEMINI_MODEL = String(args.model);
if (args['fast-model']) process.env.GEMINI_MODEL_FAST = String(args['fast-model']);
if (args.thinking) process.env.GEMINI_THINKING_STEP = String(args.thinking);
if (args['fast-thinking']) process.env.GEMINI_THINKING_FAST = String(args['fast-thinking']);
if (args.provider) process.env.AI_PROVIDER = String(args.provider);
if (args['openai-model']) { process.env.OPENAI_MODEL = String(args['openai-model']); process.env.AI_PROVIDER ||= 'openai'; }
if (args['openai-fast-model']) process.env.OPENAI_MODEL_FAST = String(args['openai-fast-model']);
if (args['openai-base']) process.env.OPENAI_BASE_URL = String(args['openai-base']);
if (args['openai-thinking']) process.env.OPENAI_THINKING_STEP = String(args['openai-thinking']);
const CONC = Number(args.concurrency || 1), MAX_STEPS = Number(args.maxSteps || 20);

const ctx = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'testbed/scenarios.js'), 'utf8'), ctx);
let scenarios = ctx.window.WALKAWAY_SCENARIOS;
if (args.only) { const ids = new Set(String(args.only).split(',')); scenarios = scenarios.filter((s) => ids.has(s.id)); }
scenarios = scenarios.slice(0, Number(args.limit || 12));

const pct = (xs, p) => xs.length ? xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)] : 0;
const fmt = (ms) => (ms / 1000).toFixed(2) + 's';

async function runOne(browser, s) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage(); await page.setViewport({ width: 1100, height: 800 });
  const merchant = { name: 'Streamly (' + s.id + ')', domain: '127.0.0.1', accountUrl: `${BASE}/settings/subscription` };
  const acc = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, calls: 0 };
  try {
    await loginTestbed(page, BASE);
    await page.goto(`${BASE}/?scenario=${s.id}`, { waitUntil: 'load' }); await sleep(150);
    await classifyPage(page, merchant, acc);
    await page.goto(s.start === 'home' ? `${BASE}/` : merchant.accountUrl, { waitUntil: 'load' });
    await hunt(page, merchant, MAX_STEPS, acc);
  } catch (e) { process.stdout.write(`\n  ${s.id} errored: ${e.message}\n`); }
  finally { await context.close().catch(() => {}); }
}

(async () => {
  const srv = await serveTestbed(PORT);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    await preflight();
    process.stdout.write(`measuring ${scenarios.length} scenarios, concurrency ${CONC}, ${(await import('../netlify/functions/lib/llm.mjs')).describeBrain()}\n`);
    const queue = [...scenarios];
    await Promise.all(Array.from({ length: CONC }, async () => {
      while (queue.length) { const s = queue.shift(); await runOne(browser, s); process.stdout.write('.'); }
    }));
    process.stdout.write('\n\n');

    const byName = {};
    for (const t of timings) (byName[t.name] ||= []).push(t.ms);
    const all = timings.map((t) => t.ms).sort((a, b) => a - b);
    const rows = Object.entries(byName).map(([name, xs]) => { xs.sort((a, b) => a - b); return { name, xs }; });
    rows.push({ name: 'ALL', xs: all });

    console.log('endpoint        calls    p50     p90     p95     p99     max');
    for (const { name, xs } of rows) {
      console.log(`${name.padEnd(14)} ${String(xs.length).padStart(5)}  ${fmt(pct(xs, 50)).padStart(6)}  ${fmt(pct(xs, 90)).padStart(6)}  ${fmt(pct(xs, 95)).padStart(6)}  ${fmt(pct(xs, 99)).padStart(6)}  ${fmt(xs[xs.length - 1] || 0).padStart(6)}`);
    }
    console.log('\ntimeout budget   calls over   share');
    for (const budget of [6000, 10000, 15000, 26000]) {
      const over = all.filter((ms) => ms > budget).length;
      console.log(`${(budget / 1000 + 's').padEnd(15)} ${String(over).padStart(10)}   ${(100 * over / (all.length || 1)).toFixed(1)}%`);
    }
    const out = path.join(ROOT, 'results', `latency-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), brain: (await import('../netlify/functions/lib/llm.mjs')).describeBrain(), concurrency: CONC, timings }, null, 2));
    console.log(`\nraw → ${path.relative(ROOT, out)}`);
  } finally { await browser.close().catch(() => {}); srv.close(); }
})();

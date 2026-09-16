// Measure real prompt sizes on the testbed pages (≈ 4 chars/token) to ground cost estimates.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { snapshotPage } from '../shared/page-scripts.js';
import { renderSnapshot } from '../netlify/functions/lib/brain.mjs';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); const TB = path.join(ROOT, 'testbed');
const PORT = 8791, BASE = `http://127.0.0.1:${PORT}`; const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = http.createServer((req, res) => { let f = path.join(TB, new URL(req.url, BASE).pathname); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(TB, 'index.html'); res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' }); fs.createReadStream(f).pipe(res); }).listen(PORT);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage(); await page.setViewport({ width: 1100, height: 800 });
const { loginTestbed } = await import('./lib/driver.mjs'); await loginTestbed(page, BASE, 'x@y.com');
for (const p of ['/', '/settings/subscription', '/cancel', '/cancel/offer', '/cancel/confirm']) {
  await page.goto(`${BASE}${p}`, { waitUntil: 'load' });
  const snap = await page.evaluate(snapshotPage, {});
  const rendered = renderSnapshot(snap);
  console.log(`${p.padEnd(24)} elements=${String(snap.elements.length).padStart(3)}  text=${String(snap.text.length).padStart(5)} chars  prompt=${String(rendered.length).padStart(5)} chars ≈ ${Math.round(rendered.length / 4)} tokens`);
}
await browser.close(); srv.close();

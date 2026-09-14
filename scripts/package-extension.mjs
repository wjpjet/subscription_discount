// Build + zip the extension and drop it into landing/downloads/ for the install page. `npm run package:extension`
import { execSync } from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ext = path.join(ROOT, 'extension');
execSync('npm run -s build && npm run -s zip', { cwd: ext, stdio: 'inherit' });
const out = path.join(ext, '.output');
const zip = fs.readdirSync(out).filter((f) => /^walkaway-extension-.*-chrome\.zip$/.test(f) || /-chrome\.zip$/.test(f)).map((f) => path.join(out, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
if (!zip) throw new Error('no zip produced in extension/.output');
const dest = path.join(ROOT, 'landing', 'downloads'); fs.mkdirSync(dest, { recursive: true });
fs.copyFileSync(zip, path.join(dest, 'walkaway-extension.zip'));
console.log(`packaged → landing/downloads/walkaway-extension.zip (${Math.round(fs.statSync(zip).size / 1024)} KB, from ${path.basename(zip)})`);

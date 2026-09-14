import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const TB = path.join(ROOT, 'testbed');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
export function serveTestbed(port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let f = path.join(TB, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(TB, 'index.html');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
    }).listen(port, '127.0.0.1', () => resolve(srv));
  });
}

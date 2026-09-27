// The real tabs.ts and hunt.ts, bundled for Node against a fake Chrome (scripts/harness/hunt): pause and release,
// accept only in a provably-owned tab on the unchanged offer screen, stale ids, no-effect clicks, error pages, the
// per-site lock, never-explore hosts.   npm run test:hunt
import { build } from '../extension/node_modules/esbuild/lib/main.js';
const here = new URL('./harness/hunt/', import.meta.url).pathname;
await build({ entryPoints: [here + 'entry.ts'], bundle: true, platform: 'node', format: 'esm', outfile: here + '.build/out.mjs', logLevel: 'warning',
  plugins: [{ name: 'imports', setup(b) { b.onResolve({ filter: /^#imports$/ }, () => ({ path: here + 'mock-imports.mjs' })); } }] });
await import('./harness/hunt/test.mjs');

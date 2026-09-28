// The real scan.ts (probe, hops, statuses, duplicates) and discovery.ts, bundled for Node with browser, tab, API and
// trace stubs (scripts/harness/scan/stubs), on made-up pages classified by the real mock classifier.   npm run test:scan
import { build } from '../extension/node_modules/esbuild/lib/main.js';
const H = new URL('./harness/scan/', import.meta.url).pathname, SRC = new URL('../extension/src/', import.meta.url).pathname;
const stub = (map) => ({ name: 'stub', setup(b) {
  b.onResolve({ filter: /.*/ }, (a) => {
    if (a.path === '#imports') return { path: `${H}stubs/imports.js` };
    if (!a.importer.startsWith(SRC)) return null;
    for (const [re, file] of map) if (re.test(a.path)) return { path: `${H}stubs/${file}` };
    return null;
  });
} });
await build({ entryPoints: [`${SRC}scan.ts`], bundle: true, format: 'esm', platform: 'node', outfile: `${H}.build/scan.mjs`, logLevel: 'warning',
  plugins: [stub([[/^\.\/tabs$/, 'tabs.js'], [/^\.\/hunt$/, 'hunt.js'], [/^\.\/trace$/, 'trace.js'], [/^\.\/api$/, 'api.js'], [/^\.\/discovery$/, 'discovery.js'], [/brain-mock\.js$/, 'brain-mock.js']])] });
await build({ entryPoints: [`${SRC}discovery.ts`], bundle: true, format: 'esm', platform: 'node', outfile: `${H}.build/discovery.mjs`, logLevel: 'warning',
  plugins: [stub([[/^\.\/trace$/, 'trace.js'], [/^\.\/api$/, 'api.js']])] });
await import('./harness/scan/check.mjs');

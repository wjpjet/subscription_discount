import { defineConfig } from 'wxt';

// WXT_E2E=1 builds a test-only variant for scripts/e2e-extension.mjs: the testbed hosts are granted at
// install (a headless browser cannot click Chrome's permission prompt) and the output goes to a separate
// folder, so the copy loaded in your own Chrome is never overwritten. Never ship an E2E build.
const E2E = !!process.env.WXT_E2E;

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  outDir: E2E ? '.output-e2e' : '.output',
  vite: () => ({ server: { fs: { allow: ['..'] } } }),
  manifest: {
    name: E2E ? 'Walkaway (E2E test build)' : 'Walkaway',
    description: "Finds the subscription services you're signed into and gets you their loyalty discounts — without cancelling anything.",
    permissions: ['cookies', 'scripting', 'sidePanel', 'storage'],   // no `tabs`: we never read tab URLs/titles without host permission
    // Requested at first Scan (contextual), never at install.
    optional_host_permissions: ['<all_urls>'],
    // E2E only: grant at install whatever the panel will ask for, so no permission prompt is needed.
    ...(E2E ? { host_permissions: ['<all_urls>'] } : {}),
    action: { default_title: 'Walkaway' },
  },
});

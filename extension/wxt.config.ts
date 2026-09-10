import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({ server: { fs: { allow: ['..'] } } }),
  manifest: {
    name: 'Walkaway',
    description: "Finds the subscription services you're signed into and gets you their loyalty discounts — without cancelling anything.",
    permissions: ['cookies', 'tabs', 'scripting', 'sidePanel', 'storage'],
    // Requested at first Scan (contextual), never at install. Test mode requests only the test domain.
    optional_host_permissions: ['<all_urls>'],
    action: { default_title: 'Walkaway' },
  },
});

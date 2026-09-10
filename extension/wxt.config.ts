import { defineConfig } from 'wxt';
import { ORIGINS } from './src/playbooks';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Walkaway',
    description:
      "Finds the subscription services you're signed into and gets you their loyalty discounts — without cancelling anything.",
    permissions: ['cookies', 'tabs', 'scripting', 'sidePanel', 'storage'],
    // Requested at first Scan (contextual), not at install. No `history`, no <all_urls>.
    optional_host_permissions: ORIGINS,
    action: { default_title: 'Walkaway' },
  },
});

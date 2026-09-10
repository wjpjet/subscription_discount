import { defineBackground, browser } from '#imports';
export default defineBackground(() => {
  const sp = (browser as any).sidePanel;
  if (sp && typeof sp.setPanelBehavior === 'function') sp.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

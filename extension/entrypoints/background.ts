import { defineBackground, browser } from '#imports';
import { runScan } from '@/src/scan';

export default defineBackground(() => {
  // Clicking the toolbar icon opens the side panel.
  const sp = (browser as any).sidePanel;
  if (sp && typeof sp.setPanelBehavior === 'function') {
    sp.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }

  let running = false;
  browser.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (msg && msg.type === 'SCAN_START') {
      if (running) { sendResponse({ ok: false, reason: 'already_running' }); return; }
      running = true;
      runScan((progress) => send({ type: 'SCAN_PROGRESS', progress }))
        .then((result) => send({ type: 'SCAN_DONE', result }))
        .catch((e: any) => send({ type: 'SCAN_ERROR', error: String(e?.message || e) }))
        .finally(() => { running = false; });
      sendResponse({ ok: true });
    }
  });
});

function send(message: unknown) {
  // No listener (side panel closed) is fine — results are also persisted to storage.
  browser.runtime.sendMessage(message).catch(() => {});
}

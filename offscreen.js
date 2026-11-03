// Offscreen document: parses refresh responses with the full parser set (DOMParser
// is not available in the service worker) and returns the updated snapshot.
(function () {
  'use strict';

  const IkaDios = self.IkaDios;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'ikadios:offscreenParse') return undefined;
    try {
      let snapshot = IkaDios.schema.migrate(msg.snapshot) || IkaDios.schema.emptySnapshot();
      const ctx = {
        get snapshot() {
          return snapshot;
        },
        avatarId: msg.avatarId ?? null,
      };
      const apply = (patch) => {
        snapshot = typeof patch === 'function' ? patch(snapshot) || snapshot : IkaDios.util.deepMerge(snapshot, patch);
      };
      IkaDios.parsers.parseAjax(msg.actions, ctx, apply, msg.meta || {});
      sendResponse({ ok: true, snapshot });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
    return undefined;
  });
})();

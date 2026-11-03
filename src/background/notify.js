// Desktop notifications requested by game tabs. The same alert id is shown at
// most once per cooldown, even when several game tabs report it.
(function (root) {
  'use strict';

  const COOLDOWN_MS = 30 * 60 * 1000;
  const shown = new Map();

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'ikadios:notify') return undefined;
    const last = shown.get(msg.id) || 0;
    if (Date.now() - last < COOLDOWN_MS) {
      sendResponse({ ok: true, skipped: true });
      return undefined;
    }
    shown.set(msg.id, Date.now());
    const id = `ikadios:${msg.id}:${Date.now()}`;
    const basic = {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: String(msg.title || 'IkaDios').slice(0, 100),
      message: String(msg.message || '').slice(0, 300),
    };
    // Firefox rejects priority / requireInteraction: retry with the basic fields
    const extended = { ...basic, priority: msg.severity === 'critical' ? 2 : 0, requireInteraction: msg.severity === 'critical' };
    try {
      Promise.resolve(chrome.notifications.create(id, extended)).catch(() => chrome.notifications.create(id, basic));
    } catch {
      chrome.notifications.create(id, basic);
    }
    sendResponse({ ok: true });
    return undefined;
  });

  // Clicking a notification brings the game tab to the front
  chrome.notifications.onClicked.addListener(async (notificationId) => {
    if (!notificationId.startsWith('ikadios:')) return;
    const [tab] = await chrome.tabs.query({ url: 'https://*.ikariam.gameforge.com/*' });
    if (tab) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    chrome.notifications.clear(notificationId);
  });
})(self);

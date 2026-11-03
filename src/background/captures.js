// Debug captures (raw game responses) in the worker's IndexedDB. Each capture is
// its own record, so adding one never rewrites the others and, unlike
// chrome.storage, never broadcasts change events to every extension context.
// Content scripts and the options page reach it through runtime messages.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { warn } = IkaDios.util;

  const STORE = 'captures';
  const MAX_ENTRIES = 600;
  // Pre-IndexedDB storage of the same data (one big chrome.storage key)
  const LEGACY_KEY = 'debugCaptures';

  const { db, request, done } = IkaDios.idb;

  async function count() {
    const tx = (await db()).transaction(STORE, 'readonly');
    return request(tx.objectStore(STORE).count());
  }

  // Adds entries and drops the oldest beyond MAX_ENTRIES
  async function add(...entries) {
    const tx = (await db()).transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const entry of entries) store.add(entry);
    const total = await request(store.count());
    let excess = total - MAX_ENTRIES;
    if (excess > 0) {
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || excess <= 0) return;
        cursor.delete();
        excess -= 1;
        cursor.continue();
      };
    }
    await done(tx);
  }

  async function list() {
    const tx = (await db()).transaction(STORE, 'readonly');
    return request(tx.objectStore(STORE).getAll());
  }

  async function clear() {
    const tx = (await db()).transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await done(tx);
  }

  // One-time move of the old storage key, which slowed the browser down
  async function migrateLegacy() {
    const legacy = (await chrome.storage.local.get(LEGACY_KEY))[LEGACY_KEY];
    if (!legacy) return;
    try {
      if (Array.isArray(legacy) && legacy.length) await add(...legacy.slice(-MAX_ENTRIES));
    } catch (err) {
      warn('capture migration failed', err);
    }
    await chrome.storage.local.remove(LEGACY_KEY);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const handlers = {
      'ikadios:captureAdd': () => add(msg.entry).then(() => ({ ok: true })),
      'ikadios:captureList': () => list().then((entries) => ({ ok: true, entries })),
      'ikadios:captureCount': () => count().then((n) => ({ ok: true, count: n })),
      'ikadios:captureClear': () => clear().then(() => ({ ok: true })),
    };
    const handler = handlers[msg?.type];
    if (!handler) return undefined;
    handler()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  });

  IkaDios.captures = { add, list, count, clear, migrateLegacy, MAX_ENTRIES };
})(self);

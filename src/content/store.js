// Per-account snapshot store backed by chrome.storage.local.
// Key: snap:<world>:<avatarId>. Writes are debounced; subscribers are notified
// synchronously after every in-memory update.
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});
  const { deepMerge, debounce, warn } = IkaDios.util;
  const { emptySnapshot, migrate } = IkaDios.schema;

  const SAVE_DEBOUNCE_MS = 1000;
  const KEY_LAST_ACCOUNT = 'lastAccount';

  // Writes from other contexts (the background refresh) are adopted; our own are ignored
  const WRITER = `tab:${Math.random().toString(36).slice(2)}`;

  let key = null;
  let snapshot = null;
  const subscribers = new Set();

  function keyFor(world, avatarId) {
    return `snap:${world}:${avatarId ?? 'unknown'}`;
  }

  async function load(world, avatarId) {
    const nextKey = keyFor(world, avatarId);
    if (nextKey === key && snapshot) return snapshot;

    const stored = await chrome.storage.local.get(nextKey);
    let loaded = migrate(stored[nextKey]) || emptySnapshot({ world, avatarId });

    // Data captured before the avatar id was known is folded into the real account
    if (snapshot && key === keyFor(world, null) && avatarId) {
      loaded = deepMerge(loaded, snapshot);
      chrome.storage.local.remove(key);
    }

    key = nextKey;
    snapshot = loaded;
    snapshot.account.world = world;
    if (avatarId) snapshot.account.avatarId = avatarId;
    await chrome.storage.local.set({ [KEY_LAST_ACCOUNT]: { key, world, avatarId, seenAt: Date.now() } });
    notify();
    return snapshot;
  }

  const persist = debounce(async () => {
    if (!key || !snapshot || !IkaDios.util.extensionAlive()) return;
    try {
      await chrome.storage.local.set({ [key]: { ...snapshot, _writer: WRITER } });
    } catch (err) {
      warn('store: save failed', err);
    }
  }, SAVE_DEBOUNCE_MS);

  // `patch` is either a partial snapshot (deep-merged) or a function that
  // receives the current snapshot and returns the next one.
  function update(patch) {
    if (!snapshot) return;
    snapshot = typeof patch === 'function' ? patch(snapshot) || snapshot : deepMerge(snapshot, patch);
    persist();
    notify();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !key || !changes[key]) return;
    const next = changes[key].newValue;
    if (!next || next._writer === WRITER) return;
    snapshot = migrate(next);
    notify();
  });

  function get() {
    return snapshot;
  }

  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  function notify() {
    for (const fn of subscribers) {
      try {
        fn(snapshot);
      } catch (err) {
        warn('store subscriber failed', err);
      }
    }
  }

  // Debug captures live in the worker's IndexedDB (src/background/captures.js)
  function appendDebugCapture(entry) {
    if (!IkaDios.util.extensionAlive()) return Promise.resolve();
    return chrome.runtime.sendMessage({ type: 'ikadios:captureAdd', entry }).catch((err) => warn('debug capture failed', err));
  }

  IkaDios.store = { KEY_LAST_ACCOUNT, keyFor, load, update, get, subscribe, appendDebugCapture };
})(typeof self !== 'undefined' ? self : window);

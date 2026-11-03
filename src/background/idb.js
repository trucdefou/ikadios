// The worker's IndexedDB: large or fast-changing data that must not live in
// chrome.storage (every storage write is broadcast to all extension contexts).
// Stores: "captures" (debug captures, auto-increment) and "kv" (key/value blobs,
// e.g. the ika-map world cache).
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const DB_NAME = 'ikadios';
  const DB_VERSION = 2;

  let dbPromise = null;

  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('captures')) d.createObjectStore('captures', { keyPath: 'seq', autoIncrement: true });
          if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  function request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function done(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function kvGet(key) {
    const tx = (await db()).transaction('kv', 'readonly');
    return request(tx.objectStore('kv').get(key));
  }

  async function kvSet(key, value) {
    const tx = (await db()).transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    await done(tx);
  }

  IkaDios.idb = { db, request, done, kvGet, kvSet };
})(self);

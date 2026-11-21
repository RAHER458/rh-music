/* Bounded IndexedDB analysis cache for AI Mix Beta. */
(function () {
  'use strict';
  const DB_NAME = 'rh_ai_mix_beta';
  const STORE = 'analysis';
  const VERSION = 1;
  const MAX_ENTRIES = 80;
  let dbPromise = null;
  const memory = new Map();

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      if (!window.indexedDB) return resolve(null);
      const request = indexedDB.open(DB_NAME, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
    return dbPromise;
  }

  async function get(key) {
    if (memory.has(key)) return memory.get(key);
    const db = await open(); if (!db) return null;
    return new Promise((resolve) => {
      try {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  }

  async function put(key, value) {
    memory.set(key, value);
    const db = await open(); if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ key, ...value, at: Date.now() });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (_) { resolve(false); }
    });
  }

  async function prune() {
    const db = await open(); if (!db) return;
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const countReq = store.count();
      countReq.onsuccess = () => {
        const excess = countReq.result - MAX_ENTRIES;
        if (excess <= 0) return;
        const cursor = store.openCursor();
        let removed = 0;
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c || removed >= excess) return;
          c.delete(); removed += 1; c.continue();
        };
      };
    } catch (_) { /* best effort */ }
  }

  async function stats() {
    const db = await open();
    if (!db) return { backend: 'memory', entries: memory.size, limit: MAX_ENTRIES };
    return new Promise((resolve) => {
      try {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
        req.onsuccess = () => resolve({ backend: 'indexeddb', entries: req.result, limit: MAX_ENTRIES });
        req.onerror = () => resolve({ backend: 'indexeddb', entries: null, limit: MAX_ENTRIES });
      } catch (_) { resolve({ backend: 'memory', entries: memory.size, limit: MAX_ENTRIES }); }
    });
  }

  window.RH_AI_MIX_BETA_CACHE = { get, put, prune, stats, version: VERSION };
})();

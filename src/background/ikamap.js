// World data from the ika-map.com public API (islands, resources, every city with
// player, alliance, level and state). One request returns the whole world (~5 MB),
// cached in IndexedDB and refreshed at most every CACHE_HOURS, or on demand.
// Searches by player or alliance run locally on this data.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { warn, parseGameHost } = IkaDios.util;

  const API = 'https://api.ika-map.com';
  const CACHE_HOURS = 6;
  const FETCH_TIMEOUT_MS = 60000;

  // ika-map server ids by Ikariam country code (from ika-map.com globalFunctions.js)
  const SERVER_IDS = { cz: 11, en: 2, us: 42, pl: 31, gr: 16, fr: 15, hu: 18, ae: 41, tr: 40, es: 37, bg: 8 };

  function apiWorld(world) {
    const host = parseGameHost(`${world}.x`);
    const server = SERVER_IDS[host.lang];
    return server && host.server ? { server, world: host.server } : null;
  }

  // Compact island: [x, y, freeSlots, wonder, woodLevel, tradegood, tradegoodLevel, cities]
  // city: [playerName, cityName, playerId, level, state, allyTag]
  function compact(data) {
    const islands = [];
    for (const island of Object.values(data || {})) {
      const [x, y] = String(island.c).split(':').map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const cities = (island.d || []).map((c) => [c.pN, c.cN, c.pID, c.l, c.s || '', c.a || '']);
      islands.push([x, y, island.f ?? null, island.w ?? null, island.r ?? null, island.t ?? null, island.tL ?? null, cities]);
    }
    return islands;
  }

  async function download(target) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${API}/v2/world/coords/?server=${target.server}&world=${target.world}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`http-${res.status}`);
      const body = await res.json();
      if (!body?.ok) throw new Error('api-error');
      return compact(body.data);
    } finally {
      clearTimeout(timer);
    }
  }

  const inflight = new Map();

  async function getWorld(world, { force = false } = {}) {
    const target = apiWorld(world);
    if (!target) return { ok: false, error: 'unsupported' };
    const key = `ikamap:${world}`;
    const cached = await IkaDios.idb.kvGet(key);
    const fresh = cached && Date.now() - cached.fetchedAt < CACHE_HOURS * 3600 * 1000;
    if (cached && fresh && !force) return { ok: true, ...cached, cached: true };

    // One download at a time per world, shared by concurrent callers
    if (!inflight.has(key)) {
      inflight.set(
        key,
        download(target)
          .then(async (islands) => {
            const entry = { world, fetchedAt: Date.now(), islands };
            await IkaDios.idb.kvSet(key, entry);
            return { ok: true, ...entry, cached: false };
          })
          .catch((err) => {
            warn('ika-map download failed', err);
            // Stale data is better than no map
            return cached ? { ok: true, ...cached, cached: true, stale: true } : { ok: false, error: String(err) };
          })
          .finally(() => inflight.delete(key))
      );
    }
    return inflight.get(key);
  }

  // Island names and ids seen on the game's world map, keyed "x:y": {id, name, wonderLevel}
  async function mergeIslandNames(world, islands) {
    const key = `islandNames:${world}`;
    const current = (await IkaDios.idb.kvGet(key)) || {};
    await IkaDios.idb.kvSet(key, { ...current, ...islands });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'ikadios:islandNames') {
      mergeIslandNames(msg.world, msg.islands || {}).then(() => sendResponse({ ok: true }), (err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    if (msg?.type !== 'ikadios:worldMap') return undefined;
    Promise.all([getWorld(msg.world, { force: !!msg.force }), IkaDios.idb.kvGet(`islandNames:${msg.world}`)]).then(([res, names]) =>
      sendResponse({ ...res, islandNames: names || {} })
    );
    return true;
  });

  IkaDios.ikamap = { getWorld, apiWorld, compact, SERVER_IDS };
})(self);

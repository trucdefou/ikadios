// World data (ika-map.com, through the worker) kept in memory for the page and
// shared by the map and islands tabs, so the ~3 MB payload is requested once.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;

  let cache = null; // { world, islands, byCoord, names, fetchedAt }
  let pending = null;
  const listeners = new Set();

  function toIsland(row) {
    const [x, y, free, wonder, wood, tradegood, tradegoodLevel, cities] = row;
    return {
      x,
      y,
      free,
      wonder,
      wood,
      tradegood,
      tradegoodLevel,
      cities: cities.map(([player, name, playerId, level, st, ally]) => ({ player, name, playerId: String(playerId), level, state: st, ally })),
    };
  }

  async function load(world, { force = false } = {}) {
    if (!world) throw new Error('no-world');
    if (cache && cache.world === world && !force) return cache;
    if (pending) return pending;
    pending = chrome.runtime
      .sendMessage({ type: 'ikadios:worldMap', world, force })
      .then((res) => {
        if (!res?.ok) throw new Error(res?.error || 'error');
        const islands = res.islands.map(toIsland);
        cache = {
          world,
          islands,
          byCoord: new Map(islands.map((i) => [`${i.x}:${i.y}`, i])),
          names: res.islandNames || {},
          fetchedAt: res.fetchedAt,
          stale: !!res.stale,
        };
        for (const fn of listeners) fn(cache);
        return cache;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  }

  function current() {
    return cache;
  }

  function onLoad(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  IkaDios.worldData = { load, current, onLoad, toIsland };
})(typeof self !== 'undefined' ? self : window);

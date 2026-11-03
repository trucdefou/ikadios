// DOM-free parsers for military movements, island data and the world map.
// - Movements: JSON in the military advisor view (viewScriptParams.militaryAndFleetMovements)
// - Island: updateGlobalData.backgroundData while the island is the background view
// - World map: action=WorldMap&function=getJSONArea (island names; stored in the worker)
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});
  const { toNumber } = IkaDios.util;
  const { registerView, registerAction } = IkaDios.parsers;

  // ---------- Military movements ----------

  const CARGO_CLASS = /resource_icon (\w+)/;
  const CARGO_RESOURCE = { wood: 'wood', wine: 'wine', marble: 'marble', glass: 'glass', crystal: 'glass', sulfur: 'sulfur' };

  function endpoint(p) {
    if (!p) return null;
    return {
      player: p.avatarName || '',
      playerId: p.avatarId != null ? String(p.avatarId) : null,
      cityId: p.cityId != null ? String(p.cityId) : null,
      islandId: p.islandId != null ? String(p.islandId) : null,
      name: p.name || '',
    };
  }

  function parseMovement(m) {
    const ev = m.event || {};
    return {
      id: String(ev.id ?? `${m.eventTime}-${m.origin?.cityId}-${m.target?.cityId}`),
      // transport, plunder, deployarmy, deployfleet, occupy, blockade, defend, ...
      mission: ev.missionIconClass || null,
      // 1 loading, 2 under way, 3 arrived / fighting (game codes)
      state: toNumber(ev.missionState, null),
      text: ev.missionText || '',
      returning: !!(ev.isReturning || ev.isFleetReturning),
      inFight: !!ev.isInFight,
      combatant: !!ev.isCombatant,
      arrivesAt: m.eventTime ? m.eventTime * 1000 : null,
      hostile: !!m.isHostile,
      own: !!m.isOwnArmyOrFleet,
      sameAlliance: !!m.isSameAlliance,
      origin: endpoint(m.origin),
      target: endpoint(m.target),
      ships: toNumber(m.fleet?.amount, 0),
      units: toNumber(m.army?.amount, 0),
      cargo: (m.resources || [])
        .map((r) => ({ resource: CARGO_RESOURCE[CARGO_CLASS.exec(r.cssClass || '')?.[1]] || null, amount: toNumber(r.amount, 0) }))
        .filter((r) => r.resource),
    };
  }

  // Timing kept across captures, for the map position (src/shared/fleet-track.js):
  // firstSeenAt; legSeenAt (first seen on the current leg, out or back);
  // departAt, exact when the movement was seen loading (state 1: its eventTime is
  // the end of loading, which is the departure)
  function track(m, prev, now) {
    const sameLeg = prev && prev.returning === m.returning;
    const out = { ...m, firstSeenAt: prev?.firstSeenAt || now, legSeenAt: sameLeg ? prev.legSeenAt || prev.firstSeenAt || now : now };
    if (m.state === 1) out.departAt = m.arrivesAt;
    else if (sameLeg && prev.state === 1 && prev.arrivesAt) out.departAt = prev.arrivesAt;
    else if (sameLeg && prev.departAt) out.departAt = prev.departAt;
    return out;
  }

  function movementsFrom(extra) {
    for (const item of extra || []) {
      const list = item?.viewScriptParams?.militaryAndFleetMovements;
      if (Array.isArray(list)) return list;
    }
    return null;
  }

  registerView('militaryAdvisor', ({ extra }) => {
    const list = movementsFrom(extra);
    if (!list) return null;
    const now = Date.now();
    // Function patch: the list is replaced, keeping when each movement was first seen
    // (used to estimate positions on the map)
    return (snapshot) => {
      const previous = new Map((snapshot.military?.movements || []).map((m) => [m.id, m]));
      const movements = list.map(parseMovement).map((m) => track(m, previous.get(m.id), now));
      return {
        ...snapshot,
        military: {
          ...(snapshot.military || {}),
          movements,
          hostileCount: movements.filter((m) => m.hostile).length,
          updatedAt: now,
        },
      };
    };
  });

  // ---------- Island (background view) ----------

  function parseIsland(bg) {
    if (!bg || !Array.isArray(bg.cities) || bg.islandId == null) return null;
    const id = String(bg.islandId);
    const cities = bg.cities
      .filter((c) => c && c.type === 'city')
      .map((c) => ({
        id: String(c.id),
        name: c.name,
        level: toNumber(c.level, null),
        ownerId: c.ownerId != null ? String(c.ownerId) : null,
        ownerName: c.ownerName || '',
        allyId: c.ownerAllyId != null ? String(c.ownerAllyId) : null,
        allyTag: c.ownerAllyTag || '',
        // '' active, vacation, inactive (game state codes)
        state: c.state || '',
      }));
    const island = {
      id,
      name: bg.islandName || bg.name || '',
      x: toNumber(bg.islandXCoord ?? bg.xCoord, null),
      y: toNumber(bg.islandYCoord ?? bg.yCoord, null),
      tradegood: toNumber(bg.tradegood, null),
      tradegoodLevel: toNumber(bg.tradegoodLevel, null),
      woodLevel: toNumber(bg.resourceLevel, null),
      wonder: toNumber(bg.wonder, null),
      wonderLevel: toNumber(bg.wonderLevel, null),
      wonderName: bg.wonderName || '',
      // End of a running upgrade (seconds in the game data), 0 when idle
      woodUpgradeEndsAt: toNumber(bg.resourceEndUpgradeTime, 0) * 1000 || null,
      tradegoodUpgradeEndsAt: toNumber(bg.tradegoodEndUpgradeTime, 0) * 1000 || null,
      wonderUpgradeEndsAt: toNumber(bg.wonderEndUpgradeTime, 0) * 1000 || null,
      cities,
      updatedAt: Date.now(),
    };
    return (snapshot) => ({ ...snapshot, islands: { ...(snapshot.islands || {}), [id]: island } });
  }

  registerAction('updateGlobalData', (payload) => parseIsland(payload?.backgroundData));

  // ---------- World map (JSON) ----------

  // getJSONArea data[x][y] = [islandId, name, tradegood, wonder, ?, wonderLevel, woodLevel, cityCount, ...]
  function worldMapIslands(data) {
    const out = {};
    for (const [x, column] of Object.entries(data || {})) {
      for (const [y, v] of Object.entries(column || {})) {
        if (!Array.isArray(v)) continue;
        out[`${x}:${y}`] = { id: String(v[0]), name: v[1], wonderLevel: toNumber(v[5], null) };
      }
    }
    return out;
  }

  function isWorldMapResponse(meta) {
    return /action=WorldMap/.test(meta?.url || '') && /function=getJSONArea/.test(meta?.url || '');
  }

  IkaDios.parsers.world = { track, parseMovement, movementsFrom, parseIsland, worldMapIslands, isWorldMapResponse };
})(typeof self !== 'undefined' ? self : window);

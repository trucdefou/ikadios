// Parser for the city background data (buildings and their levels/upgrades).
// Source: ikariam.backgroundView.screen.data on full load, or
// updateGlobalData.backgroundData / updateBackgroundData on AJAX navigation.
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});
  const { toNumber } = IkaDios.util;
  const { registerAction, registerModel } = IkaDios.parsers;

  function isCityData(data) {
    return data && typeof data === 'object' && Array.isArray(data.position) && data.id !== undefined;
  }

  function isOwnCity(data, ctx) {
    const id = String(data.id);
    if (ctx.snapshot?.cities?.[id]) return true;
    return ctx.avatarId != null && String(data.ownerId) === String(ctx.avatarId);
  }

  function parseBuildings(positions) {
    const buildings = [];
    positions.forEach((slot, pos) => {
      if (!slot || typeof slot !== 'object') return;
      const raw = String(slot.building || '');
      // Empty slots are named "buildingGround <terrain>"; a building being upgraded
      // comes as "<type> constructionSite"
      if (!raw || raw.startsWith('buildingGround')) return;
      const tokens = raw.split(/\s+/);
      const inConstruction = tokens.includes('constructionSite');
      const type = tokens.find((t) => t !== 'constructionSite') || String(slot.buildingId || raw);
      const underConstruction = inConstruction || !!slot.isBusy;
      buildings.push({
        pos,
        type,
        level: toNumber(slot.level, 0),
        underConstruction,
        upgradeEndsAt: slot.completed ? toNumber(slot.completed) * 1000 : null,
      });
    });
    return buildings;
  }

  function parseCity(data, ctx) {
    if (!isCityData(data) || !isOwnCity(data, ctx)) return null;
    const id = String(data.id);
    return {
      // The player name is only sent with the city data (ownerName)
      account: data.ownerName ? { playerName: String(data.ownerName) } : undefined,
      cities: {
        [id]: {
          id,
          name: data.name,
          islandId: data.islandId != null ? String(data.islandId) : undefined,
          islandName: data.islandName,
          coords:
            data.islandXCoord != null ? { x: toNumber(data.islandXCoord), y: toNumber(data.islandYCoord) } : undefined,
          isCapital: data.isCapital != null ? !!data.isCapital : undefined,
          buildings: parseBuildings(data.position),
          buildingsUpdatedAt: Date.now(),
        },
      },
      viewsUpdatedAt: { [`${id}:city`]: Date.now() },
    };
  }

  registerModel((model, ctx) => (model.backgroundView === 'city' ? parseCity(model.backgroundData, ctx) : null));
  registerAction('updateGlobalData', (payload, ctx) => parseCity(payload?.backgroundData, ctx));
  registerAction('updateBackgroundData', (payload, ctx) => parseCity(payload, ctx));

  IkaDios.parsers.city = { parseCity, parseBuildings };
})(typeof self !== 'undefined' ? self : window);

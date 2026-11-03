// Upgrade cost of a building, from the "#buildingUpgrade" box that every building
// view includes ("Required for level N+1": resources and build time).
// Regex based (no DOM), so it also runs in the service worker refresh engine.
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});
  const { toNumber } = IkaDios.util;
  const { registerAction } = IkaDios.parsers;

  // Game CSS class of each resource in the cost list: our resource key
  const RESOURCE_CLASSES = { wood: 'wood', wine: 'wine', marble: 'marble', crystal: 'glass', glass: 'glass', sulfur: 'sulfur' };

  function parseUpgradeBox(html) {
    const start = html.indexOf('id="buildingUpgrade"');
    if (start < 0) return null;
    const box = html.slice(start, start + 12000);

    const upgradeHref = /href="\?action=UpgradeExistingBuilding&[^"]*"/.exec(box)?.[0] || '';
    const hrefParam = (name) => new RegExp(`[?&;]${name}=(\\d+)`).exec(upgradeHref.replace(/&amp;/g, '&'))?.[1] ?? null;
    const levelText = /<li class="showLevel">[\s\S]*?<\/div>\s*(\d+)/.exec(box)?.[1];

    const cost = {};
    const list = /<ul class="resources[^"]*">([\s\S]*?)<\/ul>/.exec(box)?.[1] || '';
    for (const m of list.matchAll(/<li class="(\w+)[^"]*"[^>]*title="[^"]*?:\s*([\d\s.,\u00a0\u202f]+)"/g)) {
      if (RESOURCE_CLASSES[m[1]]) cost[RESOURCE_CLASSES[m[1]]] = toNumber(m[2].trim());
    }
    const time = /<li class="time">[\s\S]*?<\/span>\s*([^<]+?)\s*</.exec(list)?.[1] || null;

    return {
      canUpgrade: !!upgradeHref,
      cityId: hrefParam('cityId'),
      position: hrefParam('position'),
      level: toNumber(hrefParam('level') ?? levelText, null),
      cost,
      time,
    };
  }

  registerAction('changeView', (payload, ctx) => {
    const html = Array.isArray(payload) ? payload[1] : null;
    if (typeof html !== 'string') return null;
    const info = parseUpgradeBox(html);
    if (!info) return null;
    // Building name as the game shows it (view title), used when the catalog lacks one
    const title = /<div class="buildingDescription">\s*<h1>([^<]+)<\/h1>/.exec(html)?.[1]?.trim();
    const cityId = info.cityId || ctx.params?.cityId || ctx.snapshot?.global?.selectedCityId;
    const position = info.position ?? ctx.params?.position;
    if (!cityId || position == null) return null;
    const entry = { level: info.level, cost: info.cost, time: info.time, canUpgrade: info.canUpgrade, view: ctx.view, updatedAt: Date.now() };
    // Function patch: the whole entry is replaced, so resources no longer needed do not linger
    return (snapshot) => {
      const city = snapshot.cities?.[cityId];
      if (!city) return snapshot;
      const upgradeCosts = { ...(city.upgradeCosts || {}), [position]: entry };
      const buildingNames = title && ctx.view ? { ...(snapshot.buildingNames || {}), [ctx.view]: title } : snapshot.buildingNames;
      return { ...snapshot, buildingNames, cities: { ...snapshot.cities, [cityId]: { ...city, upgradeCosts } } };
    };
  });

  IkaDios.parsers.upgrade = { parseUpgradeBox };
})(typeof self !== 'undefined' ? self : window);

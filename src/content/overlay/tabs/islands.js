// Islands tab: one row per island with own cities. World data (ika-map.com)
// gives resources, wonder, free slots and neighbours; islands visited in the game
// add their name, wonder level and running upgrades.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { el } = IkaDios.util;

  const TRADEGOOD_KEY = { 1: 'wine', 2: 'marble', 3: 'glass', 4: 'sulfur' };
  const TOP_ALLIANCES = 3;

  function ownIslands(snapshot) {
    const byCoord = new Map();
    for (const c of IkaDios.facets.ownCities(snapshot)) {
      if (!c.coords) continue;
      const key = `${c.coords.x}:${c.coords.y}`;
      if (!byCoord.has(key)) byCoord.set(key, { x: c.coords.x, y: c.coords.y, islandId: c.islandId || null, cities: [] });
      byCoord.get(key).cities.push(c);
    }
    return [...byCoord.values()].sort((a, b) => a.x - b.x || a.y - b.y);
  }

  function levelCell(level, endsAt, countdown) {
    return el('td', { class: 'num' }, [level != null ? String(level) : '-', endsAt && endsAt > Date.now() ? [' ', countdown(endsAt)] : null].flat());
  }

  function render(container, snapshot, helpers) {
    const { i18n, countdown, goToView, openTab } = helpers;
    const { t } = i18n;
    const islands = ownIslands(snapshot);
    if (!islands.length) {
      container.append(el('p', { class: 'empty', text: t('emptySummary') }));
      return;
    }
    const world = IkaDios.worldData.current();
    const status = el('p', { class: 'age' });
    const body = el('tbody');

    const fill = () => {
      const data = IkaDios.worldData.current();
      status.textContent = data ? t('mapSource', { when: i18n.formatRelative(data.fetchedAt), n: data.islands.length }) : t('mapLoading');
      body.replaceChildren(
        ...islands.map((own) => {
          const key = `${own.x}:${own.y}`;
          const w = data?.byCoord.get(key) || null;
          const visited = Object.values(snapshot?.islands || {}).find((i) => i.x === own.x && i.y === own.y) || null;
          const name = visited?.name || data?.names[key]?.name || '';
          const tg = TRADEGOOD_KEY[visited?.tradegood ?? w?.tradegood];
          const cities = visited ? visited.cities.map((c) => ({ ally: c.allyTag, player: c.ownerName })) : w?.cities || [];
          const allies = Object.entries(
            cities.reduce((acc, c) => {
              if (c.ally) acc[c.ally] = (acc[c.ally] || 0) + 1;
              return acc;
            }, {})
          )
            .sort((a, b) => b[1] - a[1])
            .slice(0, TOP_ALLIANCES)
            .map(([tag, n]) => `${tag} (${n})`)
            .join(', ');
          const wonder = visited?.wonder ?? w?.wonder;
          const wonderLevel = visited?.wonderLevel ?? data?.names[key]?.wonderLevel ?? null;
          return el('tr', { 'data-updated': visited?.updatedAt || data?.fetchedAt || null }, [
            el('td', { class: 'city' }, [
              el('span', { text: name || '-' }),
              el('button', { class: 'link', text: `[${key}]`, title: t('islandsShowOnMap'), onclick: () => openTab('map', { center: own }) }),
            ]),
            el('td', { text: own.cities.map((c) => c.name).join(', ') }),
            levelCell(visited?.woodLevel ?? w?.wood, visited?.woodUpgradeEndsAt, countdown),
            el('td', { text: tg ? t(`resourceShort_${tg}`) : '-' }),
            levelCell(visited?.tradegoodLevel ?? w?.tradegoodLevel, visited?.tradegoodUpgradeEndsAt, countdown),
            el('td', { text: wonder ? `${visited?.wonderName || t(`wonder_${wonder}`)}` : '-' }),
            levelCell(wonderLevel, visited?.wonderUpgradeEndsAt, countdown),
            el('td', { class: 'num', text: w ? `${cities.length} / ${w.free ?? '-'}` : String(cities.length || '-') }),
            el('td', { text: allies || '-' }),
            el('td', {}, own.islandId ? el('button', { class: 'btn-soft', text: t('openInGame'), onclick: () => goToView('island', { islandId: own.islandId }) }) : null),
          ]);
        })
      );
    };

    container.append(
      el('table', { class: 'grid' }, [
        el('thead', {}, el('tr', {}, [
          t('islandsIsland'), t('cities'), t('resourceShort_wood'), t('islandsLuxury'), t('mapLevel'), t('mapWonder'), t('mapLevel'), t('islandsCitiesFree'), t('islandsAlliances'), '',
        ].map((h) => el('th', { text: h })))),
        body,
      ]),
      status,
      el('p', { class: 'hint', text: t('islandsHint') })
    );
    fill();
    if (!world || world.world !== snapshot?.account?.world) {
      IkaDios.worldData.load(snapshot?.account?.world).then(fill, () => {
        status.textContent = t('mapError');
      });
    }
  }

  IkaDios.tabs.register({ id: 'islands', labelKey: 'tab_islands', order: 80, render });
})(typeof self !== 'undefined' ? self : window);

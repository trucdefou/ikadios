// Facet aggregators (snapshot to view model) and the overlay tab registry.
// Aggregators are pure and do not touch the DOM, so tests can run them on fixtures.
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});
  const { RESOURCES } = IkaDios.schema;

  function ownCities(snapshot) {
    return Object.values(snapshot?.cities || {})
      .filter((c) => c && c.id)
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  }

  // Seconds until a resource fills its warehouse at the current net rate, or null
  function secondsToFull(amount, capacity, perHour) {
    if (amount == null || capacity == null || !perHour || perHour <= 0) return null;
    return Math.max(0, ((capacity - amount) / perHour) * 3600);
  }

  // Values derived at render time, since stored amounts age between captures
  function projectedAmount(amount, perHour, sinceMs, capacity) {
    if (amount == null) return null;
    const hours = Math.max(0, (Date.now() - (sinceMs || Date.now())) / 3600000);
    const value = amount + (perHour || 0) * hours;
    return capacity != null ? Math.min(Math.max(value, 0), capacity) : Math.max(value, 0);
  }

  function summary(snapshot) {
    const cities = ownCities(snapshot).map((c) => {
      const res = {};
      for (const r of RESOURCES) {
        const perHour = (c.production?.[r] || 0) - (r === 'wine' ? c.wineSpending || 0 : 0);
        const amount = projectedAmount(c.resources?.[r], perHour, c.resourcesUpdatedAt, c.capacity?.[r]);
        const capacity = c.capacity?.[r] ?? null;
        res[r] = {
          amount,
          capacity,
          perHour,
          fill: amount != null && capacity ? amount / capacity : null,
          toFull: secondsToFull(amount, capacity, perHour),
        };
      }
      const wine = res.wine;
      const wineHours = c.wineSpending > 0 && wine.amount != null && wine.perHour < 0 ? wine.amount / -wine.perHour : null;
      const constructions = (c.buildings || []).filter((b) => b.underConstruction && b.upgradeEndsAt);
      return {
        id: c.id,
        name: c.name,
        coords: c.coords,
        tradegood: c.tradegood,
        resources: res,
        wineHours,
        population: c.population,
        citizens: c.citizens,
        construction: constructions.sort((a, b) => a.upgradeEndsAt - b.upgradeEndsAt)[0] || null,
        updatedAt: c.resourcesUpdatedAt || 0,
        buildingsUpdatedAt: c.buildingsUpdatedAt || 0,
      };
    });
    return { cities, global: snapshot?.global || {}, advisors: snapshot?.advisorState || {} };
  }

  // Resources a city has right now, projected from the last capture
  function currentResources(c) {
    const out = {};
    for (const r of RESOURCES) {
      const perHour = (c.production?.[r] || 0) - (r === 'wine' ? c.wineSpending || 0 : 0);
      out[r] = projectedAmount(c.resources?.[r], perHour, c.resourcesUpdatedAt, c.capacity?.[r]);
    }
    return out;
  }

  // Next-level upgrade of a building: cost, missing amounts and whether it is affordable.
  // The cost only applies while the captured level matches the building's level.
  function upgradeInfo(c, b, resources) {
    const entry = c.upgradeCosts?.[b.pos];
    if (!entry || entry.level !== b.level || !entry.cost || !Object.keys(entry.cost).length) {
      return { known: false, cityId: c.id, position: b.pos, level: b.level, updatedAt: entry?.updatedAt || 0 };
    }
    const missing = {};
    let unknownStock = false;
    for (const [r, amount] of Object.entries(entry.cost)) {
      const have = resources[r];
      if (have == null) unknownStock = true;
      else if (have < amount) missing[r] = amount - have;
    }
    return {
      known: true,
      cityId: c.id,
      position: b.pos,
      level: b.level,
      cost: entry.cost,
      time: entry.time,
      missing,
      enough: !unknownStock && !Object.keys(missing).length,
      unknownStock,
      updatedAt: entry.updatedAt,
    };
  }

  function polis(snapshot) {
    const cities = ownCities(snapshot);
    const types = new Set();
    for (const c of cities) for (const b of c.buildings || []) types.add(b.type);
    const columns = [...types].sort();
    const rows = cities.map((c) => {
      const resources = currentResources(c);
      // One construction at a time per city: an upgrade in progress blocks the rest.
      // An upgrade past its end time no longer blocks, even before the next capture.
      const now = Date.now();
      const constructing = (c.buildings || []).find((b) => b.underConstruction && (!b.upgradeEndsAt || b.upgradeEndsAt > now)) || null;
      const byType = {};
      for (const b of c.buildings || []) {
        // Several buildings of the same type (warehouses) show the lowest level,
        // which is the one worth upgrading next
        const prev = byType[b.type];
        const levels = [...(prev?.levels || []), b.level];
        if (!prev || b.level < prev.level) byType[b.type] = { ...b, upgrade: upgradeInfo(c, b, resources), levels };
        else prev.levels = levels;
      }
      return {
        id: c.id,
        name: c.name,
        population: c.population,
        citizens: c.citizens,
        maxActionPoints: c.maxActionPoints,
        isCapital: c.isCapital,
        townHall: c.townHall || null,
        constructing,
        resources,
        resourcesUpdatedAt: c.resourcesUpdatedAt || 0,
        byType,
        updatedAt: c.buildingsUpdatedAt || 0,
      };
    });
    return { columns, rows };
  }

  function transport(snapshot) {
    const g = snapshot?.global || {};
    const movements = (snapshot?.military?.movements || []).filter((m) => m.mission === 'transport');
    return {
      freeTransporters: g.freeTransporters,
      maxTransporters: g.maxTransporters,
      freeFreighters: g.freeFreighters,
      maxFreighters: g.maxFreighters,
      movements,
      updatedAt: g.updatedAt || 0,
    };
  }

  function finances(snapshot) {
    const g = snapshot?.global || {};
    const parts = [g.income, g.upkeep, g.scientistsUpkeep, g.godGoldResult].filter((v) => typeof v === 'number');
    const net = parts.length ? parts.reduce((a, b) => a + b, 0) : null;
    return {
      gold: g.gold,
      income: g.income,
      upkeep: g.upkeep,
      scientistsUpkeep: g.scientistsUpkeep,
      godGoldResult: g.godGoldResult,
      net,
      hoursLeft: net != null && net < 0 && g.gold != null ? g.gold / -net : null,
      perCity: ownCities(snapshot)
        .map((c) => ({ id: c.id, name: c.name, ...(snapshot?.finances?.perCity?.[c.id] || {}) }))
        .filter((c) => c.income != null),
      perCityUpdatedAt: snapshot?.finances?.updatedAt || 0,
      updatedAt: g.updatedAt || 0,
      goldUpdatedAt: g.goldUpdatedAt || g.updatedAt || 0,
    };
  }

  IkaDios.facets = { ownCities, secondsToFull, projectedAmount, currentResources, upgradeInfo, summary, polis, transport, finances };

  // Tab registry consumed by the overlay. A tab is
  // { id, labelKey, order, render(container, snapshot, helpers) }
  const tabs = [];
  IkaDios.tabs = {
    register(tab) {
      tabs.push(tab);
      tabs.sort((a, b) => a.order - b.order);
    },
    list() {
      return tabs.slice();
    },
  };
})(typeof self !== 'undefined' ? self : window);

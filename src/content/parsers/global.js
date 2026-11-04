// Parsers for account-wide data: the header bar (gold, resources of the selected
// city, transporters, advisors) and the list of related cities.
// Field names follow ikariam.model; confirm against fixtures/ (phase 0).
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});
  const { toNumber, parseCoords } = IkaDios.util;
  const { registerAction, registerModel } = IkaDios.parsers;

  // Index used by the game in currentResources/maxResources for each resource
  const RESOURCE_KEYS = { wood: 'resource', wine: '1', marble: '2', glass: '3', sulfur: '4' };
  const TRADEGOOD_BY_INDEX = { 1: 'wine', 2: 'marble', 3: 'glass', 4: 'sulfur' };

  // resourceProduction / tradegoodProduction are per second in the game model
  const PRODUCTION_TO_HOUR = 3600;

  function parseRelatedCities(related) {
    if (!related || typeof related !== 'object') return { cities: {}, selectedCityId: null };
    const cities = {};
    for (const [k, c] of Object.entries(related)) {
      if (!k.startsWith('city_') || !c || typeof c !== 'object') continue;
      if (c.relationship && c.relationship !== 'ownCity') continue;
      const id = String(c.id ?? k.slice(5));
      cities[id] = {
        id,
        name: c.name,
        coords: parseCoords(c.coords),
        tradegood: TRADEGOOD_BY_INDEX[toNumber(c.tradegood)] || null,
      };
    }
    const selected = String(related.selectedCity || '').replace('city_', '') || null;
    return { cities, selectedCityId: selected };
  }

  function parseAdvisors(advisorData) {
    if (!advisorData || typeof advisorData !== 'object') return null;
    const out = { premium: !!advisorData.hasPremiumAccount, updatedAt: Date.now() };
    for (const name of ['cities', 'military', 'research', 'diplomacy']) {
      const css = String(advisorData[name]?.cssclass || '');
      out[name] = { cssclass: css, active: /active|alert/i.test(css), alert: /alert/i.test(css) };
    }
    return out;
  }

  function parseHeader(header, cityId) {
    if (!header || typeof header !== 'object') return null;
    const now = Date.now();
    const patch = {
      global: {
        gold: toNumber(header.gold, null),
        income: toNumber(header.income, null),
        upkeep: toNumber(header.upkeep, null),
        scientistsUpkeep: toNumber(header.scientistsUpkeep, null),
        godGoldResult: toNumber(header.godGoldResult, null),
        ambrosia: toNumber(header.ambrosia, null),
        freeTransporters: toNumber(header.freeTransporters, null),
        maxTransporters: toNumber(header.maxTransporters, null),
        freeFreighters: toNumber(header.freeFreighters, null),
        maxFreighters: toNumber(header.maxFreighters, null),
        updatedAt: now,
      },
    };
    // Time of the gold reading itself, used to project gold to the present
    if (patch.global.gold != null) patch.global.goldUpdatedAt = now;

    // Full page model: advisorData; AJAX header: advisors
    const advisors = parseAdvisors(header.advisors ?? header.advisorData);
    if (advisors) patch.advisorState = advisors;

    if (cityId && header.currentResources) {
      const resources = {};
      const capacity = {};
      for (const [res, idx] of Object.entries(RESOURCE_KEYS)) {
        resources[res] = toNumber(header.currentResources[idx], null);
        capacity[res] = toNumber(header.maxResources?.[idx] ?? header.maxResources?.resource, null);
      }
      const tradegood = TRADEGOOD_BY_INDEX[toNumber(header.producedTradegood)] || null;
      const production = { wood: toNumber(header.resourceProduction, 0) * PRODUCTION_TO_HOUR };
      if (tradegood) production[tradegood] = toNumber(header.tradegoodProduction, 0) * PRODUCTION_TO_HOUR;

      patch.cities = {
        [cityId]: {
          id: cityId,
          resources,
          capacity,
          production,
          tradegood: tradegood || undefined,
          wineSpending: toNumber(header.wineSpendings, 0),
          citizens: toNumber(header.currentResources.citizens, null),
          population: toNumber(header.currentResources.population, null),
          maxActionPoints: toNumber(header.maxActionPoints, null),
          resourcesUpdatedAt: now,
        },
      };
    }
    return patch;
  }

  function mergePatches(...patches) {
    return patches.filter(Boolean).reduce((acc, p) => IkaDios.util.deepMerge(acc, p), {});
  }

  // Full page load: window.ikariam.model
  registerModel((model) => {
    const { cities, selectedCityId } = parseRelatedCities(model.relatedCityData);
    return mergePatches(
      { cities, global: { selectedCityId } },
      model.serverName || model.avatarAllyId
        ? { account: { serverName: model.serverName || undefined, allyId: model.avatarAllyId ? String(model.avatarAllyId) : undefined } }
        : null,
      withoutGold(parseHeader(model.headerData, selectedCityId))
    );
  });

  // On full page loads the game's model has gold = 0 (the header shows the real
  // amount from server HTML); only AJAX headerData carries the real value, so the
  // model must not overwrite the stored gold.
  function withoutGold(patch) {
    if (patch?.global) {
      delete patch.global.gold;
      delete patch.global.goldUpdatedAt;
    }
    return patch;
  }

  // AJAX navigation: ["updateGlobalData", {headerData, backgroundData, ...}].
  // The city list and the selected city come in headerData.cityDropdownMenu
  // (headerData.relatedCity is only {owncity: 1}). The header resources belong to
  // that city; when it is unknown they are dropped rather than guessed, because
  // falling back to an older selected city attached them to the wrong city.
  registerAction('updateGlobalData', (payload, ctx) => {
    const header = payload?.headerData;
    const related = [header?.cityDropdownMenu, header?.relatedCityData, header?.relatedCity, payload?.relatedCityData].find(
      (r) => r && typeof r === 'object' && Object.keys(r).some((k) => k.startsWith('city_') || k === 'selectedCity')
    );
    const { cities, selectedCityId } = parseRelatedCities(related);
    const cityId = selectedCityId || ctx.params?.currentCityId || ctx.params?.cityId || null;
    return mergePatches(
      Object.keys(cities).length ? { cities, global: { selectedCityId: cityId } } : null,
      parseHeader(header, cityId)
    );
  });

  IkaDios.parsers.global = { RESOURCE_KEYS, TRADEGOOD_BY_INDEX, parseRelatedCities, parseHeader, parseAdvisors };
})(typeof self !== 'undefined' ? self : window);

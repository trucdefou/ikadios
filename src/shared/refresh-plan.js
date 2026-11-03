// Refresh planning, shared by the service worker engine and tests. Pure: no I/O.
// Every view the refresh can load has a key; snapshot.viewsUpdatedAt[key] records
// when it was last captured (by the refresh or by the user browsing). Plans put
// missing and oldest views first, with a little jitter so the order varies.
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});

  const ACCOUNT_VIEWS = ['militaryAdvisor', 'militaryAdvisorCombatList', 'researchAdvisor', 'diplomacyAdvisor', 'tradeAdvisor', 'finances'];
  // Extra parameters some account views need
  const ACCOUNT_PARAMS = { militaryAdvisorCombatList: { activeTab: 'tab_militaryAdvisorCombatList' } };
  const BUILDING_VIEWS = ['townHall', 'tavern', 'museum', 'safehouse', 'branchOffice', 'port', 'barracks', 'shipyard', 'academy', 'temple'];

  // Views captured within this window of each other count as equally old,
  // so their order is random instead of fixed
  const STALENESS_JITTER_MS = 10 * 60 * 1000;
  const ISLAND_STEPS_ENABLED = false;

  // Views whose parsed result is stored on the city: when it is absent the view
  // counts as never loaded, even if viewsUpdatedAt has a time (a view loaded before
  // its parser existed would otherwise never be loaded again)
  const CITY_DATA = {
    cityMilitary: (city) => city.militaryUpdatedAt,
    townHall: (city) => city.townHall,
    safehouse: (city) => city.spies,
  };

  // Human-like pacing: log-normal pauses (most short, a long tail) and an
  // occasional "reading" break. Long breaks stay under the service worker idle limit.
  const PAUSE_MEDIAN_MS = 2600;
  const PAUSE_SPREAD = 0.45;
  const PAUSE_MIN_MS = 1200;
  const PAUSE_MAX_MS = 9000;
  const LONG_PAUSE_CHANCE = 0.08;
  const LONG_PAUSE_MIN_MS = 8000;
  const LONG_PAUSE_MAX_MS = 22000;

  function gaussian() {
    const u = 1 - Math.random();
    const v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  function nextPauseMs() {
    if (Math.random() < LONG_PAUSE_CHANCE) return randomBetween(LONG_PAUSE_MIN_MS, LONG_PAUSE_MAX_MS);
    const ms = PAUSE_MEDIAN_MS * Math.exp(PAUSE_SPREAD * gaussian());
    return Math.min(PAUSE_MAX_MS, Math.max(PAUSE_MIN_MS, ms));
  }

  function shuffle(list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function cityParams(cityId, extra) {
    return { cityId, currentCityId: cityId, backgroundView: 'city', ...extra };
  }

  // view=city answers with a "reload" order; the game itself loads a city's
  // background with view=updateGlobalData, which returns backgroundData
  function cityStep(city) {
    return {
      key: `${city.id}:city`,
      kind: 'city',
      cityId: city.id,
      cityName: city.name,
      params: cityParams(city.id, { view: 'updateGlobalData' }),
    };
  }

  // Steps that need the city's buildings (positions) to be known
  function detailSteps(city) {
    const steps = [];
    const seen = new Set();
    for (const b of city.buildings || []) {
      if (!BUILDING_VIEWS.includes(b.type) || seen.has(b.type)) continue;
      seen.add(b.type);
      steps.push({
        key: `${city.id}:${b.type}`,
        kind: 'building',
        cityId: city.id,
        cityName: city.name,
        view: b.type,
        params: cityParams(city.id, { view: b.type, position: b.pos }),
        dataMissing: CITY_DATA[b.type] ? !CITY_DATA[b.type](city) : false,
        costKnown: city.upgradeCosts?.[b.pos]?.level === b.level,
      });
    }
    // Every other building only when its upgrade cost is missing or stale (the cost
    // changes only with the level), for the Polis affordability colors
    for (const b of city.buildings || []) {
      if (BUILDING_VIEWS.includes(b.type) || b.underConstruction || !/^[a-zA-Z]+$/.test(b.type)) continue;
      const known = city.upgradeCosts?.[b.pos];
      if (known && known.level === b.level) continue;
      steps.push({
        key: `${city.id}:cost:${b.pos}`,
        kind: 'building',
        cityId: city.id,
        cityName: city.name,
        view: b.type,
        params: cityParams(city.id, { view: b.type, position: b.pos }),
      });
    }
    steps.push({
      key: `${city.id}:cityMilitary`,
      kind: 'military',
      cityId: city.id,
      cityName: city.name,
      params: cityParams(city.id, { view: 'cityMilitary', activeTab: 'tabUnits' }),
      dataMissing: !CITY_DATA.cityMilitary(city),
    });
    // view=island also answers "reload"; island data waits for the map data source
    if (city.islandId && ISLAND_STEPS_ENABLED) {
      steps.push({
        key: `${city.id}:island`,
        kind: 'island',
        cityId: city.id,
        cityName: city.name,
        islandName: city.islandName,
        params: cityParams(city.id, { view: 'island', islandId: city.islandId }),
      });
    }
    return steps;
  }

  function accountSteps() {
    return ACCOUNT_VIEWS.map((view) => ({ key: `account:${view}`, kind: 'account', view, params: { view, ...(ACCOUNT_PARAMS[view] || {}) } }));
  }

  function updatedAt(snapshot, key) {
    return snapshot?.viewsUpdatedAt?.[key] || 0;
  }

  // Missing first (0), then oldest; equal-ish ages in random order
  function byStaleness(steps, snapshot) {
    return shuffle(steps)
      .map((step) => {
        const ts = step.dataMissing ? 0 : updatedAt(snapshot, step.key);
        return { step, rank: ts === 0 ? -Infinity : ts - Math.random() * STALENESS_JITTER_MS };
      })
      .sort((a, b) => a.rank - b.rank)
      .map((x) => x.step);
  }

  // Phase A: cities whose buildings are unknown (needed to plan their details).
  // Phase B: every other step, ordered by staleness. Phase B is built after phase A
  // runs, from the fresh snapshot.
  function phaseA(snapshot) {
    const cities = IkaDios.facets.ownCities(snapshot).filter((c) => !(c.buildings || []).length);
    return byStaleness(cities.map(cityStep), snapshot);
  }

  function phaseB(snapshot, doneKeys = new Set()) {
    const steps = [];
    for (const city of IkaDios.facets.ownCities(snapshot)) {
      steps.push(cityStep(city), ...detailSteps(city));
    }
    steps.push(...accountSteps());
    return byStaleness(
      steps.filter((s) => !doneKeys.has(s.key)),
      snapshot
    );
  }

  // Views behind each overlay tab, for "Refresh this tab". Every matching view is
  // loaded, whatever its age.
  const SCOPES = {
    summary: (s) => s.kind === 'city' || s.key === 'account:militaryAdvisor',
    // Upgrade costs only change with the level: buildings whose cost is known are skipped
    polis: (s) => s.kind === 'city' || s.view === 'townHall' || (s.kind === 'building' && !s.costKnown),
    military: (s) => s.kind === 'military' || s.key === 'account:militaryAdvisor' || s.key === 'account:militaryAdvisorCombatList' || s.view === 'townHall',
    research: (s) => s.key === 'account:researchAdvisor' || s.view === 'academy',
    transport: (s) => s.kind === 'city' || s.key === 'account:militaryAdvisor' || s.view === 'port',
    finances: (s) => s.key === 'account:finances',
    diplomacy: (s) => s.key === 'account:diplomacyAdvisor',
    espionage: (s) => s.view === 'safehouse' || s.kind === 'spyReports',
    trade: (s) => s.key === 'account:tradeAdvisor' || s.view === 'branchOffice',
    islands: (s) => s.kind === 'city',
  };

  // Spy reports (hideout tabs) are account-wide, loaded from any city with a
  // hideout. Only on request: opening the reports tab may mark them as read.
  function spyReportSteps(snapshot) {
    for (const city of IkaDios.facets.ownCities(snapshot)) {
      const hideout = (city.buildings || []).find((b) => b.type === 'safehouse');
      if (!hideout) continue;
      return ['tabReports', 'tabArchive'].map((tab) => ({
        key: `account:spyReports:${tab}`,
        kind: 'spyReports',
        cityId: city.id,
        cityName: city.name,
        params: cityParams(city.id, { view: 'safehouse', position: hideout.pos, activeTab: tab }),
      }));
    }
    return [];
  }

  // Steps for one tab, or null when the tab has nothing to refresh. Cities whose
  // buildings are unknown come first, since the detail views need them.
  function scopedSteps(snapshot, scope) {
    const match = SCOPES[scope];
    if (!match) return null;
    const steps = [];
    for (const city of IkaDios.facets.ownCities(snapshot)) {
      steps.push(cityStep(city), ...detailSteps(city));
    }
    steps.push(...accountSteps(), ...spyReportSteps(snapshot));
    const list = steps.filter(match);
    const unknown = phaseA(snapshot).filter((s) => !list.some((x) => x.key === s.key));
    return [...unknown, ...shuffle(list)];
  }

  function estimateTotal(snapshot) {
    let total = ACCOUNT_VIEWS.length;
    for (const c of IkaDios.facets.ownCities(snapshot)) {
      const types = new Set((c.buildings || []).map((b) => b.type).filter((t) => BUILDING_VIEWS.includes(t)));
      total += 2 + (types.size || 6);
    }
    return total;
  }

  // Key recorded when the user opens a view while browsing (passive capture)
  function keyForView(view, cityId) {
    if (ACCOUNT_VIEWS.includes(view)) return `account:${view}`;
    if (!cityId) return null;
    if (view === 'city' || BUILDING_VIEWS.includes(view) || view === 'cityMilitary' || view === 'island') return `${cityId}:${view}`;
    return null;
  }

  IkaDios.refreshPlan = {
    ACCOUNT_VIEWS,
    BUILDING_VIEWS,
    nextPauseMs,
    randomBetween,
    shuffle,
    phaseA,
    phaseB,
    byStaleness,
    estimateTotal,
    keyForView,
    SCOPES,
    scopedSteps,
  };
})(typeof self !== 'undefined' ? self : window);

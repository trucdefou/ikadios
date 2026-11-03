// Which raw game responses get recorded as debug captures. Shared by the game tab
// (bridge), the refresh engine and the options page. Settings:
//   settings.debugCapture: boolean (master switch)
//   settings.debugFilter: {
//     until: ms timestamp | null      (auto off after this time)
//     sources: { tab, refresh }       (game tab browsing / background refresh)
//     groups: { <groupId>: boolean }
//     views: "militaryAdvisor, island"  (if set, only these views, any group)
//   }
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});

  const ADVISOR_VIEWS = ['militaryAdvisor', 'militaryAdvisorCombatList', 'militaryAdvisorWarList', 'researchAdvisor', 'diplomacyAdvisor', 'diplomacyAlly', 'tradeAdvisor', 'finances'];
  const MAP_VIEWS = ['island', 'worldmap_iso', 'worldmap', 'islandBoard'];
  const REPORT_VIEWS = ['safehouseReports', 'militaryAdvisorReportView', 'militaryAdvisorDetailedReportView', 'spyReports'];

  // Order shown in the options page
  const GROUPS = ['advisors', 'buildings', 'background', 'map', 'reports', 'special', 'other'];
  const DURATIONS_MIN = [10, 30, 60, 0];

  // Every building view carries the upgrade box; detecting it by content covers
  // all building types without keeping a list of them
  function hasBuildingBox(actions) {
    return (
      Array.isArray(actions) &&
      actions.some((a) => a?.[0] === 'changeView' && typeof a[1]?.[1] === 'string' && a[1][1].includes('id="buildingUpgrade"'))
    );
  }

  // entry: { kind, view, actions? }
  function groupOf({ kind, view, actions }) {
    if (kind === 'model' || view === 'updateGlobalData' || (!view && kind === 'ajax')) return 'background';
    if (kind === 'json') return 'special';
    if (ADVISOR_VIEWS.includes(view)) return 'advisors';
    if (MAP_VIEWS.includes(view)) return 'map';
    if (REPORT_VIEWS.includes(view)) return 'reports';
    if (hasBuildingBox(actions)) return 'buildings';
    return 'other';
  }

  function defaultFilter() {
    return {
      until: null,
      sources: { tab: true, refresh: true },
      groups: Object.fromEntries(GROUPS.map((g) => [g, true])),
      views: '',
    };
  }

  function normalize(filter) {
    const base = defaultFilter();
    return {
      ...base,
      ...(filter || {}),
      sources: { ...base.sources, ...(filter?.sources || {}) },
      groups: { ...base.groups, ...(filter?.groups || {}) },
    };
  }

  function viewList(text) {
    return String(text || '')
      .split(/[\s,;]+/)
      .map((v) => v.trim())
      .filter(Boolean);
  }

  // True while recording is on and not expired
  function isActive(settings, now = Date.now()) {
    if (!settings?.debugCapture) return false;
    const until = settings.debugFilter?.until;
    return !until || now < until;
  }

  // entry: { source: 'tab' | 'refresh', kind, view, actions? }
  function shouldCapture(settings, entry) {
    if (!isActive(settings)) return false;
    const filter = normalize(settings.debugFilter);
    if (filter.sources[entry.source || 'tab'] === false) return false;
    const only = viewList(filter.views);
    if (only.length) return !!entry.view && only.includes(entry.view);
    return filter.groups[groupOf(entry)] !== false;
  }

  IkaDios.captureFilter = { GROUPS, DURATIONS_MIN, groupOf, hasBuildingBox, defaultFilter, normalize, viewList, isActive, shouldCapture };
})(typeof self !== 'undefined' ? self : window);

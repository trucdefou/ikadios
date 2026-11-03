// Catalog of Discord message types and per-webhook filters, shared by the options
// page and the service worker. A webhook config is:
//   { id, name, url, enabled,
//     events: { <eventId>: boolean },
//     cities: [] | [cityId, ...]      (empty = all cities)
//     summarySections: { <sectionId>: boolean } }
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});

  // available: false marks types whose data arrives with later phases; they can be
  // assigned to a channel already and start flowing once implemented
  const EVENTS = [
    { id: 'attack', group: 'alerts', available: true, defaultOn: true, perCity: true },
    { id: 'summary', group: 'summaries', available: true, defaultOn: false, perCity: true },
    { id: 'manual', group: 'summaries', available: true, defaultOn: true, perCity: true },
    { id: 'espionageReport', group: 'reports', available: false, defaultOn: false, perCity: true },
    { id: 'combatReport', group: 'reports', available: false, defaultOn: false, perCity: true },
    { id: 'mapLayer', group: 'map', available: true, defaultOn: false, perCity: false },
    { id: 'tradeListing', group: 'trade', available: true, defaultOn: false, perCity: true },
  ];

  const SUMMARY_SECTIONS = ['overview', 'totals', 'cityResources', 'wine', 'construction'];

  function defaultWebhook() {
    return {
      id: `wh_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      name: '',
      url: '',
      enabled: true,
      events: Object.fromEntries(EVENTS.map((e) => [e.id, e.defaultOn])),
      cities: [],
      summarySections: Object.fromEntries(SUMMARY_SECTIONS.map((s) => [s, true])),
    };
  }

  // Older configs lack the newer fields; fill them without touching chosen values
  function normalize(webhook) {
    const base = defaultWebhook();
    return {
      ...base,
      ...webhook,
      events: { ...base.events, ...(webhook.events || {}) },
      cities: Array.isArray(webhook.cities) ? webhook.cities.map(String) : [],
      summarySections: { ...base.summarySections, ...(webhook.summarySections || {}) },
    };
  }

  function wantsCity(webhook, cityId) {
    return !webhook.cities?.length || webhook.cities.includes(String(cityId));
  }

  IkaDios.discordEvents = { EVENTS, SUMMARY_SECTIONS, defaultWebhook, normalize, wantsCity };
})(typeof self !== 'undefined' ? self : window);

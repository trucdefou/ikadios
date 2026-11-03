// Alert rules: pure functions over the snapshot. Each alert is
//   { id, type, severity: 'critical' | 'warning' | 'info', cityId?, params }
// where `id` is stable while the condition lasts (used to avoid repeated
// notifications). Thresholds and on/off per type come from settings.alerts.
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});

  const TYPES = [
    { id: 'attack', severity: 'critical' },
    { id: 'wineLow', severity: 'warning', threshold: 12 },
    { id: 'storageFull', severity: 'warning', threshold: 3 },
    { id: 'goldLow', severity: 'warning', threshold: 48 },
    { id: 'unhappy', severity: 'warning', threshold: 0 },
    { id: 'constructionDone', severity: 'info' },
    { id: 'researchAvailable', severity: 'info' },
    { id: 'garrisonOver', severity: 'info' },
    { id: 'advisor', severity: 'info' },
  ];

  function defaults() {
    return {
      desktop: true,
      desktopMinSeverity: 'warning',
      types: Object.fromEntries(TYPES.map((t) => [t.id, { enabled: true, threshold: t.threshold ?? null }])),
    };
  }

  function normalize(config) {
    const base = defaults();
    const types = { ...base.types };
    for (const [id, value] of Object.entries(config?.types || {})) types[id] = { ...base.types[id], ...value };
    return { ...base, ...(config || {}), types };
  }

  const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };

  function evaluate(snapshot, config) {
    const cfg = normalize(config);
    const on = (id) => cfg.types[id]?.enabled !== false;
    const th = (id) => cfg.types[id]?.threshold;
    const out = [];
    const push = (type, params = {}, cityId = null) => {
      const meta = TYPES.find((t) => t.id === type);
      out.push({ id: `${type}:${cityId ?? ''}:${params.key ?? ''}`, type, severity: params.severity || meta.severity, cityId, params });
    };
    if (!snapshot) return out;

    const adv = snapshot.advisorState || {};
    const hostile = (snapshot.military?.movements || []).filter((m) => m.hostile && (!m.arrivesAt || m.arrivesAt > Date.now()));
    if (on('attack')) {
      for (const m of hostile) {
        push('attack', { key: m.id, attacker: m.origin?.player || '', from: m.origin?.name || '', city: m.target?.name || '', mission: m.text || m.mission, arrivesAt: m.arrivesAt }, m.target?.cityId || null);
      }
      // The advisor flag alone, when the movement list has not been read yet
      if (adv.military?.alert && !hostile.length) push('attack');
    }
    if (on('advisor')) {
      for (const a of ['cities', 'research', 'diplomacy', 'military']) {
        if (adv[a]?.active && !(a === 'military' && adv.military?.alert)) push('advisor', { advisor: a, key: a });
      }
    }

    const summary = IkaDios.facets.summary(snapshot);
    for (const c of summary.cities) {
      if (on('wineLow') && c.wineHours != null && c.wineHours < th('wineLow')) {
        push('wineLow', { city: c.name, hours: c.wineHours, severity: c.wineHours < 2 ? 'critical' : 'warning' }, c.id);
      }
      if (on('storageFull')) {
        for (const [r, res] of Object.entries(c.resources)) {
          if (res.capacity && res.fill != null && (res.fill >= 0.98 || (res.toFull != null && res.toFull / 3600 < th('storageFull')))) {
            push('storageFull', { city: c.name, resource: r, hours: res.toFull != null ? res.toFull / 3600 : 0, key: r }, c.id);
          }
        }
      }
    }

    const now = Date.now();
    for (const c of IkaDios.facets.ownCities(snapshot)) {
      if (on('unhappy') && c.townHall?.happiness != null && c.townHall.happiness < th('unhappy')) {
        push('unhappy', { city: c.name, value: c.townHall.happiness }, c.id);
      }
      if (on('constructionDone')) {
        for (const b of c.buildings || []) {
          if (b.underConstruction && b.upgradeEndsAt && b.upgradeEndsAt <= now) {
            push('constructionDone', { city: c.name, building: b.type, level: b.level + 1, key: b.pos }, c.id);
          }
        }
      }
      if (on('garrisonOver') && c.townHall?.garrisonLand) {
        const total = Object.values(c.units || {}).reduce((a, n) => a + n, 0);
        if (total > c.townHall.garrisonLand) push('garrisonOver', { city: c.name, total, limit: c.townHall.garrisonLand }, c.id);
      }
    }

    const fin = IkaDios.facets.finances(snapshot);
    if (on('goldLow') && fin.hoursLeft != null && fin.hoursLeft < th('goldLow')) push('goldLow', { hours: fin.hoursLeft });

    const research = snapshot.research;
    if (on('researchAvailable') && research?.points != null) {
      for (const b of research.branches || []) {
        if (!b.maxed && b.cost != null && research.points >= b.cost) push('researchAvailable', { branch: b.label || b.id, name: b.next, key: b.id });
      }
    }

    return out.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  }

  // Human text for an alert in the active language
  function describe(alert, i18n) {
    const p = alert.params || {};
    const hours = (h) => i18n.formatDuration(Math.max(0, h) * 3600);
    switch (alert.type) {
      case 'advisor':
        return i18n.t(`advisorActive_${p.advisor}`);
      case 'wineLow':
        return i18n.t('alert_wineLow', { city: p.city, time: hours(p.hours) });
      case 'storageFull':
        return i18n.t(p.hours > 0 ? 'alert_storageFullSoon' : 'alert_storageFull', { city: p.city, resource: i18n.t(`resource_${p.resource}`), time: hours(p.hours) });
      case 'goldLow':
        return i18n.t('alert_goldLow', { time: hours(p.hours) });
      case 'unhappy':
        return i18n.t('alert_unhappy', { city: p.city, value: p.value });
      case 'constructionDone':
        return i18n.t('alert_constructionDone', { city: p.city, building: i18n.buildingName(p.building), level: p.level });
      case 'researchAvailable':
        return i18n.t('alert_researchAvailable', { name: p.name || p.branch });
      case 'garrisonOver':
        return i18n.t('alert_garrisonOver', { city: p.city, total: p.total, limit: p.limit });
      case 'attack':
        return p.city
          ? i18n.t('alert_attackDetail', { attacker: p.attacker || '?', city: p.city, time: p.arrivesAt ? i18n.formatDuration((p.arrivesAt - Date.now()) / 1000) : '?' })
          : i18n.t('alert_attack');
      default:
        return i18n.t(`alert_${alert.type}`);
    }
  }

  // Game view that deals with an alert
  function viewFor(alert) {
    const map = {
      attack: ['militaryAdvisor'],
      advisor: [{ cities: 'tradeAdvisor', military: 'militaryAdvisor', research: 'researchAdvisor', diplomacy: 'diplomacyAdvisor' }[alert.params?.advisor]],
      researchAvailable: ['researchAdvisor'],
      goldLow: ['finances'],
    };
    if (map[alert.type]) return { view: map[alert.type][0], params: {} };
    if (alert.cityId) return { view: 'city', params: { cityId: alert.cityId } };
    return null;
  }

  IkaDios.alerts = { TYPES, SEVERITY_RANK, defaults, normalize, evaluate, describe, viewFor };
})(typeof self !== 'undefined' ? self : window);

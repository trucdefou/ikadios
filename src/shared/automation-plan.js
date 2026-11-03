// Automation rules shared by the worker engine and the overlay: state shape, quiet
// hours, the hourly action limit and the evaluation of each task against the
// snapshot. Pure functions, no chrome.* calls, so they run in Node tests too.
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});

  const MAX_ACTIONS_PER_HOUR = 20;
  const HOUR_MS = 3600000;
  const MIN_WAIT_MS = 2 * 60000;
  // Check interval (state.checkMinutes): no task waits longer than this, and data
  // older than this is read from the game again even when the snapshot says the
  // task is still waiting
  const CHECK_MINUTES = { min: 15, max: 60, default: 60 };
  const BUSY_GRACE_MS = [30000, 120000];
  const MAX_TASK_ERRORS = 3;
  const MAX_LOG = 200;
  const DEFAULT_QUIET = { enabled: true, from: '03:00', to: '08:00' };
  const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

  const stateKey = (world) => `automation:${world}`;

  function emptyState() {
    return { enabled: false, quiet: { ...DEFAULT_QUIET }, checkMinutes: CHECK_MINUTES.default, tasks: [], actionTimes: [], stopped: null, nextAt: null, lastRunAt: null };
  }

  function normalize(state) {
    const base = emptyState();
    if (!state || typeof state !== 'object') return base;
    return {
      ...base,
      ...state,
      quiet: { ...base.quiet, ...(state.quiet || {}) },
      // Tasks from the earlier simulation mode become inactive
      tasks: (Array.isArray(state.tasks) ? state.tasks : []).map((t) => {
        if (!t || t.type === 'transport' || !('mode' in t)) return t;
        const { mode, ...rest } = t;
        return mode === 'simulate' && rest.status === 'waiting' ? { ...rest, status: 'paused' } : rest;
      }),
      actionTimes: Array.isArray(state.actionTimes) ? state.actionTimes : [],
    };
  }

  const randomBetween = (min, max) => min + Math.random() * (max - min);

  function minutesOf(text) {
    const m = TIME.exec(String(text || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  // Quiet window in local time; "from" later than "to" wraps past midnight
  function inQuietHours(quiet, date = new Date()) {
    if (!quiet?.enabled) return false;
    const from = minutesOf(quiet.from);
    const to = minutesOf(quiet.to);
    if (from == null || to == null || from === to) return false;
    const now = date.getHours() * 60 + date.getMinutes();
    return from < to ? now >= from && now < to : now >= from || now < to;
  }

  // Next time the quiet window ends (ms), from a moment inside it
  function quietEndsAt(quiet, now = Date.now()) {
    const to = minutesOf(quiet.to);
    const end = new Date(now);
    end.setHours(Math.floor(to / 60), to % 60, 0, 0);
    if (end.getTime() <= now) end.setDate(end.getDate() + 1);
    return end.getTime();
  }

  function recentActions(times, now = Date.now()) {
    return (times || []).filter((t) => now - t < HOUR_MS);
  }

  // When the hourly limit is reached: the moment the oldest action leaves the hour
  function rateLimitFreeAt(times, now = Date.now()) {
    const recent = recentActions(times, now).sort((a, b) => a - b);
    if (recent.length < MAX_ACTIONS_PER_HOUR) return null;
    return recent[recent.length - MAX_ACTIONS_PER_HOUR] + HOUR_MS + 1000;
  }

  // Tasks that can run now. Build tasks run in order per city: only the first
  // active unfinished one of each city is considered, since a city builds one thing at a time. Inactive tasks
  // ('paused') are skipped, so the next one of that city goes ahead.
  function headTasks(state) {
    const seen = new Set();
    const out = [];
    for (const task of state.tasks) {
      if (task.status === 'done' || task.status === 'error' || task.status === 'paused') continue;
      // Transport tasks are independent of each other and of the build queues
      if (task.type === 'transport') {
        out.push(task);
        continue;
      }
      if (task.type !== 'build' || seen.has(task.cityId)) continue;
      seen.add(task.cityId);
      out.push(task);
    }
    return out;
  }

  function validCheckMinutes(value) {
    const n = Number(value);
    return Number.isInteger(n) && n >= CHECK_MINUTES.min && n <= CHECK_MINUTES.max;
  }

  function checkIntervalMs(state) {
    return (validCheckMinutes(state?.checkMinutes) ? Number(state.checkMinutes) : CHECK_MINUTES.default) * 60000;
  }

  const clampWait = (ms, maxMs) => Math.min(maxMs, Math.max(MIN_WAIT_MS, ms));

  // What a build task needs now, from the snapshot:
  // { state: 'done' | 'error' | 'busy' | 'missing' | 'ready' | 'check', until?, reason?, missing?, building?, upgrade? }
  // 'check' means the data is not enough to decide and the game must be asked.
  function evaluateBuild(task, snapshot, now = Date.now(), maxWaitMs = CHECK_MINUTES.default * 60000) {
    const city = snapshot?.cities?.[task.cityId];
    if (!city?.buildings?.length) return { state: 'check' };
    const building = city.buildings.find((b) => b.pos === task.position);
    if (!building) return { state: 'error', reason: 'noBuilding' };
    if (building.type !== task.buildingType) return { state: 'error', reason: 'buildingChanged' };
    if (building.level >= task.targetLevel) return { state: 'done', building };

    const constructing = city.buildings.find((b) => b.underConstruction && (!b.upgradeEndsAt || b.upgradeEndsAt > now));
    if (constructing) {
      const until = Math.min(constructing.upgradeEndsAt ? constructing.upgradeEndsAt + randomBetween(...BUSY_GRACE_MS) : Infinity, now + maxWaitMs);
      return { state: 'busy', until, building, constructing };
    }

    const resources = IkaDios.facets.currentResources(city);
    const upgrade = IkaDios.facets.upgradeInfo(city, building, resources);
    if (!upgrade.known || upgrade.unknownStock) return { state: 'check', building, upgrade };
    if (upgrade.enough) return { state: 'ready', building, upgrade };

    // Time until production covers what is missing; resources nobody produces here
    // (they have to be shipped in) are checked again later
    let wait = 0;
    for (const [r, amount] of Object.entries(upgrade.missing)) {
      const perHour = (city.production?.[r] || 0) - (r === 'wine' ? city.wineSpending || 0 : 0);
      wait = Math.max(wait, perHour > 0 ? (amount / perHour) * HOUR_MS : maxWaitMs);
    }
    return { state: 'missing', until: now + clampWait(wait, maxWaitMs), building, upgrade, missing: upgrade.missing };
  }

  function newTask({ cityId, cityName, position, buildingType, fromLevel, targetLevel, active }) {
    return {
      id: `task_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      type: 'build',
      cityId: String(cityId),
      cityName: String(cityName || ''),
      position: Number(position),
      buildingType: String(buildingType),
      fromLevel: Number(fromLevel),
      targetLevel: Number(targetLevel),
      status: active ? 'waiting' : 'paused',
      errors: 0,
      waitUntil: 0,
      lastMessage: null,
      createdAt: Date.now(),
    };
  }

  function validTask(t) {
    return (
      t &&
      /^\d+$/.test(String(t.cityId)) &&
      Number.isInteger(Number(t.position)) &&
      Number(t.position) >= 0 &&
      Number(t.position) < 30 &&
      /^[A-Za-z]+$/.test(String(t.buildingType)) &&
      Number.isInteger(Number(t.targetLevel)) &&
      Number(t.targetLevel) > Number(t.fromLevel) &&
      Number(t.targetLevel) <= 100
    );
  }


  // ---------- Transport ----------

  const RESOURCES = ['wood', 'wine', 'marble', 'glass', 'sulfur'];
  // Merchant ship capacity (the transport form sends capacity=5, in hundreds)
  const SHIP_CAPACITY = 500;
  const TRANSPORT_MODES = ['fixed', 'fill'];

  // Cargo already on its way to a city in own transports (needs the military
  // advisor data; without it nothing is subtracted)
  function inTransit(snapshot, cityId) {
    const out = Object.fromEntries(RESOURCES.map((r) => [r, 0]));
    for (const m of snapshot?.military?.movements || []) {
      if (!m.own || m.returning || m.mission !== 'transport' || String(m.target?.cityId) !== String(cityId)) continue;
      if (m.arrivesAt && m.arrivesAt < Date.now()) continue;
      for (const c of m.cargo || []) if (c.resource in out) out[c.resource] += c.amount;
    }
    return out;
  }

  const floorAll = (obj) => Object.fromEntries(Object.entries(obj).map(([r, n]) => [r, Math.max(0, Math.floor(n))]).filter(([, n]) => n > 0));
  const total = (cargo) => Object.values(cargo).reduce((a, n) => a + n, 0);

  // What a transport task needs now, from the snapshot:
  // { state: 'ready', cargo, ships } | { state: 'scheduled' | 'missing' | 'noShips' | 'satisfied', until } |
  // { state: 'error', reason } | { state: 'check' }
  // fixed: send exactly `amounts` (waits until the origin has all of it);
  // fill: bring the destination up to `amounts`, minus cargo already on the way,
  // sending what the origin and the free ships allow.
  function evaluateTransport(task, snapshot, now = Date.now(), maxWaitMs = CHECK_MINUTES.default * 60000) {
    // Scheduled start: nothing is checked before that moment
    if (task.startAt && task.startAt > now) return { state: 'scheduled', until: task.startAt };
    const from = snapshot?.cities?.[task.fromCityId];
    const to = snapshot?.cities?.[task.toCityId];
    if (!from || !to) return { state: 'error', reason: 'noCity' };
    const have = IkaDios.facets.currentResources(from);
    if (RESOURCES.some((r) => task.amounts[r] && have[r] == null)) return { state: 'check' };
    const wait = (state, extra = {}) => ({ state, until: now + maxWaitMs, ...extra });

    let cargo;
    if (task.mode === 'fill') {
      const there = IkaDios.facets.currentResources(to);
      if (RESOURCES.some((r) => task.amounts[r] && there[r] == null)) return { state: 'check' };
      const coming = inTransit(snapshot, task.toCityId);
      const want = {};
      for (const r of RESOURCES) {
        if (!task.amounts[r]) continue;
        let need = task.amounts[r] - there[r] - coming[r];
        const room = to.capacity?.[r];
        if (room != null) need = Math.min(need, room - there[r] - coming[r]);
        want[r] = Math.min(need, have[r]);
      }
      cargo = floorAll(want);
      if (!total(cargo)) {
        const short = RESOURCES.some((r) => task.amounts[r] && task.amounts[r] - there[r] - coming[r] > 0);
        return short ? wait('missing', { missing: null }) : wait('satisfied');
      }
    } else {
      const missing = {};
      for (const r of RESOURCES) if (task.amounts[r] && have[r] < task.amounts[r]) missing[r] = task.amounts[r] - have[r];
      if (Object.keys(missing).length) return wait('missing', { missing });
      cargo = floorAll(task.amounts);
    }

    const free = snapshot?.global?.freeTransporters;
    if (free === 0) return wait('noShips');
    let ships = Math.ceil(total(cargo) / SHIP_CAPACITY);
    if (free != null && ships > free) {
      if (task.mode !== 'fill') return wait('noShips', { ships, free });
      // Fill sends what fits in the free ships, the rest goes next time
      let room = free * SHIP_CAPACITY;
      for (const r of RESOURCES) {
        const n = Math.min(cargo[r] || 0, room);
        if (n) cargo[r] = n;
        else delete cargo[r];
        room -= n;
      }
      ships = free;
    }
    return { state: 'ready', cargo, ships };
  }

  function newTransportTask({ fromCityId, fromName, toCityId, toName, mode, amounts, repeatHours, startAt, active }) {
    return {
      id: `task_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      type: 'transport',
      fromCityId: String(fromCityId),
      fromName: String(fromName || ''),
      toCityId: String(toCityId),
      toName: String(toName || ''),
      mode: TRANSPORT_MODES.includes(mode) ? mode : 'fixed',
      amounts: floorAll(Object.fromEntries(RESOURCES.map((r) => [r, Number(amounts?.[r]) || 0]))),
      repeatHours: Math.max(0, Number(repeatHours) || 0),
      // First send not before this moment (ms); null sends as soon as possible
      startAt: Number(startAt) > 0 ? Number(startAt) : null,
      status: active ? 'waiting' : 'paused',
      errors: 0,
      waitUntil: Number(startAt) > 0 ? Number(startAt) : 0,
      lastMessage: null,
      createdAt: Date.now(),
    };
  }

  function validTransportTask(t) {
    const amounts = Object.values(t?.amounts || {}).map(Number);
    return (
      t &&
      /^\d+$/.test(String(t.fromCityId)) &&
      /^\d+$/.test(String(t.toCityId)) &&
      String(t.fromCityId) !== String(t.toCityId) &&
      TRANSPORT_MODES.includes(t.mode) &&
      Object.keys(t.amounts || {}).every((r) => RESOURCES.includes(r)) &&
      amounts.every((n) => Number.isFinite(n) && n >= 0 && n <= 10000000) &&
      amounts.some((n) => n >= 1) &&
      Number.isFinite(Number(t.repeatHours || 0)) &&
      Number(t.repeatHours || 0) >= 0 &&
      Number(t.repeatHours || 0) <= 168 &&
      (t.startAt == null || (Number.isFinite(Number(t.startAt)) && Number(t.startAt) > 0 && Number(t.startAt) < Date.now() + 365 * 24 * HOUR_MS))
    );
  }

  IkaDios.automationPlan = {
    MAX_ACTIONS_PER_HOUR,
    MAX_TASK_ERRORS,
    MAX_LOG,
    MIN_WAIT_MS,
    CHECK_MINUTES,
    validCheckMinutes,
    checkIntervalMs,
    DEFAULT_QUIET,
    stateKey,
    emptyState,
    normalize,
    minutesOf,
    inQuietHours,
    quietEndsAt,
    recentActions,
    rateLimitFreeAt,
    headTasks,
    evaluateBuild,
    newTask,
    validTask,
    SHIP_CAPACITY,
    inTransit,
    evaluateTransport,
    newTransportTask,
    validTransportTask,
    randomBetween,
    clampWait,
  };
})(typeof self !== 'undefined' ? self : window);

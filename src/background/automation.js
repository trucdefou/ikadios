// Automation engine (service worker). Runs the user's tasks with the game session,
// one action at a time: a chrome.alarms tick picks the first task that is due,
// refreshes its data from the game and acts only if it still applies. Off by
// default; respects the quiet hours and at most MAX_ACTIONS_PER_HOUR game actions
// (upgrades) per hour. Stops and notifies on a lost session or a captcha.
// State (small) lives in chrome.storage.local `automation:<world>`; the log in
// IndexedDB (`autoLog:<world>`), since it grows with every tick.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const plan = IkaDios.automationPlan;
  const { warn } = IkaDios.util;

  const ALARM = 'ikadios-automation';
  const REFRESH_BUSY_RETRY_MS = 3 * 60000;
  const ERROR_RETRY_MS = 15 * 60000;
  const STEP_PAUSE_MS = [1500, 4000];
  const QUIET_EXTRA_MS = [60000, 20 * 60000];

  let ticking = false;
  let queue = Promise.resolve();

  const logKey = (world) => `autoLog:${world}`;
  const i18n = IkaDios.i18n;

  async function account() {
    return IkaDios.refreshEngine.getAccount();
  }

  async function loadState(world) {
    const key = plan.stateKey(world);
    return plan.normalize((await chrome.storage.local.get(key))[key]);
  }

  // Every change goes through this queue, so ticks and overlay edits do not
  // overwrite each other
  function mutate(world, fn) {
    const run = queue.then(async () => {
      const state = await loadState(world);
      const result = await fn(state);
      state.actionTimes = plan.recentActions(state.actionTimes);
      await chrome.storage.local.set({ [plan.stateKey(world)]: state });
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  async function readLog(world) {
    return (await IkaDios.idb.kvGet(logKey(world))) || [];
  }

  async function log(world, entry) {
    const list = await readLog(world);
    list.unshift({ ts: Date.now(), ...entry });
    await IkaDios.idb.kvSet(logKey(world), list.slice(0, plan.MAX_LOG));
  }

  async function notify(world, id, messageKey, params = {}) {
    try {
      await IkaDios.discord.ensureLocale(world);
      const values = { ...params };
      if (values.buildingType) values.building = i18n.buildingName(values.buildingType);
      chrome.notifications.create(`ikadios:auto-${id}:${Date.now()}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: i18n.t('autoNotifyTitle').slice(0, 100),
        message: i18n.t(messageKey, values).slice(0, 300),
        priority: 1,
      });
    } catch (err) {
      warn('automation notification failed', err);
    }
  }

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---------- Scheduling ----------

  function nextRunAt(state, now = Date.now()) {
    if (!state.enabled || state.stopped) return null;
    const heads = plan.headTasks(state);
    if (!heads.length) return null;
    let at = Math.min(...heads.map((t) => t.waitUntil || 0));
    // A little randomness so ticks never fall on a fixed rhythm
    at = Math.max(at, now + plan.randomBetween(plan.MIN_WAIT_MS * 0.5, plan.MIN_WAIT_MS * 1.5));
    const freeAt = plan.rateLimitFreeAt(state.actionTimes, now);
    if (freeAt) at = Math.max(at, freeAt);
    if (plan.inQuietHours(state.quiet, new Date(at))) at = plan.quietEndsAt(state.quiet, at) + plan.randomBetween(...QUIET_EXTRA_MS);
    return Math.round(at);
  }

  async function schedule(world, state, at = nextRunAt(state)) {
    await chrome.alarms.clear(ALARM);
    if (at) chrome.alarms.create(ALARM, { when: at });
    state.nextAt = at;
  }

  // ---------- Game requests ----------

  const CAPTCHA = /captchaNeeded|id=\\?"captcha\\?"/;

  // Fetches, parses into the snapshot and classifies failures that stop everything
  async function request(acc, params, options) {
    const result = await IkaDios.refreshEngine.requestAndStore(acc, params, options);
    if (!result.ok) return { ...result, fatal: result.error === 'not-logged-in' ? 'session' : null };
    if (CAPTCHA.test(JSON.stringify(result.actions))) return { ok: false, error: 'captcha', fatal: 'captcha' };
    return result;
  }

  // provideFeedback: type 10 is success, 11 an error with the game's text
  function feedback(actions) {
    const items = actions.filter((a) => a[0] === 'provideFeedback').flatMap((a) => (Array.isArray(a[1]) ? a[1] : []));
    if (!items.length) return null;
    const errors = items.filter((f) => Number(f.type) === 11).map((f) => String(f.text || ''));
    return { ok: !errors.length, text: (errors.length ? errors : items.map((f) => String(f.text || ''))).join(' ') };
  }

  async function switchCity(acc, from, to) {
    if (!to || String(from) === String(to)) return { ok: true };
    return request(acc, { action: 'header', function: 'changeCurrentCity', oldView: 'city', cityId: to, backgroundView: 'city', currentCityId: from || to });
  }

  // ---------- Build task ----------

  const taskParams = (task, extra = {}) =>
    task.type === 'transport'
      ? { from: task.fromName, to: task.toName, cargo: task.amounts, ...extra }
      : { building: task.buildingType, city: task.cityName, from: task.fromLevel, to: task.targetLevel, ...extra };

  const WAIT_STATES = new Set(['busy', 'missing', 'noShips', 'satisfied', 'scheduled']);

  function evaluate(task, snapshot, now, state) {
    const interval = plan.checkIntervalMs(state);
    return task.type === 'transport' ? plan.evaluateTransport(task, snapshot, now, interval) : plan.evaluateBuild(task, snapshot, now, interval);
  }

  // Applies an evaluation that needs no game request; true when it was handled
  function applyPassive(task, ev, now) {
    if (ev.state === 'done') {
      task.status = 'done';
      task.lastMessage = { code: 'done', at: now };
      return true;
    }
    if (ev.state === 'error') {
      task.status = 'error';
      task.lastMessage = { code: ev.reason, at: now };
      return true;
    }
    if (WAIT_STATES.has(ev.state)) {
      task.status = 'waiting';
      task.waitUntil = ev.until;
      task.lastMessage = { code: ev.state, at: now, missing: ev.missing || null, until: ev.until };
      return true;
    }
    return false;
  }

  function failTask(task, code, message) {
    task.errors = (task.errors || 0) + 1;
    task.waitUntil = Date.now() + ERROR_RETRY_MS;
    task.lastMessage = { code, at: Date.now(), message: message || null };
    if (task.errors >= plan.MAX_TASK_ERRORS) task.status = 'error';
  }

  // Runs one build task against fresh game data. Returns { fatal } when the
  // whole engine must stop.
  async function runBuild(acc, world, task, state) {
    let snapshot = await IkaDios.refreshEngine.loadSnapshot(acc);
    const original = snapshot.global?.selectedCityId ? String(snapshot.global.selectedCityId) : null;

    const switched = await switchCity(acc, original, task.cityId);
    if (!switched.ok) return handleFailure(world, task, switched);
    await pause(plan.randomBetween(...STEP_PAUSE_MS));

    // The building view brings the city, its resources and the upgrade cost
    const view = await request(acc, { view: task.buildingType, cityId: task.cityId, position: task.position, backgroundView: 'city', currentCityId: task.cityId });
    if (!view.ok) return handleFailure(world, task, view);
    snapshot = view.snapshot;
    task.checkedAt = Date.now();

    const ev = plan.evaluateBuild(task, snapshot, Date.now(), plan.checkIntervalMs(state));
    let outcome = null;
    if (applyPassive(task, ev, Date.now())) {
      outcome = ev.state;
    } else if (ev.state === 'check') {
      // Cost still unknown after reading the view (maximum level, unexpected page)
      failTask(task, 'costUnknown');
      outcome = 'error';
    } else if (plan.rateLimitFreeAt(state.actionTimes)) {
      // Reached when run by hand: the hourly limit also applies then
      task.waitUntil = plan.rateLimitFreeAt(state.actionTimes);
      task.lastMessage = { code: 'rateLimit', at: Date.now(), until: task.waitUntil };
      outcome = 'rateLimit';
    } else {
      await pause(plan.randomBetween(...STEP_PAUSE_MS));
      const level = ev.building.level;
      const res = await request(acc, { action: 'UpgradeExistingBuilding', cityId: task.cityId, position: task.position, level, backgroundView: 'city', currentCityId: task.cityId });
      state.actionTimes.push(Date.now());
      if (!res.ok) return handleFailure(world, task, res);
      const verdict = feedback(res.actions);
      const started = plan.evaluateBuild(task, res.snapshot, Date.now(), plan.checkIntervalMs(state));
      if (verdict?.ok || (!verdict && started.state === 'busy')) {
        task.errors = 0;
        task.status = 'waiting';
        task.waitUntil = started.until || Date.now() + plan.MIN_WAIT_MS;
        task.lastMessage = { code: 'upgradeSent', at: Date.now(), level };
        await log(world, { kind: 'ok', taskId: task.id, code: 'upgradeSent', params: taskParams(task, { level, next: level + 1 }), message: verdict?.text || null });
        await notify(world, task.id, 'autoNotifyUpgrade', { city: task.cityName, buildingType: task.buildingType, level: level + 1 });
        outcome = 'sent';
      } else {
        failTask(task, 'gameError', verdict?.text || null);
        await log(world, { kind: 'error', taskId: task.id, code: 'gameError', params: taskParams(task), message: verdict?.text || null });
        outcome = 'error';
      }
    }

    // Back to the city the player had selected
    if (original && original !== task.cityId) {
      await pause(plan.randomBetween(...STEP_PAUSE_MS));
      await switchCity(acc, task.cityId, original);
    }
    return { outcome };
  }

  async function handleFailure(world, task, res) {
    if (res.fatal) return { fatal: res.fatal };
    failTask(task, 'requestFailed', res.error);
    await log(world, { kind: 'error', taskId: task.id, code: 'requestFailed', params: taskParams(task), message: res.error });
    return { outcome: 'error' };
  }

  // ---------- Transport task ----------

  const CARGO_FIELDS = { wood: 'cargo_resource', wine: 'cargo_tradegood1', marble: 'cargo_tradegood2', glass: 'cargo_tradegood3', sulfur: 'cargo_tradegood4' };

  function formValue(actions, name) {
    const html = actions.find((a) => a[0] === 'changeView')?.[1]?.[1];
    const input = typeof html === 'string' ? new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)?.[0] : null;
    return input ? /value="([^"]*)"/.exec(input)?.[1] ?? null : null;
  }

  // Same fields the game's transport form posts (fixtures/actions/actions.json)
  function transportParams(task, islandId, cargo, ships, freeShips) {
    const params = {
      action: 'transportOperations',
      function: 'loadTransportersWithFreight',
      destinationCityId: task.toCityId,
      islandId,
      oldView: '',
      position: '',
      avatar2Name: '',
      city2Name: '',
      type: '',
      activeTab: '',
      transportDisplayPrice: 0,
      premiumTransporter: 0,
      normalTransportersMax: freeShips ?? ships,
      usedFreightersShips: 0,
    };
    for (const [r, field] of Object.entries(CARGO_FIELDS)) params[field] = cargo[r] || 0;
    Object.assign(params, { capacity: 5, max_capacity: 5, jetPropulsion: 0, transporters: ships, backgroundView: 'city', currentCityId: task.fromCityId, templateView: 'transport' });
    return params;
  }

  // Fill mode first reads the destination and the movements (cargo on the way),
  // then everything goes from the origin city's transport window
  async function runTransport(acc, world, task, state) {
    let snapshot = await IkaDios.refreshEngine.loadSnapshot(acc);
    const original = snapshot.global?.selectedCityId ? String(snapshot.global.selectedCityId) : null;
    let current = original;
    const step = () => pause(plan.randomBetween(...STEP_PAUSE_MS));

    if (task.mode === 'fill') {
      const toDest = await switchCity(acc, current, task.toCityId);
      if (!toDest.ok) return handleFailure(world, task, toDest);
      current = task.toCityId;
      await step();
      const advisor = await request(acc, { view: 'militaryAdvisor', backgroundView: 'city', currentCityId: current });
      if (!advisor.ok) return handleFailure(world, task, advisor);
      await step();
    }
    const toOrigin = await switchCity(acc, current, task.fromCityId);
    if (!toOrigin.ok) return handleFailure(world, task, toOrigin);
    current = task.fromCityId;
    await step();

    const view = await request(acc, { view: 'transport', destinationCityId: task.toCityId, templateView: 'port', currentTab: 'tabSendTransporter', backgroundView: 'city', currentCityId: task.fromCityId });
    if (!view.ok) return handleFailure(world, task, view);
    snapshot = view.snapshot;
    task.checkedAt = Date.now();

    const ev = evaluate(task, snapshot, Date.now(), state);
    const islandId = formValue(view.actions, 'islandId');
    let outcome = null;
    if (applyPassive(task, ev, Date.now())) {
      outcome = ev.state;
    } else if (ev.state !== 'ready') {
      failTask(task, 'dataUnknown');
      outcome = 'error';
    } else if (!/^\d+$/.test(String(islandId))) {
      failTask(task, 'formMissing');
      outcome = 'error';
    } else if (plan.rateLimitFreeAt(state.actionTimes)) {
      task.waitUntil = plan.rateLimitFreeAt(state.actionTimes);
      task.lastMessage = { code: 'rateLimit', at: Date.now(), until: task.waitUntil };
      outcome = 'rateLimit';
    } else {
      await step();
      const res = await request(acc, transportParams(task, islandId, ev.cargo, ev.ships, snapshot.global?.freeTransporters), { post: true });
      state.actionTimes.push(Date.now());
      if (!res.ok) return handleFailure(world, task, res);
      const verdict = feedback(res.actions);
      if (verdict?.ok) {
        const now = Date.now();
        task.errors = 0;
        task.lastSentAt = now;
        task.lastMessage = { code: 'transportSent', at: now, cargo: ev.cargo, ships: ev.ships };
        if (task.repeatHours > 0) task.waitUntil = now + task.repeatHours * 3600000;
        else if (task.mode === 'fill') task.waitUntil = now + plan.checkIntervalMs(state);
        else task.status = 'done';
        await log(world, { kind: 'ok', taskId: task.id, code: 'transportSent', params: taskParams(task, { cargo: ev.cargo, ships: ev.ships }), message: verdict.text || null });
        await notify(world, task.id, 'autoNotifyTransport', { from: task.fromName, to: task.toName, ships: ev.ships });
        outcome = 'sent';
      } else {
        failTask(task, 'gameError', verdict?.text || null);
        await log(world, { kind: 'error', taskId: task.id, code: 'transportError', params: taskParams(task), message: verdict?.text || null });
        outcome = 'error';
      }
    }

    if (original && original !== current) {
      await step();
      await switchCity(acc, current, original);
    }
    return { outcome };
  }

  async function runTask(acc, world, task, state) {
    const result = task.type === 'transport' ? await runTransport(acc, world, task, state) : await runBuild(acc, world, task, state);
    if (result.fatal) {
      state.stopped = { reason: result.fatal, at: Date.now() };
      await log(world, { kind: 'stop', code: `stopped_${result.fatal}` });
      await notify(world, 'stop', `autoStopped_${result.fatal}`);
    }
    return result;
  }

  // "Run now" from the overlay: this task only, right away, even with automations
  // off or in quiet hours (it is the player's click); the hourly limit still applies
  async function runNow(world, id) {
    if (ticking) return { ok: false, error: 'busy' };
    if (IkaDios.refreshEngine.isRunning()) return { ok: false, error: 'refreshing' };
    ticking = true;
    try {
      const acc = await account();
      return await mutate(world, async (state) => {
        const task = state.tasks.find((t) => t.id === id);
        if (!task || task.status === 'done') return { ok: false, error: 'not-found' };
        const wasInactive = task.status === 'paused';
        // Run now sends a scheduled transport immediately
        if (task.type === 'transport' && task.startAt > Date.now()) task.startAt = null;
        Object.assign(task, { status: 'waiting', errors: 0, waitUntil: 0 });
        state.stopped = null;
        await log(world, { kind: 'info', taskId: task.id, code: 'runNow', params: taskParams(task) });
        const result = await runTask(acc, world, task, state);
        // A manual run does not switch an inactive task on
        if (wasInactive && task.status === 'waiting') task.status = 'paused';
        await schedule(world, state);
        return { ok: !result.fatal, outcome: result.outcome || null, error: result.fatal || null };
      });
    } finally {
      ticking = false;
    }
  }

  // ---------- Tick ----------

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const acc = await account();
      if (!acc?.world) return;
      const world = acc.world;
      await mutate(world, async (state) => {
        const now = Date.now();
        if (!state.enabled || state.stopped) return schedule(world, state);
        if (plan.inQuietHours(state.quiet) || plan.rateLimitFreeAt(state.actionTimes, now)) return schedule(world, state);
        if (IkaDios.refreshEngine.isRunning()) return schedule(world, state, now + REFRESH_BUSY_RETRY_MS);

        state.lastRunAt = now;
        const snapshot = await IkaDios.refreshEngine.loadSnapshot(acc);
        let chosen = null;
        for (const task of plan.headTasks(state)) {
          if ((task.waitUntil || 0) > now) continue;
          const ev = evaluate(task, snapshot, now, state);
          // Waiting by the snapshot is trusted for one check interval; older data
          // is checked against the game
          const stale = now - (task.checkedAt || 0) >= plan.checkIntervalMs(state);
          if (WAIT_STATES.has(ev.state) && ev.state !== 'scheduled' && stale) {
            chosen = chosen || task;
            continue;
          }
          if (applyPassive(task, ev, now)) {
            if (ev.state === 'done') await log(world, { kind: 'ok', taskId: task.id, code: 'done', params: taskParams(task) });
            if (ev.state === 'error') await log(world, { kind: 'error', taskId: task.id, code: ev.reason, params: taskParams(task) });
            continue;
          }
          chosen = chosen || task;
        }

        if (chosen) await runTask(acc, world, chosen, state);
        return schedule(world, state);
      });
    } catch (err) {
      warn('automation tick failed', err);
    } finally {
      ticking = false;
    }
  }

  // ---------- Messages from the overlay ----------

  async function handle(msg) {
    const acc = await account();
    if (!acc?.world) return { ok: false, error: 'no-account' };
    const world = acc.world;

    if (msg.type === 'ikadios:autoGet') {
      return { ok: true, world, state: await loadState(world), log: await readLog(world) };
    }
    if (msg.type === 'ikadios:autoRunNow') return runNow(world, msg.id);
    if (msg.type === 'ikadios:autoClearLog') {
      await IkaDios.idb.kvSet(logKey(world), []);
      return { ok: true };
    }

    return mutate(world, async (state) => {
      if (msg.type === 'ikadios:autoSet') {
        const patch = msg.patch || {};
        if (typeof patch.enabled === 'boolean') {
          state.enabled = patch.enabled;
          if (patch.enabled) state.stopped = null;
          await log(world, { kind: 'info', code: patch.enabled ? 'enabled' : 'disabled' });
        }
        if (patch.quiet && typeof patch.quiet === 'object') {
          const q = { ...state.quiet };
          if (typeof patch.quiet.enabled === 'boolean') q.enabled = patch.quiet.enabled;
          if (plan.minutesOf(patch.quiet.from) != null) q.from = patch.quiet.from;
          if (plan.minutesOf(patch.quiet.to) != null) q.to = patch.quiet.to;
          state.quiet = q;
        }
        if (plan.validCheckMinutes(patch.checkMinutes)) {
          state.checkMinutes = Number(patch.checkMinutes);
          // Pending waits longer than the new interval are shortened
          const limit = Date.now() + plan.checkIntervalMs(state);
          for (const t of state.tasks) if ((t.waitUntil || 0) > limit) t.waitUntil = limit;
        }
      } else if (msg.type === 'ikadios:autoStop') {
        state.enabled = false;
        await log(world, { kind: 'stop', code: 'stoppedByUser' });
      } else if (msg.type === 'ikadios:autoAddTask' && msg.task?.type === 'transport') {
        if (!plan.validTransportTask(msg.task)) return { ok: false, error: 'invalid' };
        const task = plan.newTransportTask(msg.task);
        state.tasks.push(task);
        await log(world, { kind: 'info', taskId: task.id, code: 'transportAdded', params: taskParams(task) });
        await schedule(world, state);
        return { ok: true, id: task.id };
      } else if (msg.type === 'ikadios:autoAddTask') {
        if (!plan.validTask(msg.task)) return { ok: false, error: 'invalid' };
        const dup = state.tasks.some(
          (t) => t.cityId === String(msg.task.cityId) && t.position === Number(msg.task.position) && t.status !== 'done' && t.status !== 'error'
        );
        if (dup) return { ok: false, error: 'duplicate' };
        const task = plan.newTask(msg.task);
        state.tasks.push(task);
        await log(world, { kind: 'info', taskId: task.id, code: 'taskAdded', params: taskParams(task) });
        await schedule(world, state);
        return { ok: true, id: task.id };
      } else if (msg.type === 'ikadios:autoTask') {
        const i = state.tasks.findIndex((t) => t.id === msg.id);
        if (i < 0) return { ok: false, error: 'not-found' };
        const task = state.tasks[i];
        if (msg.op === 'remove') state.tasks.splice(i, 1);
        else if (msg.op === 'pause') task.status = 'paused';
        else if (msg.op === 'set' && task.type === 'build') {
          const level = Number(msg.targetLevel);
          if (!Number.isInteger(level) || level <= task.fromLevel || level > 100) return { ok: false, error: 'invalid' };
          Object.assign(task, { targetLevel: level, status: msg.active ? 'waiting' : 'paused', errors: 0, waitUntil: 0 });
          await log(world, { kind: 'info', taskId: task.id, code: 'taskChanged', params: taskParams(task) });
        }
        else if (msg.op === 'resume' || msg.op === 'retry') Object.assign(task, { status: 'waiting', errors: 0, waitUntil: 0 });
        else if (msg.op === 'up' || msg.op === 'down') {
          // Swap with the previous / next task of the same city
          const step = msg.op === 'up' ? -1 : 1;
          let j = i + step;
          while (j >= 0 && j < state.tasks.length && state.tasks[j].cityId !== task.cityId) j += step;
          if (j >= 0 && j < state.tasks.length) [state.tasks[i], state.tasks[j]] = [state.tasks[j], state.tasks[i]];
        } else if (msg.op === 'clearDone') {
          state.tasks = state.tasks.filter((t) => t.status !== 'done');
        }
      } else {
        return undefined;
      }
      await schedule(world, state);
      return { ok: true };
    });
  }

  const TYPES = new Set(['ikadios:autoGet', 'ikadios:autoSet', 'ikadios:autoStop', 'ikadios:autoAddTask', 'ikadios:autoTask', 'ikadios:autoRunNow', 'ikadios:autoClearLog']);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!TYPES.has(msg?.type) || sender.id !== chrome.runtime.id) return undefined;
    handle(msg)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) tick();
  });

  // Alarms can be lost when the browser restarts: restore the schedule
  async function init() {
    const acc = await account();
    if (!acc?.world) return;
    const state = await loadState(acc.world);
    if (state.enabled && !state.stopped && !(await chrome.alarms.get(ALARM))) {
      await mutate(acc.world, (s) => schedule(acc.world, s));
    }
  }

  IkaDios.automation = { init, tick };
})(self);

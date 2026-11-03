// Refresh engine (service worker). Loads game views with the user's session
// cookies, so it works with or without a game tab open. Runs on a user click
// ("Refresh all") or on the auto schedule (chrome.alarms). Responses go through
// the same parsers as passive capture; the snapshot is re-read and saved after
// every step so a game tab writing at the same time does not lose data.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { warn } = IkaDios.util;
  const plan = IkaDios.refreshPlan;

  const KEY_SETTINGS = 'settings';
  const KEY_LAST_ACCOUNT = 'lastAccount';
  const ALARM_AUTO = 'ikadios-auto';
  const WRITER = 'bg';

  const DEFAULT_AUTO_MINUTES = 30;
  const MIN_AUTO_MINUTES = 10;
  const AUTO_JITTER = 0.3;
  const AUTO_FIRST_DELAY_MS = [20000, 90000];
  const MAX_FAILURES_IN_A_ROW = 3;
  const FETCH_TIMEOUT_MS = 20000;
  const KEEPALIVE_MS = 10000;

  let running = null;

  const statusKey = (world) => `refreshStatus:${world}`;
  const tokenKey = (world) => `token:${world}`;
  const snapKey = (account) => `snap:${account.world}:${account.avatarId ?? 'unknown'}`;

  async function getSettings() {
    return (await chrome.storage.local.get(KEY_SETTINGS))[KEY_SETTINGS] || {};
  }

  async function getAccount() {
    return (await chrome.storage.local.get(KEY_LAST_ACCOUNT))[KEY_LAST_ACCOUNT] || null;
  }

  async function getStatus(world) {
    return (await chrome.storage.local.get(statusKey(world)))[statusKey(world)] || { status: 'idle' };
  }

  async function setStatus(world, patch) {
    const current = await getStatus(world);
    await chrome.storage.local.set({ [statusKey(world)]: { ...current, ...patch, updatedAt: Date.now() } });
  }

  async function loadSnapshot(account) {
    const stored = (await chrome.storage.local.get(snapKey(account)))[snapKey(account)];
    return IkaDios.schema.migrate(stored) || IkaDios.schema.emptySnapshot({ world: account.world, avatarId: account.avatarId });
  }

  async function saveSnapshot(account, snapshot) {
    await chrome.storage.local.set({ [snapKey(account)]: { ...snapshot, _writer: WRITER } });
  }

  // Sleeps without letting the service worker go idle (extension API calls reset its timer)
  function pause(ms, signal) {
    return new Promise((resolve) => {
      const end = Date.now() + ms;
      const keepalive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), KEEPALIVE_MS);
      const done = () => {
        clearInterval(keepalive);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, end - Date.now()));
      signal.addEventListener('abort', done, { once: true });
    });
  }

  // Firefox content scripts may not read session storage, so rotated tokens are
  // also pushed to the game tabs directly
  const lastSharedToken = {};
  async function shareToken(world, token) {
    await chrome.storage.session.set({ [tokenKey(world)]: token });
    if (lastSharedToken[world] === token) return;
    lastSharedToken[world] = token;
    const tabs = await chrome.tabs.query({ url: `https://${world}.ikariam.gameforge.com/*` }).catch(() => []);
    for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: 'ikadios:setToken', world, token }).catch(() => {});
  }

  // GET by default; `post` sends the parameters as a form body, like the game's
  // own form submits (transport)
  async function fetchView(account, params, { post = false } = {}) {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) query.set(k, String(v));
    const token = (await chrome.storage.session.get(tokenKey(account.world)))[tokenKey(account.world)];
    if (token) query.set('actionRequest', token);
    query.set('ajax', '1');
    const base = `https://${account.world}.ikariam.gameforge.com/index.php`;
    // The parsers read the request parameters from this URL (no token for POST)
    const url = post ? `${base}?${new URLSearchParams(params)}` : `${base}?${query}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const headers = { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*' };
      if (post) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      const res = await fetch(post ? base : url, {
        method: post ? 'POST' : 'GET',
        body: post ? query.toString() : undefined,
        credentials: 'include',
        headers,
        signal: controller.signal,
      });
      const text = await res.text();
      const tokenMatch = /"actionRequest"\s*:\s*"([^"]+)"/.exec(text);
      // Shared with the game tab, which keeps the game's own copy in sync
      if (tokenMatch) await shareToken(account.world, tokenMatch[1]);
      if (!res.ok) return { ok: false, error: `http-${res.status}` };
      // A login page instead of JSON means the session is gone
      if (text.trimStart()[0] !== '[') return { ok: false, error: 'not-logged-in' };
      return { ok: true, actions: JSON.parse(text).filter((a) => Array.isArray(a) && typeof a[0] === 'string'), url };
    } catch (err) {
      return { ok: false, error: controller.signal.aborted ? 'timeout' : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  // Same capture format as the content bridge, for calibrating parsers

  function scrub(value) {
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = k === 'actionRequest' ? 'x' : scrub(v);
      return out;
    }
    return value;
  }

  async function capture(account, step, result) {
    const settings = await getSettings();
    const entry = { source: 'refresh', kind: 'ajax', view: step.params.view, actions: result.actions };
    if (!IkaDios.captureFilter.shouldCapture(settings, entry)) return;
    await IkaDios.captures.add({
      ts: Date.now(),
      kind: 'ajax',
      source: 'refresh',
      world: account.world,
      view: step.params.view,
      url: result.url.replace(/actionRequest=[^&]*/, 'actionRequest=x'),
      payload: scrub(result.actions),
    });
  }

  // The Chrome service worker has no DOMParser; an offscreen document runs the
  // parsers that need it. Firefox's event page has a DOM and parses in place.
  const parsesInPlace = typeof DOMParser === 'function' || !chrome.offscreen;
  let creatingOffscreen = null;
  async function ensureOffscreen() {
    if (await chrome.offscreen.hasDocument?.()) return;
    if (!creatingOffscreen) {
      creatingOffscreen = chrome.offscreen
        .createDocument({ url: 'offscreen.html', reasons: ['DOM_PARSER'], justification: 'Parse Ikariam view HTML during refresh' })
        .finally(() => {
          creatingOffscreen = null;
        });
    }
    await creatingOffscreen;
  }

  async function parse(snapshot, actions, meta, avatarId) {
    if (!parsesInPlace) {
      try {
        await ensureOffscreen();
        const res = await chrome.runtime.sendMessage({ type: 'ikadios:offscreenParse', snapshot, actions, meta, avatarId });
        if (res?.ok) return res.snapshot;
        warn('offscreen parse failed', res?.error);
      } catch (err) {
        warn('offscreen unavailable', err);
      }
    }
    // In place: the full parser set with a DOM (Firefox), DOM-free parsers otherwise
    let current = parsesInPlace ? IkaDios.schema.migrate(snapshot) || IkaDios.schema.emptySnapshot() : snapshot;
    const ctx = {
      get snapshot() {
        return current;
      },
      avatarId,
    };
    const apply = (patch) => {
      current = typeof patch === 'function' ? patch(current) || current : IkaDios.util.deepMerge(current, patch);
    };
    IkaDios.parsers.parseAjax(actions, ctx, apply, meta);
    return current;
  }

  async function runStep(account, step) {
    const result = await fetchView(account, step.params);
    if (!result.ok) return result;
    await capture(account, step, result);
    let snapshot = await parse(await loadSnapshot(account), result.actions, { url: result.url }, account.avatarId);
    snapshot = IkaDios.util.deepMerge(snapshot, { viewsUpdatedAt: { [step.key]: Date.now() } });
    await saveSnapshot(account, snapshot);
    return { ok: true, snapshot };
  }

  // `scope`: an overlay tab id; only the views behind that tab are loaded
  async function start(trigger = 'manual', scope = null) {
    if (running) return { ok: false, error: 'already-running' };
    const account = await getAccount();
    if (!account?.world) return { ok: false, error: 'no-account' };
    if (scope && !plan.SCOPES[scope]) return { ok: false, error: 'bad-scope' };

    const controller = new AbortController();
    running = { controller, world: account.world };
    await chrome.alarms.clear(ALARM_AUTO);

    let snapshot = await loadSnapshot(account);
    let done = 0;
    let failed = 0;
    let failedInARow = 0;
    const scoped = scope ? plan.scopedSteps(snapshot, scope) : null;
    let total = scoped ? scoped.length : plan.estimateTotal(snapshot);
    let lastError = null;
    const doneKeys = new Set();
    await setStatus(account.world, { status: 'running', trigger, scope, done, total, failed, step: null, error: null, nextAt: null, startedAt: Date.now() });

    const runList = async (steps) => {
      for (const step of steps) {
        if (controller.signal.aborted || failedInARow >= MAX_FAILURES_IN_A_ROW) return;
        await setStatus(account.world, { done, total: Math.max(total, done + 1), step: describe(step) });
        const result = await runStep(account, step);
        if (result.ok) {
          failedInARow = 0;
          snapshot = result.snapshot;
        } else {
          failed += 1;
          failedInARow += 1;
          lastError = result.error;
          warn('refresh step failed', step.key, result.error);
        }
        doneKeys.add(step.key);
        done += 1;
        await pause(plan.nextPauseMs(), controller.signal);
      }
    };

    try {
      if (scoped) {
        await runList(scoped);
      } else {
        // Cities without buildings first: their detail views need building positions
        await runList(plan.phaseA(snapshot));
        const rest = plan.phaseB(snapshot, doneKeys);
        total = done + rest.length;
        await runList(rest);
      }
    } catch (err) {
      lastError = String(err);
      warn('refresh run failed', err);
    } finally {
      running = null;
      const stoppedByErrors = failedInARow >= MAX_FAILURES_IN_A_ROW;
      await setStatus(account.world, {
        status: controller.signal.aborted ? 'cancelled' : stoppedByErrors ? 'error' : 'done',
        done,
        total: done,
        failed,
        step: null,
        error: stoppedByErrors ? lastError : null,
        finishedAt: Date.now(),
      });
      // A run stopped by errors (expired session, captcha) does not reschedule itself
      if (!stoppedByErrors) await scheduleAuto(account.world);
    }
    return { ok: true };
  }

  // Only plain data goes to the status record; the overlay translates it
  function describe(step) {
    return { kind: step.kind, view: step.view || null, cityName: step.cityName || null, islandName: step.islandName || null };
  }

  function cancel() {
    running?.controller.abort();
  }

  async function scheduleAuto(world, firstRun = false) {
    const settings = await getSettings();
    await chrome.alarms.clear(ALARM_AUTO);
    if (!settings.autoRefresh) {
      await setStatus(world, { nextAt: null, auto: false });
      return;
    }
    const minutes = Math.max(MIN_AUTO_MINUTES, Number(settings.autoRefreshMinutes) || DEFAULT_AUTO_MINUTES);
    let delay = minutes * 60000 * (1 - AUTO_JITTER + Math.random() * 2 * AUTO_JITTER);
    if (firstRun) {
      // Run soon when the last run is older than one interval
      const { finishedAt = 0 } = await getStatus(world);
      const since = Date.now() - finishedAt;
      delay = since >= minutes * 60000 ? plan.randomBetween(...AUTO_FIRST_DELAY_MS) : minutes * 60000 - since;
    }
    const nextAt = Date.now() + delay;
    chrome.alarms.create(ALARM_AUTO, { when: nextAt });
    await setStatus(world, { nextAt, auto: true });
  }

  async function init() {
    // Lets the content script share the CSRF token through session storage
    // (Chrome and Brave; Firefox has no setAccessLevel and uses ikadios:tokenSet)
    await chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});

    // Leftover from the earlier in-tab refresh
    await chrome.storage.local.remove('refreshLock');

    // A worker restart drops an in-flight run; do not leave it shown as running
    const account = await getAccount();
    if (account?.world && !running) {
      const status = await getStatus(account.world);
      if (status.status === 'running') await setStatus(account.world, { status: 'cancelled', step: null });
      // Alarms can be dropped when the browser restarts; restore the auto schedule
      const settings = await getSettings();
      if (settings.autoRefresh && !(await chrome.alarms.get(ALARM_AUTO))) await scheduleAuto(account.world, true);
    }
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_AUTO) start('auto');
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes[KEY_SETTINGS]) return;
    const before = changes[KEY_SETTINGS].oldValue || {};
    const after = changes[KEY_SETTINGS].newValue || {};
    if (before.autoRefresh === after.autoRefresh && before.autoRefreshMinutes === after.autoRefreshMinutes) return;
    const account = await getAccount();
    if (account?.world && !running) scheduleAuto(account.world, true);
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'ikadios:refreshStart') {
      start('manual', typeof msg.scope === 'string' ? msg.scope : null).then(sendResponse);
      return true;
    }
    if (msg?.type === 'ikadios:tokenSet') {
      if (sender.id === chrome.runtime.id && typeof msg.world === 'string' && typeof msg.token === 'string') {
        chrome.storage.session.set({ [tokenKey(msg.world)]: msg.token }).catch(() => {});
      }
      return undefined;
    }
    if (msg?.type === 'ikadios:refreshCancel') {
      cancel();
      sendResponse({ ok: true });
    }
    return undefined;
  });

  // Shared with the automation engine, which uses the same session and parsers
  async function requestAndStore(account, params, options) {
    const result = await fetchView(account, params, options);
    if (!result.ok) return result;
    const snapshot = await parse(await loadSnapshot(account), result.actions, { url: result.url }, account.avatarId);
    await saveSnapshot(account, snapshot);
    return { ok: true, actions: result.actions, snapshot };
  }

  IkaDios.refreshEngine = {
    init,
    start,
    cancel,
    scheduleAuto,
    getAccount,
    loadSnapshot,
    saveSnapshot,
    requestAndStore,
    fetchView,
    isRunning: () => !!running,
  };
})(self);

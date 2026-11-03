// Receives messages from the MAIN-world hook, feeds the parsers, writes the store
// and records raw captures that pass the capture filter (capture-filter.js).
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { MESSAGE_SOURCE, warn } = IkaDios.util;
  const { store, parsers } = IkaDios;

  const lastActions = [];
  const LAST_ACTIONS_MAX = 30;

  // Current settings; the capture filter decides per response (capture-filter.js)
  let settings = {};
  const wants = (entry) => IkaDios.captureFilter.shouldCapture(settings, { source: 'tab', ...entry });
  let avatarId = null;
  let world = null;

  const ctx = {
    get snapshot() {
      return store.get();
    },
    get avatarId() {
      return avatarId;
    },
  };

  // Removes CSRF tokens anywhere in a payload before it is stored
  function scrub(value) {
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = k === 'actionRequest' ? 'x' : scrub(v);
      return out;
    }
    return value;
  }

  async function onModel(model) {
    if (model?.avatarId != null) avatarId = String(model.avatarId);
    await store.load(world, avatarId);
    const { raw, ...mapped } = model || {};
    parsers.parseModel(mapped, ctx, store.update);
    if (wants({ kind: 'model' })) store.appendDebugCapture({ ts: Date.now(), kind: 'model', world, payload: scrub(model) });
  }

  async function onAjax(actions, meta) {
    if (!store.get()) await store.load(world, avatarId);
    const { view } = parsers.parseAjax(actions, ctx, store.update, meta);
    lastActions.push({ ts: Date.now(), view, actions: actions.map((a) => a[0]) });
    if (lastActions.length > LAST_ACTIONS_MAX) lastActions.shift();
    if (wants({ kind: 'ajax', view, actions })) {
      store.appendDebugCapture({ ts: Date.now(), kind: 'ajax', world, view, url: meta.url, body: meta.body, payload: scrub(actions) });
    }
  }

  function onMessage(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== MESSAGE_SOURCE || data.direction !== 'page') return;
    if (!IkaDios.util.extensionAlive()) return;
    if (data.kind === 'token') {
      saveToken(data.payload);
      return;
    }
    if (data.kind === 'json') {
      if (IkaDios.parsers.world.isWorldMapResponse(data) && IkaDios.util.extensionAlive()) {
        const islands = IkaDios.parsers.world.worldMapIslands(data.payload?.data);
        chrome.runtime.sendMessage({ type: 'ikadios:islandNames', world, islands }).catch(() => {});
      }
      if (wants({ kind: 'json' })) store.appendDebugCapture({ ts: Date.now(), kind: 'json', world, url: data.url, body: data.body, payload: scrub(data.payload) });
      return;
    }
    const task = data.kind === 'model' ? onModel(data.payload) : data.kind === 'ajax' ? onAjax(data.payload, data) : null;
    task?.catch((err) => warn('bridge failed', data.kind, err));
  }

  // The token lives in session storage (cleared when the browser closes) and is
  // shared with the background refresh engine in both directions
  const tokenKey = () => `token:${world}`;
  let lastToken = null;

  function saveToken(token) {
    if (!token || token === lastToken) return;
    lastToken = token;
    // Firefox content scripts may lack session storage: the worker stores it then
    const viaWorker = () => chrome.runtime.sendMessage({ type: 'ikadios:tokenSet', world, token }).catch((err) => warn('token save failed', err));
    if (!chrome.storage.session) viaWorker();
    else chrome.storage.session.set({ [tokenKey()]: token }).catch(viaWorker);
  }

  function pushToken(token) {
    if (!token || token === lastToken) return;
    lastToken = token;
    window.postMessage({ source: MESSAGE_SOURCE, direction: 'content', kind: 'setToken', payload: token }, location.origin);
  }

  function watchToken() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'session' && changes[tokenKey()]) pushToken(changes[tokenKey()].newValue);
    });
    // Sent by the worker as well, for browsers where the event above never fires
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (msg?.type === 'ikadios:setToken' && sender.id === chrome.runtime.id && msg.world === world) pushToken(msg.token);
      return undefined;
    });
  }

  async function init({ world: w }) {
    world = w;
    watchToken();
    settings = (await chrome.storage.local.get('settings')).settings || {};
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) settings = changes.settings.newValue || {};
    });
    window.addEventListener('message', onMessage);
  }

  // Asks the hook to resend the model (used after the listener is installed late)
  function requestModel() {
    window.postMessage({ source: MESSAGE_SOURCE, direction: 'content', kind: 'requestModel' }, location.origin);
  }

  IkaDios.bridge = { init, requestModel, lastActions: () => lastActions.slice(), debugEnabled: () => wants({ kind: 'styleProbe' }) };
})(typeof self !== 'undefined' ? self : window);

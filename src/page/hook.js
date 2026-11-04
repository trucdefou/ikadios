// Runs in the page (MAIN world) at document_start. Passively observes the game's
// own AJAX responses and the global `ikariam` model, and forwards copies to the
// isolated content script via window.postMessage. It never alters requests or
// responses and never issues requests of its own.
(function () {
  'use strict';

  const SOURCE = 'ikadios';
  let lastSelectedCity = null;
  const feedbackWaiters = [];
  const FEEDBACK_WAIT_MS = 10000;

  // Resolves with the game's feedback to the next action, or null on timeout
  // (e.g. the game's own form check stopped the request before it was sent)
  function nextFeedback() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = feedbackWaiters.indexOf(done);
        if (i >= 0) feedbackWaiters.splice(i, 1);
        resolve(null);
      }, FEEDBACK_WAIT_MS);
      function done(result) {
        clearTimeout(timer);
        resolve(result);
      }
      feedbackWaiters.push(done);
    });
  }
  const MODEL_POLL_MS = 500;
  const MODEL_POLL_MAX_TRIES = 120;

  function post(kind, payload, extra = {}) {
    try {
      window.postMessage({ source: SOURCE, direction: 'page', kind, payload, ts: Date.now(), ...extra }, location.origin);
    } catch (err) {
      // Payloads with functions or DOM nodes cannot be cloned; drop them silently
      console.warn('[IkaDios] postMessage failed', kind, err);
    }
  }

  function isGameEndpoint(url) {
    try {
      const u = new URL(url, location.href);
      // The game calls both "/index.php?..." and "/?view=..."
      return u.origin === location.origin && (u.pathname === '/' || u.pathname.endsWith('/index.php'));
    } catch {
      return false;
    }
  }

  // Drops the CSRF token so it never ends up in storage or debug captures
  function stripToken(params) {
    if (!params) return null;
    return String(params).replace(/(^|[&?])actionRequest=[^&]*/g, '$1actionRequest=x');
  }

  function handleResponseText(url, text, body = null) {
    if (!text || (text[0] !== '[' && text[0] !== '{')) return;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }
    // Ikariam answers with an array of [actionName, payload] pairs. Other JSON
    // (world map areas, movement lists) is forwarded for debug captures.
    if (!Array.isArray(data)) {
      post('json', data, { url: stripToken(url), body: stripToken(body) });
      return;
    }
    const actions = data.filter((entry) => Array.isArray(entry) && typeof entry[0] === 'string');
    // Selected city as the server reports it (most reliable after a city change)
    for (const [name, payload] of actions) {
      const selected = name === 'updateGlobalData' && payload?.headerData?.cityDropdownMenu?.selectedCity;
      if (selected) lastSelectedCity = String(selected).replace('city_', '');
    }
    // Game verdict on an action: provideFeedback [{text, type}], type 10 ok, 11 error
    const feedback = actions.find((a) => a[0] === 'provideFeedback')?.[1];
    if (Array.isArray(feedback) && feedbackWaiters.length) {
      const errors = feedback.filter((f) => Number(f?.type) === 11).map((f) => String(f.text || ''));
      const messages = feedback.map((f) => String(f?.text || ''));
      for (const resolve of feedbackWaiters.splice(0)) resolve({ ok: !errors.length, errors, messages });
    }
    if (actions.length) post('ajax', actions, { url: stripToken(url), body: stripToken(body) });
    // The world map may have just been opened through the game's AJAX loader
    // (cheap when it is not: patchWorldmap returns at once without window.worldmap)
    setTimeout(patchWorldmap, 300);
    const tokenMatch = /"actionRequest"\s*:\s*"([^"]+)"/.exec(text);
    if (tokenMatch) reportToken(tokenMatch[1]);
  }

  // --- XMLHttpRequest (jQuery, used by the game) ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ikadiosUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (isGameEndpoint(this.__ikadiosUrl)) {
      const requestBody = typeof body === 'string' ? body : null;
      this.addEventListener('load', () => {
        if (this.responseType && this.responseType !== 'text') return;
        handleResponseText(this.__ikadiosUrl, this.responseText, requestBody);
      });
    }
    return origSend.call(this, body);
  };

  // --- fetch (not used by the game today, observed for robustness) ---
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    const promise = origFetch.apply(this, arguments);
    if (isGameEndpoint(url)) {
      promise
        .then((res) => res.clone().text())
        .then((text) => handleResponseText(url, text, typeof init?.body === 'string' ? init.body : null))
        .catch(() => {});
    }
    return promise;
  };

  // --- Initial model snapshot (full page loads) ---
  function pickModel() {
    const ik = window.ikariam;
    if (!ik || !ik.model) return null;
    const m = ik.model;
    const screenData = ik.backgroundView?.screen?.data;
    return {
      avatarId: m.avatarId ?? null,
      avatarAllyId: m.avatarAllyId ?? null,
      serverName: m.serverName ?? null,
      serverTime: m.serverTime ?? null,
      relatedCityData: m.relatedCityData ?? null,
      headerData: {
        gold: m.gold,
        income: m.income,
        upkeep: m.upkeep,
        scientistsUpkeep: m.scientistsUpkeep,
        godGoldResult: m.godGoldResult,
        wineSpendings: m.wineSpendings,
        currentResources: m.currentResources,
        maxResources: m.maxResources,
        resourceProduction: m.resourceProduction,
        tradegoodProduction: m.tradegoodProduction,
        producedTradegood: m.producedTradegood,
        freeTransporters: m.freeTransporters,
        maxTransporters: m.maxTransporters,
        freeFreighters: m.freeFreighters,
        maxFreighters: m.maxFreighters,
        maxActionPoints: m.maxActionPoints,
        ambrosia: m.ambrosia,
        advisorData: m.advisorData,
      },
      backgroundView: ik.backgroundView?.id ?? null,
      backgroundData: screenData ?? null,
      // Full model for debug captures, to discover fields not mapped above
      raw: cloneable(m),
    };
  }

  function cloneable(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return null;
    }
  }

  // CSRF token: reported to the content script (shared with the background refresh)
  // and updated from it, so the game's next request always carries a valid one
  let lastToken = null;
  function reportToken(token) {
    if (!token || token === lastToken) return;
    lastToken = token;
    post('token', token);
  }

  const CARGO_FIELDS = { wood: 'textfield_wood', wine: 'textfield_wine', marble: 'textfield_marble', glass: 'textfield_glass', sulfur: 'textfield_sulfur' };
  const FORM_WAIT_MS = 12000;

  function waitFor(check, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const value = check();
        if (value) resolve(value);
        else if (Date.now() - start > timeoutMs) resolve(null);
        else setTimeout(tick, 200);
      };
      tick();
    });
  }

  // Last selected city reported by the server (updated by handleResponseText),
  // falling back to the game model on a fresh page load
  function selectedCityId() {
    return lastSelectedCity || String(window.ikariam?.model?.relatedCityData?.selectedCity || '').replace('city_', '');
  }

  // Switches the game's current city with the game's own header action (the
  // transport window always sends from the current city)
  async function switchCity(cityId) {
    if (selectedCityId() === String(cityId)) return true;
    const token = window.ikariam?.model?.actionRequest;
    if (!token) return false;
    const current = selectedCityId();
    window.ajaxHandlerCall(
      `?action=header&function=changeCurrentCity&actionRequest=${token}&oldView=city&cityId=${cityId}&backgroundView=city&currentCityId=${current}`
    );
    return !!(await waitFor(() => selectedCityId() === String(cityId), FORM_WAIT_MS));
  }

  function cargoList(amounts) {
    return Object.entries(amounts || {}).filter(([r, n]) => CARGO_FIELDS[r] && Number.isInteger(n) && n > 0);
  }

  // Types the amounts into the open transport form, firing the events the game's
  // sliders and ship counter listen to. Returns what the game kept (it may cap).
  function fillCargo(cargo) {
    const $ = window.jQuery;
    for (const [resource, amount] of cargo) {
      const input = document.getElementById(CARGO_FIELDS[resource]);
      if (!input) return null;
      input.value = String(amount);
      if ($) $(input).trigger('keyup').trigger('change');
      else {
        input.dispatchEvent(new Event('keyup', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    return Object.fromEntries(cargo.map(([r]) => [r, Number(document.getElementById(CARGO_FIELDS[r])?.value || 0)]));
  }

  function transportFormFor(to) {
    const f = document.getElementById('transportForm');
    return f && f.querySelector('input[name="destinationCityId"]')?.value === String(to) ? f : null;
  }

  async function transportPrefill({ to, amounts }) {
    if (!/^\d+$/.test(String(to))) return { ok: false, error: 'invalid' };
    const cargo = cargoList(amounts);
    if (!cargo.length) return { ok: false, error: 'empty' };
    // The game must be ready before its window can be opened
    const ready = await waitFor(() => typeof window.ajaxHandlerCall === 'function' && selectedCityId(), FORM_WAIT_MS);
    if (!ready) return { ok: false, error: 'invalid' };
    // Origin and destination cannot be the same city
    if (selectedCityId() === String(to)) return { ok: false, error: 'sameCity' };
    if (!transportFormFor(to)) {
      window.ajaxHandlerCall(`?view=transport&destinationCityId=${to}&templateView=port&currentTab=tabSendTransporter`);
    }
    const form = await waitFor(() => transportFormFor(to), FORM_WAIT_MS);
    if (!form) return { ok: false, error: 'form' };
    const kept = fillCargo(cargo);
    return kept ? { ok: true, kept, from: selectedCityId() } : { ok: false, error: 'field' };
  }

  // The game only accepts building actions in the current city ("Access denied"
  // otherwise), so switch to it first; upgrades report the game's verdict
  async function buildingAction({ action, cityId, position, level }) {
    const ids = [cityId, position, level].map(String);
    if (!ids.every((v) => /^\d+$/.test(v)) || typeof window.ajaxHandlerCall !== 'function') return { ok: false, error: 'unavailable', action };
    const [c, p, l] = ids;
    if (!(await switchCity(c))) return { ok: false, error: 'cityChange', action };
    const token = window.ikariam?.model?.actionRequest;
    if (!token) return { ok: false, error: 'unavailable', action };
    if (action === 'demolish') {
      // Opens the game's own confirmation window; the player confirms there
      window.ajaxHandlerCall(`?view=buildings_demolition&cityId=${c}&position=${p}&level=${l}&actionRequest=${token}&templatePosition=${p}`);
      return { ok: true, action };
    }
    if (action !== 'upgrade') return { ok: false, error: 'unavailable', action };
    const verdict = nextFeedback();
    window.ajaxHandlerCall(`?action=UpgradeExistingBuilding&actionRequest=${token}&cityId=${c}&position=${p}&level=${l}&backgroundView=city&currentCityId=${c}`);
    const result = await verdict;
    if (!result) return { ok: false, error: 'noAnswer', action };
    return { ok: result.ok, error: result.ok ? null : 'game', message: (result.ok ? result.messages : result.errors).join(' '), action };
  }

  async function openIslandAt({ x, y }) {
    if (![x, y].every((n) => Number.isInteger(n) && n >= 0 && n <= 100) || typeof window.ajaxHandlerCall !== 'function') return;
    const url = `/index.php?action=WorldMap&function=getJSONArea&x_min=${x - 1}&x_max=${x + 1}&y_min=${y - 1}&y_max=${y + 1}`;
    try {
      const res = await origFetch.call(window, url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      const text = await res.text();
      // Forwarded like any world map response, so the island names get stored too
      handleResponseText(url, text);
      const id = JSON.parse(text)?.data?.[x]?.[y]?.[0];
      if (/^\d+$/.test(String(id))) window.ajaxHandlerCall(`?view=island&islandId=${id}`);
    } catch (err) {
      console.warn('[IkaDios] island lookup failed', err);
    }
  }

  async function transportClose({ to }) {
    if (!/^\d+$/.test(String(to))) return { ok: false };
    // The window may take a moment to appear after the page loads
    const form = await waitFor(() => transportFormFor(to), FORM_WAIT_MS);
    if (!form) return { ok: true, closed: false };
    const win = form.closest('.templateView, .mainContentBox') || document;
    const close = win.querySelector('.mainHeader .close, .close');
    if (close) close.click();
    return { ok: true, closed: !!close };
  }

  async function transportSend({ from, to, amounts }) {
    const ids = [from, to].map(String);
    if (!ids.every((v) => /^\d+$/.test(v)) || typeof window.ajaxHandlerCall !== 'function') return { ok: false, error: 'invalid' };
    const cargo = cargoList(amounts);
    if (!cargo.length) return { ok: false, error: 'empty' };
    if (String(from) === String(to)) return { ok: false, error: 'sameCity' };

    if (!(await switchCity(from))) return { ok: false, error: 'cityChange' };
    window.ajaxHandlerCall(`?view=transport&destinationCityId=${to}&templateView=port&currentTab=tabSendTransporter`);
    // The form must belong to this origin and destination before anything is filled
    const form = await waitFor(() => {
      const f = document.getElementById('transportForm');
      if (!f) return null;
      const dest = f.querySelector('input[name="destinationCityId"]')?.value;
      // The origin is the game's selected city (city1Id sits in another form of the window)
      const origin = selectedCityId() || document.querySelector('input[name="city1Id"]')?.value;
      return origin === String(from) && dest === String(to) ? f : null;
    }, FORM_WAIT_MS);
    if (!form) return { ok: false, error: 'form' };

    const kept = fillCargo(cargo);
    if (!kept) return { ok: false, error: 'field' };
    const button = document.getElementById('submit');
    if (!button) return { ok: false, error: 'button' };
    const verdict = nextFeedback();
    button.click();
    const result = await verdict;
    if (!result) return { ok: false, error: 'noAnswer', kept };
    if (!result.ok) return { ok: false, error: 'game', message: result.errors.join(' '), kept };
    return { ok: true, kept, message: result.messages.join(' ') };
  }

  // --- World map: island coordinates on every island tile ---
  // The game reuses a fixed pool of tiles (#map1 > div#tile_i_j) and repaints them
  // with worldmap.drawPiece(tile, x, y), which also sets tile.mapX / tile.mapY.
  // Copy the coordinates into a data attribute; a CSS ::after shows it.
  const COORDS_STYLE_ID = 'ikadios-worldmap-coords';
  const COORDS_CSS = `#worldmap .islandTile[data-ikadios-xy]::after {
    content: attr(data-ikadios-xy); position: absolute; left: 50%; top: 22px;
    transform: translateX(-50%) scale(var(--ikadios-label-scale, 1)); transform-origin: 50% 0;
    padding: 0 4px; border-radius: 3px;
    font: bold 11px Arial, sans-serif; color: #fff; background: rgba(0, 0, 0, 0.6);
    white-space: nowrap; pointer-events: none; z-index: 5;
  }`;

  function patchWorldmap() {
    const map = window.worldmap;
    if (!map || typeof map.drawPiece !== 'function') return;
    if (!map.drawPiece.ikadiosPatched) {
      const original = map.drawPiece;
      const patched = function (tile, x, y) {
        const result = original.apply(this, arguments);
        if (tile?.dataset) tile.dataset.ikadiosXy = `${x}:${y}`;
        return result;
      };
      patched.ikadiosPatched = true;
      map.drawPiece = patched;
    }
    for (const tile of document.querySelectorAll('#worldmap [id^="tile_"]')) {
      if (tile.mapX != null) tile.dataset.ikadiosXy = `${tile.mapX}:${tile.mapY}`;
    }
    if (!document.getElementById(COORDS_STYLE_ID) && document.head) {
      const style = document.createElement('style');
      style.id = COORDS_STYLE_ID;
      style.textContent = COORDS_CSS;
      document.head.appendChild(style);
    }
  }

  let tries = 0;
  function pollModel() {
    const model = pickModel();
    if (model) {
      post('model', cloneable(model));
      reportToken(window.ikariam.model.actionRequest);
      return;
    }
    if (++tries < MODEL_POLL_MAX_TRIES) setTimeout(pollModel, MODEL_POLL_MS);
  }

  // The isolated world can ask for a fresh model snapshot (e.g. after enabling debug)
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== SOURCE || event.data.direction !== 'content') return;
    if (event.data.kind === 'requestModel') {
      const model = pickModel();
      if (model) post('model', cloneable(model));
    }
    if (event.data.kind === 'setToken') {
      const token = String(event.data.payload || '');
      if (token && token !== lastToken && window.ikariam?.model) {
        lastToken = token;
        window.ikariam.model.actionRequest = token;
      }
    }
    // User confirmed a delivery in the Trade tab: open the game's transport window
    // from the chosen city, fill the amounts and press the game's own send button,
    // so its checks (ships, capacity, ownership) apply as for a manual send
    if (event.data.kind === 'transportSend') {
      transportSend(event.data.payload || {}).then((result) => post('transportSendResult', result));
    }
    // Delivery link opened: show the game's transport window to the requester's
    // city with the amounts typed in; the player sends it with the game's button
    if (event.data.kind === 'transportPrefill') {
      transportPrefill(event.data.payload || {}).then((result) => post('transportPrefillResult', result));
    }
    // Map double click on an island whose id is unknown: look it up on the game's
    // world map (one small area around the coordinates) and open it
    if (event.data.kind === 'openIslandAt') {
      openIslandAt(event.data.payload || {});
    }
    // Delivery link in "panel" mode: the link itself makes the game open its
    // transport window on load; close it with the window's own close button
    if (event.data.kind === 'transportClose') {
      transportClose(event.data.payload || {}).then((result) => post('transportCloseResult', result));
    }
    // User clicked a building action in the overlay. Uses the game's own links and
    // loader, so the game updates its UI; demolition opens the game's confirmation view.
    if (event.data.kind === 'buildingAction') {
      buildingAction(event.data.payload || {}).then((result) => post('buildingActionResult', result));
    }
    // User clicked "open in game" in the overlay: navigate with the game's own loader
    if (event.data.kind === 'goToView') {
      const { view, params = {} } = event.data.payload || {};
      if (/^[a-zA-Z]+$/.test(String(view)) && typeof window.ajaxHandlerCall === 'function') {
        const query = new URLSearchParams({ view });
        for (const [k, v] of Object.entries(params)) {
          if (/^[a-zA-Z]+$/.test(k) && /^[\w-]+$/.test(String(v))) query.set(k, String(v));
        }
        window.ajaxHandlerCall(`?${query}`);
      }
    }
  });

  function onLoad() {
    pollModel();
    patchWorldmap();
  }
  if (document.readyState === 'complete') onLoad();
  else window.addEventListener('load', onLoad, { once: true });
})();

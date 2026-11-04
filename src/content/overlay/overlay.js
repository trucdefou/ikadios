// Floating overlay mounted in a Shadow DOM so game CSS and overlay CSS never mix.
// Draggable, resizable, minimizable to an emblem pinned to the bottom right corner
// (with an alert badge). Position, size, active tab and visibility persist in
// chrome.storage.local.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { el, debounce, MESSAGE_SOURCE } = IkaDios.util;
  const i18n = IkaDios.i18n;

  const KEY_STATE = 'overlayState';
  const DEFAULT_STATE = { visible: true, minimized: false, tab: 'summary', x: null, y: 80, w: 720, h: 460 };
  const RENDER_DEBOUNCE_MS = 250;
  const VIEWPORT_MARGIN = 8;

  let state = { ...DEFAULT_STATE };
  let host = null;
  let shadow = null;
  let refs = {};
  const countdowns = new Set();

  async function loadState() {
    const stored = await chrome.storage.local.get(KEY_STATE);
    state = { ...DEFAULT_STATE, ...(stored[KEY_STATE] || {}) };
  }

  const saveState = debounce(() => {
    if (IkaDios.util.extensionAlive()) chrome.storage.local.set({ [KEY_STATE]: state }).catch(() => {});
  }, 300);

  function setState(patch) {
    Object.assign(state, patch);
    saveState();
  }

  function goToView(view, params = {}) {
    if (!view) return;
    window.postMessage({ source: MESSAGE_SOURCE, direction: 'content', kind: 'goToView', payload: { view, params } }, location.origin);
  }

  // Building upgrade / demolition, started by an explicit click in the Polis tab.
  // The page hook runs it with the game's own links (see hook.js).
  function buildingAction(action, { cityId, position, level }) {
    window.postMessage(
      { source: MESSAGE_SOURCE, direction: 'content', kind: 'buildingAction', payload: { action, cityId, position, level } },
      location.origin
    );
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (data?.source !== MESSAGE_SOURCE || data.direction !== 'page' || data.kind !== 'buildingActionResult') return;
    const res = data.payload || {};
    if (!refs.progress) return;
    if (res.ok) {
      refs.progress.textContent = res.action === 'upgrade' ? i18n.t('polisUpgradeDone', { message: res.message || '' }) : '';
    } else {
      // The game's own reason when it rejected the upgrade
      refs.progress.textContent =
        res.error === 'game' && res.message ? i18n.t('polisUpgradeRejected', { message: res.message }) : i18n.t(`polisActionError_${res.error || 'unavailable'}`);
    }
  });

  // Returns a span that the shared 1 s ticker keeps up to date
  function countdown(endsAtMs) {
    const span = el('span', { class: 'countdown' });
    span.dataset.ends = String(endsAtMs);
    countdowns.add(span);
    tickOne(span);
    return span;
  }

  function tickOne(span) {
    const left = (Number(span.dataset.ends) - Date.now()) / 1000;
    span.textContent = left > 0 ? i18n.formatDuration(left) : i18n.t('done');
    span.classList.toggle('is-done', left <= 0);
  }

  function tickAll() {
    for (const span of countdowns) {
      if (!span.isConnected) countdowns.delete(span);
      else tickOne(span);
    }
    if (refs.progress && refreshState.status !== 'running') renderRefresh();
  }

  // Marks a node so hovering it shows how long ago its data was captured.
  // The tooltip text is computed on hover, so it is always current.
  function stamp(node, updatedAt) {
    if (node && updatedAt) node.dataset.updated = String(updatedAt);
    return node;
  }

  function onHoverStamp(e) {
    const node = e.composedPath().find((n) => n instanceof HTMLElement && n.dataset?.updated);
    if (!node) return;
    if (node.dataset.baseTitle === undefined) node.dataset.baseTitle = node.title || '';
    const line = i18n.t('lastUpdated', { when: i18n.formatRelative(Number(node.dataset.updated)) });
    node.title = node.dataset.baseTitle ? `${node.dataset.baseTitle}\n${line}` : line;
  }

  // Alerts for the current snapshot (src/shared/alerts.js), refreshed on every render
  let alertConfig = null;
  let alerts = [];
  const notified = new Set();

  async function loadAlertConfig() {
    const { settings } = await chrome.storage.local.get('settings');
    alertConfig = IkaDios.alerts.normalize(settings?.alerts);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) {
        alertConfig = IkaDios.alerts.normalize(changes.settings.newValue?.alerts);
        render();
      }
    });
  }

  function updateAlerts(snapshot) {
    alerts = IkaDios.alerts.evaluate(snapshot, alertConfig);
    if (!alertConfig?.desktop || !IkaDios.util.extensionAlive()) return;
    const min = IkaDios.alerts.SEVERITY_RANK[alertConfig.desktopMinSeverity] ?? 1;
    for (const a of alerts) {
      if (IkaDios.alerts.SEVERITY_RANK[a.severity] < min || notified.has(a.id)) continue;
      notified.add(a.id);
      // The worker shows it and de-duplicates across game tabs
      chrome.runtime
        .sendMessage({ type: 'ikadios:notify', id: a.id, severity: a.severity, title: i18n.t(`alertTitle_${a.severity}`), message: IkaDios.alerts.describe(a, i18n) })
        .catch(() => {});
    }
    // Conditions that ended can notify again if they come back
    for (const id of [...notified]) if (!alerts.some((a) => a.id === id)) notified.delete(id);
  }

  function alertCount() {
    return alerts.filter((a) => a.severity !== 'info').length;
  }

  function hasCriticalAlert() {
    return alerts.some((a) => a.severity === 'critical');
  }

  function build() {
    host = el('div', { id: 'ikadios-root' });
    shadow = host.attachShadow({ mode: 'open' });
    shadow.append(el('link', { rel: 'stylesheet', href: chrome.runtime.getURL('src/content/overlay/overlay.css') }));

    refs.panel = el('section', { class: 'panel', role: 'dialog' });
    refs.title = el('strong', { class: 'title', text: 'IkaDios' });
    refs.account = el('span', { class: 'account' });
    refs.btnMin = el('button', { class: 'icon min', onclick: () => applyMinimized(true) }, '_');
    refs.btnClose = el('button', { class: 'icon close', onclick: () => setVisible(false) }, 'x');
    refs.progress = el('span', { class: 'progress', role: 'status' });
    refs.btnRefresh = el('button', { class: 'refresh', onclick: onRefreshClick });
    refs.btnRefreshTab = el('button', { class: 'refresh', onclick: onRefreshTabClick });
    refs.chkAuto = el('input', { type: 'checkbox', onchange: (e) => setAuto(e.target.checked) });
    refs.autoText = el('span');
    refs.autoToggle = el('label', { class: 'auto' }, [refs.chkAuto, refs.autoText]);
    // Like the game's windows: the title bar holds only the title and window buttons;
    // refresh controls live in a toolbar row below it
    refs.header = el('header', { class: 'bar' }, [refs.account, refs.title, refs.btnMin, refs.btnClose]);
    refs.toolbar = el('div', { class: 'toolbar' }, [refs.progress, refs.autoToggle, refs.btnRefreshTab, refs.btnRefresh]);
    refs.meterFill = el('span');
    refs.meter = el('div', { class: 'meter', hidden: true }, refs.meterFill);
    refs.tabs = el('nav', { class: 'tabs', role: 'tablist' });
    refs.body = el('div', { class: 'body' });
    new MutationObserver(scheduleAlign).observe(refs.body, { childList: true, subtree: true });
    // Notices above the tab content (e.g. "import this shared item?")
    refs.notice = el('div', { class: 'notice-slot' });
    refs.foot = el('div', { class: 'foot' });
    refs.panel.append(refs.header, refs.toolbar, refs.meter, refs.tabs, refs.notice, refs.body, refs.foot);

    // Minimized: a pixel art emblem (icons/emblem.png, from tools/make_emblem.py)
    refs.pill = el('button', { class: 'pill', title: 'IkaDios', 'aria-label': 'IkaDios', onclick: () => openPanel() }, [
      el('img', { class: 'emblem', src: chrome.runtime.getURL('icons/emblem.png'), alt: '', draggable: 'false' }),
      (refs.badge = el('span', { class: 'badge' })),
    ]);

    shadow.append(refs.panel, refs.pill);
    refs.body.addEventListener('pointerover', onHoverStamp);
    enableDrag(refs.header);
    new ResizeObserver(
      debounce(() => {
        // The expanded (full window) size is temporary and not saved
        if (!isOpen() || expanded) return;
        setState({ w: refs.panel.offsetWidth, h: refs.panel.offsetHeight });
      }, 200)
    ).observe(refs.panel);

    document.documentElement.append(host);
  }

  function enableDrag(handle) {
    let start = null;
    handle.addEventListener('pointerdown', (e) => {
      const control = e.target.closest('button, input, label');
      if (e.button !== 0 || (control && control !== handle)) return;
      const rect = refs.panel.getBoundingClientRect();
      start = { px: e.clientX, py: e.clientY, x: rect.left, y: rect.top };
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = e.clientX - start.px;
      const dy = e.clientY - start.py;
      const x = Math.min(Math.max(0, start.x + dx), window.innerWidth - 80);
      const y = Math.min(Math.max(0, start.y + dy), window.innerHeight - 30);
      setState({ x, y });
      position();
    });
    handle.addEventListener('pointerup', () => {
      start = null;
    });
  }

  // The refresh runs in the service worker; the overlay sends commands and renders
  // the status record it keeps in storage (refreshStatus:<world>)
  let refreshState = { status: 'idle' };
  let autoSettings = { autoRefresh: false, autoRefreshMinutes: 30 };

  function statusKey() {
    return `refreshStatus:${IkaDios.util.parseGameHost(location.hostname).world}`;
  }

  function onRefreshClick() {
    if (!IkaDios.util.extensionAlive()) return showStale();
    const type = refreshState.status === 'running' ? 'ikadios:refreshCancel' : 'ikadios:refreshStart';
    chrome.runtime.sendMessage({ type }).catch((err) => {
      // Usually the extension was reloaded and this tab still runs the old content script
      IkaDios.util.warn('refresh message failed', err);
      refs.progress.textContent = i18n.t('refreshUnavailable');
    });
  }

  // Refreshes only the views behind the open tab (refresh-plan.js SCOPES)
  function onRefreshTabClick() {
    if (!IkaDios.util.extensionAlive()) return showStale();
    chrome.runtime.sendMessage({ type: 'ikadios:refreshStart', scope: state.tab }).catch((err) => {
      IkaDios.util.warn('refresh message failed', err);
      refs.progress.textContent = i18n.t('refreshUnavailable');
    });
  }

  async function setAuto(enabled) {
    if (!IkaDios.util.extensionAlive()) return showStale();
    const settings = (await chrome.storage.local.get('settings')).settings || {};
    await chrome.storage.local.set({ settings: { ...settings, autoRefresh: enabled } });
  }

  function stepLabel(step) {
    if (!step) return '';
    if (step.kind === 'account') return i18n.tOr(`view_${step.view}`, step.view);
    if (step.kind === 'city') return step.cityName;
    if (step.kind === 'building') return `${step.cityName}: ${i18n.buildingName(step.view)}`;
    if (step.kind === 'military') return `${step.cityName}: ${i18n.t('stepMilitary')}`;
    if (step.kind === 'spyReports') return `${step.cityName}: ${i18n.t('stepSpyReports')}`;
    if (step.kind === 'island') return `${step.cityName}: ${i18n.t('stepIsland', { name: step.islandName || '' })}`;
    return '';
  }

  function renderRefresh() {
    const running = refreshState.status === 'running';
    refs.btnRefresh.textContent = i18n.t(running ? 'refreshCancel' : 'refreshAll');
    refs.btnRefresh.title = i18n.t('refreshHint');
    refs.btnRefresh.classList.toggle('is-running', running);
    // Per-tab refresh: hidden while a run is going and on tabs without views
    const tabLabel = i18n.tOr(`tab_${state.tab}`, state.tab);
    refs.btnRefreshTab.hidden = running || !IkaDios.refreshPlan.SCOPES[state.tab];
    refs.btnRefreshTab.textContent = i18n.t('refreshTab');
    refs.btnRefreshTab.title = i18n.t('refreshTabHint', { tab: tabLabel });
    refs.chkAuto.checked = !!autoSettings.autoRefresh;
    refs.autoText.textContent = i18n.t('autoRefresh');
    refs.autoToggle.title = i18n.t('autoRefreshHint', { min: autoSettings.autoRefreshMinutes || 30 });

    let text = '';
    const total = Math.max(refreshState.total || 0, refreshState.done || 0, 1);
    const pct = Math.min(100, Math.round(((refreshState.done || 0) / total) * 100));
    refs.meter.hidden = !running;
    refs.meterFill.style.width = `${pct}%`;
    if (running) {
      text = i18n.t('refreshProgress', { pct, done: refreshState.done || 0, total, step: stepLabel(refreshState.step) });
    } else if (refreshState.status === 'error') {
      text = i18n.t('autoPausedErrors');
    } else if (autoSettings.autoRefresh && refreshState.nextAt) {
      text = i18n.t('autoNext', { when: i18n.formatRelative(refreshState.nextAt) });
    } else if (refreshState.status === 'done' || refreshState.status === 'cancelled') {
      text = i18n.t(refreshState.status === 'done' ? 'refreshDone' : 'refreshCancelled', {
        n: refreshState.done || 0,
        failed: refreshState.failed || 0,
      });
    }
    refs.progress.textContent = text;
  }

  async function watchRefresh() {
    const stored = await chrome.storage.local.get([statusKey(), 'settings']);
    refreshState = stored[statusKey()] || refreshState;
    autoSettings = { ...autoSettings, ...(stored.settings || {}) };
    renderRefresh();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[statusKey()]) refreshState = changes[statusKey()].newValue || { status: 'idle' };
      if (changes.settings) autoSettings = { ...autoSettings, ...(changes.settings.newValue || {}) };
      if (changes[statusKey()] || changes.settings) renderRefresh();
    });
  }

  // Keeps the whole panel inside the viewport (size first, then position)
  function position() {
    const w = Math.min(state.w, window.innerWidth - 2 * VIEWPORT_MARGIN);
    const h = Math.min(state.h, window.innerHeight - 2 * VIEWPORT_MARGIN);
    const x = Math.min(Math.max(VIEWPORT_MARGIN, state.x ?? window.innerWidth - w - 20), window.innerWidth - w - VIEWPORT_MARGIN);
    const y = Math.min(Math.max(VIEWPORT_MARGIN, state.y), window.innerHeight - h - VIEWPORT_MARGIN);
    refs.panel.style.left = `${x}px`;
    refs.panel.style.top = `${y}px`;
    refs.panel.style.width = `${w}px`;
    refs.panel.style.height = `${h}px`;
  }

  function centerPanel() {
    const w = Math.min(state.w, window.innerWidth - 2 * VIEWPORT_MARGIN);
    const h = Math.min(state.h, window.innerHeight - 2 * VIEWPORT_MARGIN);
    setState({ w, h, x: Math.round((window.innerWidth - w) / 2), y: Math.round((window.innerHeight - h) / 2) });
    position();
  }

  function isOpen() {
    return state.visible && !state.minimized;
  }

  // The corner emblem is always there while the panel is closed or minimized
  function applyVisibility() {
    // Inline style: the shadow CSS resets the host with `all: initial`, which defeats the hidden attribute
    host.style.setProperty('display', 'block', 'important');
    refs.panel.hidden = !isOpen();
    refs.pill.hidden = isOpen();
  }

  function openPanel() {
    setState({ visible: true, minimized: false });
    centerPanel();
    applyVisibility();
    render();
  }

  function applyMinimized(minimized) {
    if (!minimized) return openPanel();
    setState({ minimized });
    applyVisibility();
  }

  function setVisible(visible) {
    if (visible) return openPanel();
    setState({ visible });
    applyVisibility();
  }

  function toggle() {
    if (isOpen()) setVisible(false);
    else openPanel();
  }

  function renderTabs() {
    refs.tabs.replaceChildren(
      ...IkaDios.tabs.list().map((tab) =>
        el('button', {
          class: `tab ${tab.id === state.tab ? 'is-active' : ''} ${tab.pending ? 'is-pending' : ''}`,
          role: 'tab',
          'aria-selected': tab.id === state.tab ? 'true' : 'false',
          text: i18n.t(tab.labelKey),
          onclick: () => {
            setState({ tab: tab.id });
            render();
          },
        })
      )
    );
  }

  function render() {
    if (!host) return;
    const snapshot = IkaDios.store.get();
    i18n.setGameBuildingNames(snapshot?.buildingNames);
    updateAlerts(snapshot);
    const count = alertCount();
    refs.badge.textContent = count ? String(count) : '';
    refs.badge.classList.toggle('is-critical', hasCriticalAlert());
    refs.btnMin.title = i18n.t('minimize');
    refs.btnClose.title = i18n.t('close');
    renderRefresh();
    refs.account.textContent = snapshot?.account?.world || '';
    if (!isOpen()) return;

    renderTabs();
    const tab = IkaDios.tabs.list().find((t) => t.id === state.tab) || IkaDios.tabs.list()[0];
    const helpers = { i18n, countdown, goToView, stamp, buildingAction, setExpanded, openTab };
    // Persistent tabs (the map) keep their DOM and state; they only receive new data
    const current = refs.body.firstElementChild;
    if (tab.persistent && current?.dataset.tab === tab.id && typeof tab.update === 'function') {
      try {
        tab.update(current, snapshot, helpers);
      } catch (err) {
        IkaDios.util.warn('tab update failed', tab.id, err);
      }
      return;
    }
    setExpanded(false);
    const container = el('div', { class: `tab-body tab-${tab.id}` });
    container.dataset.tab = tab.id;
    try {
      tab.render(container, snapshot, helpers);
    } catch (err) {
      IkaDios.util.warn('tab render failed', tab.id, err);
      container.append(el('p', { class: 'error', text: i18n.t('renderError') }));
    }
    refs.body.replaceChildren(container);
  }

  // Tables: columns whose cells are all numbers, amounts, times or dates are
  // right-aligned (class `n` on th and td); text columns stay left-aligned.
  // Cells with only "-" or nothing do not count. Rows with colspan are skipped.
  const NUMERIC = /^[\d\s.,:/+\-%()hmsdx]*\d[\d\s.,:/+\-%()hmsdx]*$/i;
  function alignColumns(root) {
    for (const table of root.querySelectorAll('table.grid:not(.matrix)')) {
      const rows = [...table.querySelectorAll('tbody tr')].filter((tr) => ![...tr.cells].some((c) => c.colSpan > 1));
      const sig = `${rows.length}:${rows[0]?.cells.length || 0}`;
      if (table.dataset.aligned === sig) continue;
      table.dataset.aligned = sig;
      const width = Math.max(0, ...rows.map((r) => r.cells.length));
      for (let col = 1; col < width; col++) {
        let votes = 0;
        let numeric = true;
        for (const tr of rows) {
          const cell = tr.cells[col];
          if (!cell || cell.querySelector('input, select, button.refresh, button.btn-soft, button.icon')) continue;
          const text = cell.textContent.trim();
          if (!text || text === '-') continue;
          votes++;
          if (!NUMERIC.test(text)) {
            numeric = false;
            break;
          }
        }
        const on = numeric && votes > 0;
        for (const tr of rows) tr.cells[col]?.classList.toggle('n', on);
        for (const tr of table.querySelectorAll('thead tr')) {
          if (![...tr.cells].some((c) => c.colSpan > 1)) tr.cells[col]?.classList.toggle('n', on);
        }
      }
    }
  }

  let alignPending = false;
  function scheduleAlign() {
    if (alignPending || !refs.body) return;
    alignPending = true;
    requestAnimationFrame(() => {
      alignPending = false;
      alignColumns(refs.body);
    });
  }

  // Data updates wait while a popover is open, so it does not vanish under the cursor
  // Switches tab; `options` is handed to the target tab (e.g. {center: {x, y}} for the map)
  function openTab(id, options = {}) {
    IkaDios.tabs.pendingOptions = { id, ...options };
    setState({ tab: id });
    // A persistent tab that is not on screen is rebuilt; render() handles the rest
    if (refs.body.firstElementChild?.dataset.tab !== id) refs.body.replaceChildren();
    render();
  }

  // Full-window panel, used by the map; restored when leaving the tab
  let expanded = false;
  function setExpanded(on) {
    if (on === expanded || !refs.panel) return;
    expanded = on;
    refs.panel.classList.toggle('is-expanded', on);
    if (on) {
      Object.assign(refs.panel.style, { left: '8px', top: '8px', width: 'calc(100vw - 16px)', height: 'calc(100vh - 16px)' });
    } else {
      position();
    }
  }

  const scheduleRender = debounce(function renderWhenIdle() {
    if (refs.body?.querySelector('.popover')) {
      scheduleRender();
      return;
    }
    render();
  }, RENDER_DEBOUNCE_MS);

  // Game look: measured from the game's own window CSS (see game-skin.js)
  let skinReported = false;
  function applyGameSkin() {
    const result = IkaDios.gameSkin.build();
    let style = shadow.getElementById('ikadios-game-skin');
    if (!style) {
      style = el('style', { id: 'ikadios-game-skin' });
      shadow.append(style);
    }
    style.textContent = result.css;
    refs.panel.classList.toggle('is-game-skin', result.applied);
    if (!skinReported && IkaDios.bridge.debugEnabled?.()) {
      skinReported = true;
      IkaDios.store.appendDebugCapture({ ts: Date.now(), kind: 'styleProbe', world: IkaDios.store.get()?.account?.world, payload: IkaDios.gameSkin.report() });
    }
  }

  // The extension was reloaded: stop timers and tell the user to reload the page
  const timers = [];
  function showStale() {
    for (const id of timers) clearInterval(id);
    timers.length = 0;
    if (!refs.body) return;
    // The catalog is already in memory, so t() still works without the extension
    refs.body.replaceChildren(el('p', { class: 'error', text: i18n.t('extensionReloaded') }));
    refs.tabs.replaceChildren();
    refs.progress.textContent = '';
    for (const node of [refs.btnRefresh, refs.btnRefreshTab, refs.autoToggle, refs.meter]) node.hidden = true;
    applyMinimized(false);
  }

  async function mount() {
    await loadState();
    await loadAlertConfig();
    build();
    position();
    applyVisibility();
    render();
    IkaDios.store.subscribe(scheduleRender);
    i18n.onChange(render);
    watchRefresh();
    applyGameSkin();
    // The game's stylesheets can finish loading after us; measure again shortly after
    setTimeout(() => IkaDios.util.extensionAlive() && applyGameSkin(), 4000);
    timers.push(setInterval(tickAll, 1000));
    timers.push(
      setInterval(() => {
        if (!IkaDios.util.extensionAlive()) showStale();
      }, 2000)
    );
    window.addEventListener('resize', debounce(position, 200));
  }

  // Opens the panel on a tab (used by delivery links)
  function showTab(id) {
    setState({ visible: true, minimized: false });
    applyVisibility();
    openTab(id);
  }

  // Shows (or clears, with null) the notice above the tab content
  function notice(node) {
    refs.notice?.replaceChildren(...(node ? [node] : []));
  }

  IkaDios.overlay = { mount, toggle, render, goToView, showStale, showTab, notice, currentAlerts: () => alerts.slice() };
})(typeof self !== 'undefined' ? self : window);

// Automation tab: master switch, quiet hours, the construction queue and the log.
// The worker (src/background/automation.js) owns the state; this tab only sends
// edits and shows what is stored. Persistent tab, so the add form keeps its input
// while data updates arrive.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { el } = IkaDios.util;
  const plan = IkaDios.automationPlan;

  const LOG_ROWS = 50;
  const form = { cityId: null, position: null, target: '', active: true };
  let data = { state: plan.emptyState(), log: [], world: null };
  let mounted = null; // { container, snapshot, i18n }
  let storageListener = null;

  async function send(msg) {
    if (!IkaDios.util.extensionAlive()) return { ok: false, error: 'context' };
    try {
      return (await chrome.runtime.sendMessage(msg)) || { ok: false, error: 'noAnswer' };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  async function reload() {
    const res = await send({ type: 'ikadios:autoGet' });
    if (res.ok) data = { state: plan.normalize(res.state), log: res.log || [], world: res.world };
    if (mounted?.container.isConnected) fillDynamic(mounted.container, mounted.snapshot, mounted.i18n);
  }

  function watchStorage() {
    if (storageListener || !IkaDios.util.extensionAlive()) return;
    storageListener = (changes, area) => {
      if (area === 'local' && Object.keys(changes).some((k) => k.startsWith('automation:'))) reload();
    };
    chrome.storage.onChanged.addListener(storageListener);
  }

  // ---------- Texts ----------

  function params(p, i18n) {
    return { ...p, building: p?.building ? i18n.buildingName(p.building) : '', cargo: p?.cargo ? cargoText(p.cargo, i18n) : '' };
  }

  function cargoText(cargo, i18n) {
    return Object.entries(cargo || {})
      .filter(([, n]) => n > 0)
      .map(([r, n]) => `${i18n.t(`resourceShort_${r}`)} ${i18n.formatNumber(n)}`)
      .join(', ');
  }

  function missingText(missing, i18n) {
    return Object.entries(missing || {})
      .map(([r, n]) => `${i18n.t(`resourceShort_${r}`)} ${i18n.formatNumber(Math.ceil(n))}`)
      .join(', ');
  }

  function taskStatus(task, i18n) {
    const { t } = i18n;
    const m = task.lastMessage;
    if (task.status === 'done') return t('autoStatus_done');
    if (task.status === 'paused') return t('autoStatus_inactive');
    const head = task.status === 'error' ? t('autoStatus_error') : '';
    if (!m && task.startAt > Date.now()) return t('autoMsg_scheduled', { when: i18n.formatTime(task.startAt) });
    if (!m) return head || t('autoStatus_new');
    const detail = {
      busy: () => t('autoMsg_busy', { when: i18n.formatTime(m.until) }),
      missing: () =>
        m.missing && Object.keys(m.missing).length
          ? t('autoMsg_missing', { list: missingText(m.missing, i18n), when: i18n.formatTime(m.until) })
          : t('autoMsg_missingOrigin', { when: i18n.formatTime(m.until) }),
      noShips: () => t('autoMsg_noShips', { when: i18n.formatTime(m.until) }),
      satisfied: () => t('autoMsg_satisfied', { when: i18n.formatTime(m.until) }),
      transportSent: () => t('autoMsg_transportSent', { cargo: cargoText(m.cargo, i18n), ships: m.ships }),
      scheduled: () => t('autoMsg_scheduled', { when: i18n.formatTime(m.until) }),
      upgradeSent: () => t('autoMsg_upgradeSent', { level: m.level, next: m.level + 1 }),
      rateLimit: () => t('autoMsg_rateLimit', { when: i18n.formatTime(m.until) }),
    }[m.code];
    const text = detail ? detail() : i18n.tOr(`autoMsg_${m.code}`, m.code);
    return [head, text, m.message ? `(${m.message})` : ''].filter(Boolean).join(' ');
  }

  function stateLine(i18n) {
    const { t } = i18n;
    const s = data.state;
    if (s.stopped) return { cls: 'error', text: t(`autoStopped_${s.stopped.reason}`) };
    if (!s.enabled) return { cls: 'hint', text: t('autoStateOff') };
    if (plan.inQuietHours(s.quiet)) return { cls: 'hint', text: t('autoStateQuiet', { to: s.quiet.to }) };
    if (!plan.headTasks(s).length) return { cls: 'hint', text: t('autoStateIdle') };
    return { cls: '', text: s.nextAt ? t('autoStateNext', { when: i18n.formatTime(s.nextAt) }) : t('autoStateOn') };
  }

  // ---------- Static parts ----------

  function controls(i18n) {
    const { t } = i18n;
    const q = data.state.quiet;
    const time = (key) =>
      el('input', {
        type: 'time',
        class: `auto-${key}`,
        value: q[key],
        onchange: (e) => {
          const value = e.target.value;
          if (plan.minutesOf(value) != null) send({ type: 'ikadios:autoSet', patch: { quiet: { [key]: value } } });
        },
      });
    return el('div', { class: 'auto-controls' }, [
      el('div', { class: 'map-toolbar' }, [
        el('label', { class: 'check' }, [
          el('input', {
            type: 'checkbox',
            class: 'auto-enabled',
            checked: data.state.enabled ? true : null,
            onchange: (e) => send({ type: 'ikadios:autoSet', patch: { enabled: e.target.checked } }),
          }),
          el('strong', { text: t('autoEnabled') }),
        ]),
        el('button', { class: 'refresh', text: t('autoStopAll'), onclick: () => send({ type: 'ikadios:autoStop' }) }),
        el('span', { class: 'auto-state' }),
      ]),
      el('div', { class: 'map-toolbar' }, [
        el('label', { class: 'check' }, [
          el('input', {
            type: 'checkbox',
            class: 'auto-quiet',
            checked: q.enabled ? true : null,
            onchange: (e) => send({ type: 'ikadios:autoSet', patch: { quiet: { enabled: e.target.checked } } }),
          }),
          t('autoQuiet'),
        ]),
        el('label', { class: 'check' }, [t('autoQuietFrom'), time('from')]),
        el('label', { class: 'check' }, [t('autoQuietTo'), time('to')]),
        el('label', { class: 'check', title: t('autoCheckHint', { min: plan.CHECK_MINUTES.min, max: plan.CHECK_MINUTES.max }) }, [
          t('autoCheckEvery'),
          el('input', {
            type: 'number',
            class: 'auto-check',
            min: String(plan.CHECK_MINUTES.min),
            max: String(plan.CHECK_MINUTES.max),
            step: '5',
            value: String(data.state.checkMinutes),
            style: { width: '4em' },
            onchange: (e) => {
              const value = Number(e.target.value);
              if (plan.validCheckMinutes(value)) send({ type: 'ikadios:autoSet', patch: { checkMinutes: value } });
              else e.target.value = String(data.state.checkMinutes);
            },
          }),
          t('autoMinutes'),
        ]),
        el('span', { class: 'auto-rate hint' }),
      ]),
    ]);
  }

  function addForm(snapshot, i18n) {
    const { t } = i18n;
    const cities = IkaDios.facets.ownCities(snapshot).filter((c) => c.buildings?.length);
    if (!cities.length) return el('p', { class: 'empty', text: t('autoNoCities') });
    if (!cities.some((c) => c.id === form.cityId)) form.cityId = cities[0].id;

    const status = el('span', { class: 'hint' });
    const buildingSelect = el('select', { class: 'auto-building' });
    const target = el('input', { type: 'number', class: 'auto-target', min: '1', max: '100', style: { width: '4em' } });

    const fillBuildings = () => {
      const city = cities.find((c) => c.id === form.cityId);
      const list = [...(city?.buildings || [])].sort((a, b) => i18n.buildingName(a.type).localeCompare(i18n.buildingName(b.type)) || a.pos - b.pos);
      if (!list.some((b) => b.pos === form.position)) form.position = list[0]?.pos ?? null;
      buildingSelect.replaceChildren(
        ...list.map((b) =>
          el('option', { value: String(b.pos), selected: b.pos === form.position ? true : null, text: t('autoBuildingOption', { building: i18n.buildingName(b.type), level: b.level }) })
        )
      );
      const b = list.find((x) => x.pos === form.position);
      target.min = String((b?.level || 0) + 1);
      if (!form.target || Number(form.target) <= (b?.level || 0)) form.target = String((b?.level || 0) + 1);
      target.value = form.target;
    };

    const add = async () => {
      const city = cities.find((c) => c.id === form.cityId);
      const b = city?.buildings.find((x) => x.pos === form.position);
      if (!b) return;
      const res = await send({
        type: 'ikadios:autoAddTask',
        task: { cityId: city.id, cityName: city.name, position: b.pos, buildingType: b.type, fromLevel: b.level, targetLevel: Number(form.target), active: form.active },
      });
      status.textContent = res.ok ? t('autoAdded') : t(`autoAddError_${res.error === 'duplicate' || res.error === 'invalid' ? res.error : 'other'}`);
    };

    const citySelect = el(
      'select',
      {
        class: 'auto-city',
        onchange: (e) => {
          form.cityId = e.target.value;
          form.target = '';
          fillBuildings();
        },
      },
      cities.map((c) => el('option', { value: c.id, selected: c.id === form.cityId ? true : null, text: c.name || c.id }))
    );
    buildingSelect.addEventListener('change', (e) => {
      form.position = Number(e.target.value);
      form.target = '';
      fillBuildings();
    });
    target.addEventListener('input', (e) => {
      form.target = e.target.value;
    });
    fillBuildings();

    return el('div', { class: 'map-toolbar auto-add' }, [
      el('label', { class: 'check' }, [t('city'), citySelect]),
      el('label', { class: 'check' }, [t('autoBuilding'), buildingSelect]),
      el('label', { class: 'check' }, [t('autoTargetLevel'), target]),
      el('label', { class: 'check', title: t('autoActiveHint') }, [
        el('input', {
          type: 'checkbox',
          checked: form.active ? true : null,
          onchange: (e) => {
            form.active = e.target.checked;
          },
        }),
        t('autoActive'),
      ]),
      el('button', { class: 'refresh', text: t('autoAdd'), onclick: add }),
      status,
    ]);
  }

  const icon = (name) => IkaDios.icons.svg(name);

  // ---------- Dynamic parts ----------

  // Runs the task right away; the worker answers when the game has replied
  let runMessage = '';
  function runNowButton(task, i18n) {
    const { t } = i18n;
    return el(
      'button',
      {
        class: 'icon act',
        title: t('autoRunNow'),
        'aria-label': t('autoRunNow'),
        onclick: async (e) => {
          const button = e.currentTarget;
          button.disabled = true;
          runMessage = t('autoRunning');
          showRunMessage();
          const res = await send({ type: 'ikadios:autoRunNow', id: task.id });
          runMessage = res.ok ? '' : i18n.tOr(`autoRunNowError_${res.error}`, t('autoRunNowError_other'));
          button.disabled = false;
          showRunMessage();
        },
      },
      icon('runNow')
    );
  }

  function showRunMessage() {
    const box = mounted?.container.querySelector('.auto-run-msg');
    if (box) box.textContent = runMessage;
  }

  function op(task, name, label, iconName) {
    return el('button', { class: 'icon act', title: label, 'aria-label': label, onclick: () => send({ type: 'ikadios:autoTask', id: task.id, op: name }) }, icon(iconName));
  }

  function rowClass(task) {
    return task.status === 'error' ? 'hostile' : task.status === 'done' ? 'na' : '';
  }

  function activeCell(task, i18n) {
    return el('td', { class: task.status === 'paused' ? 'na' : 'warn', text: i18n.t(task.status === 'paused' ? 'autoInactive' : 'autoActiveYes') });
  }

  // Run now, activate / deactivate / retry, remove (and reorder for build queues)
  function actions(task, i18n, { reorder = false } = {}) {
    const { t } = i18n;
    return el('td', { class: 'nowrap' }, [
      task.status !== 'done' ? runNowButton(task, i18n) : null,
      reorder ? op(task, 'up', t('autoUp'), 'up') : null,
      reorder ? op(task, 'down', t('autoDown'), 'down') : null,
      task.status === 'paused'
        ? op(task, 'resume', t('autoActivate'), 'resume')
        : task.status === 'error'
          ? op(task, 'retry', t('autoRetry'), 'retry')
          : task.status !== 'done'
            ? op(task, 'pause', t('autoDeactivate'), 'pause')
            : null,
      op(task, 'remove', t('autoRemove'), 'remove'),
    ]);
  }

  function clearDoneButton(tasks, i18n) {
    const done = tasks.find((x) => x.status === 'done');
    return done ? el('button', { class: 'btn-soft', text: i18n.t('autoClearDone'), onclick: () => send({ type: 'ikadios:autoTask', id: done.id, op: 'clearDone' }) }) : null;
  }

  function taskTable(i18n) {
    const { t } = i18n;
    const tasks = data.state.tasks.filter((x) => x.type !== 'transport');
    if (!tasks.length) return el('p', { class: 'empty', text: t('autoNoTasks') });
    return el('div', {}, [
      el('table', { class: 'grid auto-tasks' }, [
        el('thead', {}, el('tr', {}, [t('city'), t('autoBuilding'), t('autoLevels'), t('autoActiveColumn'), t('autoStatus'), ''].map((h) => el('th', { text: h })))),
        el('tbody', {}, tasks.map((task) =>
          el('tr', { class: rowClass(task) }, [
            el('td', { text: task.cityName || task.cityId }),
            el('td', { text: i18n.buildingName(task.buildingType) }),
            el('td', { class: 'num', text: t('autoLevelRange', { from: task.fromLevel, to: task.targetLevel }) }),
            activeCell(task, i18n),
            el('td', { text: taskStatus(task, i18n) }),
            actions(task, i18n, { reorder: true }),
          ])
        )),
      ]),
      clearDoneButton(tasks, i18n),
    ]);
  }

  function transportTable(i18n) {
    const { t } = i18n;
    const tasks = data.state.tasks.filter((x) => x.type === 'transport');
    if (!tasks.length) return el('p', { class: 'empty', text: t('autoNoTransports') });
    const repeatText = (task) =>
      task.mode === 'fill' ? t('autoRepeatInterval') : task.repeatHours > 0 ? t('autoRepeatEvery', { hours: task.repeatHours }) : t('autoRepeatOnce');
    return el('div', {}, [
      el('div', { class: 'scroll-x' }, el('table', { class: 'grid auto-transports' }, [
        el('thead', {}, el('tr', {}, [t('origin'), t('destination'), t('autoTransportMode'), t('cargo'), t('autoStart'), t('autoRepeat'), t('autoActiveColumn'), t('autoStatus'), ''].map((h) => el('th', { text: h })))),
        el('tbody', {}, tasks.map((task) =>
          el('tr', { class: rowClass(task) }, [
            el('td', { text: task.fromName || task.fromCityId }),
            el('td', { text: task.toName || task.toCityId }),
            el('td', { text: t(`autoTransportMode_${task.mode}`) }),
            el('td', { text: cargoText(task.amounts, i18n) }),
            el('td', { class: 'nowrap', text: task.startAt ? i18n.formatTime(task.startAt) : t('autoStartNow') }),
            el('td', { text: repeatText(task) }),
            activeCell(task, i18n),
            el('td', { text: taskStatus(task, i18n) }),
            actions(task, i18n),
          ])
        )),
      ])),
      clearDoneButton(tasks, i18n),
    ]);
  }

  // ---------- Transport form ----------

  const TRANSPORT_RESOURCES = ['wood', 'wine', 'marble', 'glass', 'sulfur'];
  const tform = { from: null, to: null, mode: 'fixed', amounts: {}, repeat: '0', start: '', active: true };

  function transportForm(snapshot, i18n) {
    const { t } = i18n;
    const cities = IkaDios.facets.ownCities(snapshot);
    if (cities.length < 2) return el('p', { class: 'empty', text: t('autoNoCities') });
    if (!cities.some((c) => c.id === tform.from)) tform.from = cities[0].id;
    if (!cities.some((c) => c.id === tform.to) || tform.to === tform.from) tform.to = cities.find((c) => c.id !== tform.from).id;

    const status = el('span', { class: 'hint' });
    const citySelect = (key) =>
      el(
        'select',
        { onchange: (e) => (tform[key] = e.target.value) },
        cities.map((c) => el('option', { value: c.id, selected: c.id === tform[key] ? true : null, text: c.name || c.id }))
      );
    const repeatLabel = el('label', { class: 'check', title: t('autoRepeatHint') }, [
      t('autoRepeat'),
      el('input', { type: 'number', min: '0', max: '168', step: '1', value: tform.repeat, style: { width: '4em' }, oninput: (e) => (tform.repeat = e.target.value) }),
      t('autoHours'),
    ]);
    const modeHint = el('span', { class: 'hint', text: t(`autoTransportModeHint_${tform.mode}`) });
    const syncMode = () => {
      repeatLabel.hidden = tform.mode === 'fill';
      modeHint.textContent = t(`autoTransportModeHint_${tform.mode}`);
    };
    const add = async () => {
      if (tform.from === tform.to) {
        status.textContent = t('autoTransportSameCity');
        return;
      }
      const amounts = Object.fromEntries(TRANSPORT_RESOURCES.map((r) => [r, Math.max(0, Math.floor(Number(tform.amounts[r]) || 0))]).filter(([, n]) => n > 0));
      if (!Object.keys(amounts).length) {
        status.textContent = t('autoTransportEmpty');
        return;
      }
      // datetime-local value, in the browser's time zone; empty sends as soon as possible
      const startAt = tform.start ? new Date(tform.start).getTime() : null;
      if (tform.start && !(startAt > Date.now())) {
        status.textContent = t('autoStartPast');
        return;
      }
      const name = (id) => cities.find((c) => c.id === id)?.name || id;
      const res = await send({
        type: 'ikadios:autoAddTask',
        task: { type: 'transport', fromCityId: tform.from, fromName: name(tform.from), toCityId: tform.to, toName: name(tform.to), mode: tform.mode, amounts, repeatHours: tform.mode === 'fill' ? 0 : Number(tform.repeat) || 0, startAt, active: tform.active },
      });
      status.textContent = res.ok ? t('autoAdded') : t(`autoAddError_${res.error === 'invalid' ? 'invalid' : 'other'}`);
    };
    const box = el('div', { class: 'auto-tform' }, [
      el('div', { class: 'map-toolbar' }, [
        el('label', { class: 'check' }, [t('origin'), citySelect('from')]),
        el('label', { class: 'check' }, [t('destination'), citySelect('to')]),
        el('label', { class: 'check' }, [
          t('autoTransportMode'),
          el(
            'select',
            {
              onchange: (e) => {
                tform.mode = e.target.value;
                syncMode();
              },
            },
            ['fixed', 'fill'].map((m) => el('option', { value: m, selected: m === tform.mode ? true : null, text: t(`autoTransportMode_${m}`) }))
          ),
        ]),
        modeHint,
      ]),
      el('div', { class: 'map-toolbar' }, [
        ...TRANSPORT_RESOURCES.map((r) =>
          el('label', { class: 'check' }, [
            t(`resourceShort_${r}`),
            el('input', { type: 'number', min: '0', step: '100', value: tform.amounts[r] || '', style: { width: '6em' }, oninput: (e) => (tform.amounts[r] = e.target.value) }),
          ])
        ),
      ]),
      el('div', { class: 'map-toolbar' }, [
        el('label', { class: 'check', title: t('autoStartHint') }, [
          t('autoStartAt'),
          el('input', { type: 'datetime-local', value: tform.start, oninput: (e) => (tform.start = e.target.value) }),
        ]),
        repeatLabel,
        el('label', { class: 'check', title: t('autoActiveHint') }, [
          el('input', { type: 'checkbox', checked: tform.active ? true : null, onchange: (e) => (tform.active = e.target.checked) }),
          t('autoActive'),
        ]),
        el('button', { class: 'refresh', text: t('autoAdd'), onclick: add }),
        status,
      ]),
    ]);
    syncMode();
    return box;
  }

  function logList(i18n) {
    const { t } = i18n;
    if (!data.log.length) return el('p', { class: 'empty', text: t('autoLogEmpty') });
    return el('div', {}, [
      el('table', { class: 'grid auto-log' }, [
        el('tbody', {}, data.log.slice(0, LOG_ROWS).map((entry) =>
          el('tr', { class: entry.kind === 'error' || entry.kind === 'stop' ? 'hostile' : '' }, [
            el('td', { class: 'nowrap', text: i18n.formatTime(entry.ts) }),
            el('td', { text: t(`autoKind_${entry.kind}`) }),
            el('td', { text: [i18n.tOr(`autoLog_${entry.code}`, entry.code, params(entry.params, i18n)), entry.message ? `(${entry.message})` : ''].filter(Boolean).join(' ') }),
          ])
        )),
      ]),
      el('button', { class: 'btn-soft danger', text: t('autoClearLog'), onclick: () => send({ type: 'ikadios:autoClearLog' }).then(reload) }),
    ]);
  }

  function fillDynamic(container, snapshot, i18n) {
    const { t } = i18n;
    const s = data.state;
    const line = stateLine(i18n);
    const stateEl = container.querySelector('.auto-state');
    if (stateEl) {
      stateEl.className = `auto-state ${line.cls}`;
      stateEl.textContent = line.text;
    }
    const rate = container.querySelector('.auto-rate');
    if (rate) rate.textContent = t('autoRate', { n: plan.recentActions(s.actionTimes).length, max: plan.MAX_ACTIONS_PER_HOUR });
    // Inputs follow the stored state unless the user is editing them
    const sync = (selector, apply) => {
      const input = container.querySelector(selector);
      if (input && input !== container.getRootNode().activeElement) apply(input);
    };
    sync('.auto-enabled', (i) => (i.checked = !!s.enabled));
    sync('.auto-quiet', (i) => (i.checked = !!s.quiet.enabled));
    sync('.auto-from', (i) => (i.value = s.quiet.from));
    sync('.auto-to', (i) => (i.value = s.quiet.to));
    sync('.auto-check', (i) => (i.value = String(s.checkMinutes)));
    container.querySelector('.auto-tasks-box')?.replaceChildren(taskTable(i18n));
    container.querySelector('.auto-transport-box')?.replaceChildren(transportTable(i18n));
    container.querySelector('.auto-log-box')?.replaceChildren(logList(i18n));
  }

  function render(container, snapshot, { i18n }) {
    const { t } = i18n;
    mounted = { container, snapshot, i18n };
    watchStorage();
    container.append(
      el('p', { class: 'warn', text: t('autoWarning') }),
      controls(i18n),
      el('h3', { class: 'section-title', text: t('autoBuildQueue') }),
      el('p', { class: 'hint', text: t('autoBuildHint') }),
      el('div', { class: 'auto-form-box' }, addForm(snapshot, i18n)),
      el('div', { class: 'auto-tasks-box' }),
      el('h3', { class: 'section-title', text: t('autoTransports') }),
      el('p', { class: 'hint', text: t('autoTransportHint') }),
      el('div', { class: 'auto-tform-box' }, transportForm(snapshot, i18n)),
      el('div', { class: 'auto-transport-box' }),
      el('p', { class: 'auto-run-msg hint' }),
      el('h3', { class: 'section-title', text: t('autoLog') }),
      el('div', { class: 'auto-log-box' })
    );
    fillDynamic(container, snapshot, i18n);
    reload();
  }

  function update(container, snapshot, { i18n }) {
    mounted = { container, snapshot, i18n };
    // The add form is rebuilt only when the city list was empty before
    const formBox = container.querySelector('.auto-form-box');
    if (formBox && !formBox.querySelector('.auto-add') && IkaDios.facets.ownCities(snapshot).some((c) => c.buildings?.length)) {
      formBox.replaceChildren(addForm(snapshot, i18n));
    }
    const tformBox = container.querySelector('.auto-tform-box');
    if (tformBox && !tformBox.querySelector('.auto-tform') && IkaDios.facets.ownCities(snapshot).length > 1) {
      tformBox.replaceChildren(transportForm(snapshot, i18n));
    }
    fillDynamic(container, snapshot, i18n);
  }

  // ---------- Used by Polis (automation of one building) ----------

  const isActive = (t) => t.status !== 'done' && t.status !== 'error';

  async function taskFor(cityId, position) {
    const res = await send({ type: 'ikadios:autoGet' });
    if (!res.ok) return null;
    return plan.normalize(res.state).tasks.find((t) => t.cityId === String(cityId) && t.position === Number(position) && isActive(t)) || null;
  }

  // Creates or updates the building's task; an active task also switches automations on
  async function saveBuildingTask(city, building, targetLevel, active) {
    const existing = await taskFor(city.id, building.pos);
    const res = existing
      ? await send({ type: 'ikadios:autoTask', id: existing.id, op: 'set', targetLevel, active })
      : await send({
          type: 'ikadios:autoAddTask',
          task: { cityId: city.id, cityName: city.name, position: building.pos, buildingType: building.type, fromLevel: building.level, targetLevel, active },
        });
    if (res.ok && active) await send({ type: 'ikadios:autoSet', patch: { enabled: true } });
    return res;
  }

  async function removeBuildingTask(cityId, position) {
    const existing = await taskFor(cityId, position);
    return existing ? send({ type: 'ikadios:autoTask', id: existing.id, op: 'remove' }) : { ok: true };
  }

  IkaDios.tabs.register({ id: 'automation', labelKey: 'tab_automation', order: 110, persistent: true, render, update });
  IkaDios.automationTab = { taskFor, saveBuildingTask, removeBuildingTask };
})(typeof self !== 'undefined' ? self : window);

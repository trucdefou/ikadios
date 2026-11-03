// Options page: advisor pack manager, general settings and captured data.
(function () {
  'use strict';

  const { el, warn } = IkaDios.util;
  const i18n = IkaDios.i18n;
  const packs = IkaDios.packs;
  const t = (...a) => i18n.t(...a);

  const IMAGE_MAX_SIDE = 256;
  const KEY_SETTINGS = 'settings';

  const $ = (id) => document.getElementById(id);

  let editing = null;

  // ---------- Settings ----------

  async function getSettings() {
    return (await chrome.storage.local.get(KEY_SETTINGS))[KEY_SETTINGS] || {};
  }

  async function patchSettings(patch) {
    const settings = await getSettings();
    await chrome.storage.local.set({ [KEY_SETTINGS]: { ...settings, ...patch } });
  }

  async function renderGeneral() {
    const settings = await getSettings();
    const select = $('selLanguage');
    select.replaceChildren(
      el('option', { value: 'auto', text: t('optLanguageAuto') }),
      ...i18n.SUPPORTED.map((code) => el('option', { value: code, text: i18n.LANGUAGE_NAMES[code] || code }))
    );
    select.value = settings.language || 'auto';
    $('numAutoMinutes').value = settings.autoRefreshMinutes || 30;
    $('chkDebug').checked = !!settings.debugCapture;
    renderDebugFilter(settings);
    renderAlerts(settings);
  }

  // ---------- Alerts ----------

  function renderAlerts(settings) {
    const cfg = IkaDios.alerts.normalize(settings.alerts);
    const save = (patch) => patchSettings({ alerts: { ...cfg, ...patch } });
    const setType = (id, patch) => save({ types: { ...cfg.types, [id]: { ...cfg.types[id], ...patch } } });

    const severity = el(
      'select',
      { onchange: (e) => save({ desktopMinSeverity: e.target.value }) },
      ['critical', 'warning', 'info'].map((s) => el('option', { value: s, text: t(`optAlertsMin_${s}`) }))
    );
    severity.value = cfg.desktopMinSeverity;

    const rows = IkaDios.alerts.TYPES.map((type) => {
      const conf = cfg.types[type.id];
      return el('tr', {}, [
        el('td', {}, el('label', { class: 'check' }, [
          el('input', { type: 'checkbox', checked: conf.enabled !== false ? true : null, onchange: (e) => setType(type.id, { enabled: e.target.checked }) }),
          el('span', { text: t(`optAlert_${type.id}`) }),
        ])),
        el('td', { class: 'muted', text: t(`optAlertsSeverity_${type.severity}`) }),
        el('td', {}, type.threshold !== undefined
          ? el('label', { class: 'check' }, [
              el('input', {
                type: 'number',
                step: '1',
                value: String(conf.threshold ?? type.threshold),
                style: { width: '80px' },
                onchange: (e) => setType(type.id, { threshold: Number(e.target.value) }),
              }),
              el('span', { class: 'muted', text: t(`optAlertUnit_${type.id}`) }),
            ])
          : null),
      ]);
    });

    $('alertsPanel').replaceChildren(
      el('label', { class: 'row' }, [
        el('input', { type: 'checkbox', checked: cfg.desktop ? true : null, onchange: (e) => save({ desktop: e.target.checked }) }),
        el('span', { text: t('optAlertsDesktop') }),
        severity,
      ]),
      el('table', { class: 'alerts-table' }, el('tbody', {}, rows))
    );
  }

  // ---------- Raw capture filter ----------

  const captureFilter = IkaDios.captureFilter;

  function patchFilter(settings, patch) {
    return patchSettings({ debugFilter: { ...captureFilter.normalize(settings.debugFilter), ...patch } });
  }

  function renderDebugState(settings) {
    const node = $('debugState');
    const filter = captureFilter.normalize(settings.debugFilter);
    if (!captureFilter.isActive(settings)) {
      node.textContent = t(settings.debugCapture ? 'optDebugExpired' : 'optDebugOff');
      return;
    }
    node.textContent = filter.until
      ? t('optDebugOnUntil', { when: i18n.formatRelative(filter.until) })
      : t('optDebugOnForever');
  }

  function renderDebugFilter(settings) {
    const filter = captureFilter.normalize(settings.debugFilter);
    const box = (label, checked, onchange) =>
      el('label', { class: 'check' }, [
        el('input', { type: 'checkbox', checked: checked ? true : null, onchange: (e) => onchange(e.target.checked) }),
        el('span', { text: label }),
      ]);

    const duration = el(
      'select',
      {
        id: 'selDebugDuration',
        onchange: (e) => {
          const minutes = Number(e.target.value);
          patchFilter(settings, { until: minutes ? Date.now() + minutes * 60000 : null });
        },
      },
      captureFilter.DURATIONS_MIN.map((m) => el('option', { value: String(m), text: m ? t('optDebugFor', { n: m }) : t('optDebugNoLimit') }))
    );
    // Show the closest option to the remaining time
    const left = filter.until ? Math.max(0, filter.until - Date.now()) / 60000 : 0;
    duration.value = String(
      !settings.debugCapture ? 30 : filter.until ? captureFilter.DURATIONS_MIN.find((m) => m && left <= m) || 60 : 0
    );

    const views = el('input', {
      type: 'text',
      value: filter.views,
      placeholder: 'militaryAdvisor, island',
      spellcheck: 'false',
      onchange: (e) => patchFilter(settings, { views: captureFilter.viewList(e.target.value).join(', ') }),
    });

    $('debugFilter').replaceChildren(
      el('div', { class: 'filter-block' }, [el('strong', { text: t('optDebugDuration') }), duration]),
      el('div', { class: 'filter-block' }, [
        el('strong', { text: t('optDebugSources') }),
        el('div', { class: 'filter-group' }, [
          box(t('optDebugSource_tab'), filter.sources.tab, (on) => patchFilter(settings, { sources: { ...filter.sources, tab: on } })),
          box(t('optDebugSource_refresh'), filter.sources.refresh, (on) => patchFilter(settings, { sources: { ...filter.sources, refresh: on } })),
        ]),
      ]),
      el('div', { class: 'filter-block' }, [
        el('strong', { text: t('optDebugGroups') }),
        el(
          'div',
          { class: 'filter-group' },
          captureFilter.GROUPS.map((g) => box(t(`optDebugGroup_${g}`), filter.groups[g], (on) => patchFilter(settings, { groups: { ...filter.groups, [g]: on } })))
        ),
      ]),
      el('div', { class: 'filter-block' }, [el('strong', { text: t('optDebugViews') }), views, el('span', { class: 'muted', text: t('optDebugViewsHint') })])
    );
    renderDebugState(settings);
  }

  // ---------- Packs ----------

  function showMessage(text, isError = false) {
    const node = $('packMessage');
    node.textContent = text;
    node.classList.toggle('is-error', isError);
  }

  function packName(pack) {
    return packs.localized(pack.name, i18n.locale) || pack.id;
  }

  function thumb(src, pixelated = false) {
    const node = el('span', { class: `thumb ${pixelated ? 'is-pixelated' : ''}` });
    if (src) node.style.backgroundImage = `url("${src}")`;
    return node;
  }

  async function renderPacks() {
    const [all, activeId] = await Promise.all([packs.getPacks(), packs.getActivePackId()]);
    const list = Object.values(all).sort((a, b) => (a.builtin ? -1 : b.builtin ? 1 : packName(a).localeCompare(packName(b))));
    $('packList').replaceChildren(
      ...list.map((pack) => {
        const isActive = pack.id === activeId;
        return el('li', { class: `pack ${isActive ? 'is-active' : ''}` }, [
          el('div', { class: 'thumbs' }, packs.ADVISORS.map((a) => thumb(pack.advisors?.[a]?.normal, pack.pixelated))),
          el('div', { class: 'info' }, [
            el('strong', { text: packName(pack) }),
            el('small', { text: pack.author ? t('optByAuthor', { author: pack.author }) : '' }),
          ]),
          el('div', { class: 'actions' }, [
            isActive
              ? el('span', { class: 'muted', text: t('optActive') })
              : el('button', { class: 'primary', text: t('optActivate'), onclick: () => activate(pack.id) }),
            pack.builtin ? null : el('button', { text: t('edit'), onclick: () => openEditor(pack) }),
            el('button', { text: t('optDuplicate'), onclick: () => duplicate(pack) }),
            pack.builtin ? null : el('button', { text: t('optExport'), onclick: () => exportPack(pack) }),
            pack.builtin ? null : el('button', { class: 'danger', text: t('delete'), onclick: () => removePack(pack) }),
          ]),
        ]);
      })
    );
  }

  async function activate(id) {
    await packs.setActivePackId(id);
    renderPacks();
  }

  async function duplicate(pack) {
    const copy = packs.sanitizePack({ ...structuredClone(pack), id: null });
    copy.name = t('optCopyOf', { name: packName(pack) });
    await packs.savePack(copy);
    renderPacks();
    openEditor(copy);
  }

  async function removePack(pack) {
    if (!confirm(t('optConfirmDelete', { name: packName(pack) }))) return;
    await packs.deletePack(pack.id);
    if (editing?.id === pack.id) closeEditor();
    renderPacks();
  }

  function download(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    el('a', { href: url, download: filename }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportPack(pack) {
    const { builtin, ...data } = pack;
    const safe = packName(pack).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'pack';
    download(`ikadios-pack-${safe}.json`, data);
  }

  async function importFile(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const check = packs.validatePack(parsed);
      if (!check.ok) {
        showMessage(t('optImportFailed', { reason: check.errors.map((e) => t(e)).join(', ') }), true);
        return;
      }
      const clean = packs.sanitizePack(parsed);
      const existing = await packs.getPacks();
      // Never overwrite an installed pack silently
      if (existing[clean.id]) clean.id = packs.newPack(clean.name).id;
      await packs.savePack(clean);
      showMessage(t('optImported', { name: packName(clean) }));
      renderPacks();
    } catch (err) {
      warn('import failed', err);
      showMessage(t('optImportFailed', { reason: t('packErrNotJson') }), true);
    }
  }

  // ---------- Editor ----------

  function openEditor(pack) {
    editing = structuredClone(pack);
    $('edName').value = packName(editing);
    $('edAuthor').value = editing.author || '';
    renderEditor();
    $('editor').hidden = false;
    $('editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closeEditor() {
    editing = null;
    $('editor').hidden = true;
  }

  function renderEditor() {
    $('edHead').replaceChildren(
      el('tr', {}, [el('th', { text: t('optAdvisor') }), ...packs.STATES.map((s) => el('th', { text: t(`advisorState_${s}`) }))])
    );
    $('edBody').replaceChildren(
      ...packs.ADVISORS.map((advisor) => {
        const entry = (editing.advisors[advisor] = editing.advisors[advisor] || {});
        const labelInput = el('input', {
          type: 'text',
          class: 'label-input',
          maxlength: '30',
          placeholder: t('optLabelPlaceholder'),
          value: packs.localized(entry.label, i18n.locale),
          oninput: (e) => {
            const map = typeof entry.label === 'object' && entry.label ? entry.label : {};
            map[i18n.locale] = e.target.value;
            entry.label = map;
          },
        });
        return el('tr', {}, [
          el('td', {}, [el('strong', { text: t(`advisor_${advisor}`) }), labelInput]),
          ...packs.STATES.map((state) => el('td', {}, slot(entry, state))),
        ]);
      })
    );
  }

  function slot(entry, state) {
    const input = el('input', { type: 'file', accept: packs.ALLOWED_MIME.join(','), hidden: true });
    const preview = entry[state] ? thumb(entry[state]) : el('span', { class: 'thumb is-empty', text: '+' });
    preview.title = t('optPickImage');
    preview.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        entry[state] = await processImage(file);
        renderEditor();
      } catch (err) {
        warn('image failed', err);
        showMessage(t('packErrImageType'), true);
      }
    });
    return el('div', { class: 'slot' }, [
      preview,
      input,
      entry[state]
        ? el('button', {
            class: 'remove',
            text: t('remove'),
            onclick: () => {
              delete entry[state];
              renderEditor();
            },
          })
        : null,
    ]);
  }

  function readAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  // Scales images down to IMAGE_MAX_SIDE. GIFs are kept as-is to preserve animation.
  async function processImage(file) {
    if (!packs.ALLOWED_MIME.includes(file.type)) throw new Error('mime');
    if (file.type === 'image/gif') return readAsDataUrl(file);
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL('image/webp', 0.9);
  }

  async function saveEditor() {
    const name = $('edName').value.trim();
    if (!name) {
      showMessage(t('packErrName'), true);
      return;
    }
    editing.name = typeof editing.name === 'object' ? { ...editing.name, [i18n.locale]: name } : name;
    editing.author = $('edAuthor').value.trim();
    for (const advisor of packs.ADVISORS) {
      const entry = editing.advisors[advisor];
      if (!entry) continue;
      const hasContent = packs.STATES.some((s) => entry[s]) || packs.localized(entry.label, i18n.locale);
      if (!hasContent) delete editing.advisors[advisor];
    }
    const check = packs.validatePack(editing);
    if (!check.ok) {
      showMessage(check.errors.map((e) => t(e)).join(', '), true);
      return;
    }
    await packs.savePack(packs.sanitizePack(editing));
    showMessage(t('optSaved'));
    closeEditor();
    renderPacks();
  }

  // ---------- Discord ----------

  const KEY_DISCORD = 'discord';
  const discordEvents = IkaDios.discordEvents;

  async function getDiscord() {
    const stored = (await chrome.storage.local.get(KEY_DISCORD))[KEY_DISCORD] || {};
    const config = { webhooks: [], summaryHours: 6, mentionOnAttack: true, ...stored };
    return { ...config, webhooks: config.webhooks.map(discordEvents.normalize) };
  }

  async function patchDiscord(patch) {
    const current = await getDiscord();
    await chrome.storage.local.set({ [KEY_DISCORD]: { ...current, ...patch } });
  }

  async function updateWebhook(id, patch) {
    const config = await getDiscord();
    await patchDiscord({ webhooks: config.webhooks.map((w) => (w.id === id ? { ...w, ...patch } : w)) });
  }

  function discordMessage(text, isError = false) {
    const node = $('discordMessage');
    node.textContent = text;
    node.classList.toggle('is-error', isError);
  }

  // Own cities of the last seen account, for the per-webhook city filter
  async function knownCities() {
    const { lastAccount } = await chrome.storage.local.get('lastAccount');
    if (!lastAccount?.key) return [];
    const snap = (await chrome.storage.local.get(lastAccount.key))[lastAccount.key];
    return Object.values(snap?.cities || {})
      .filter((c) => c?.id)
      .map((c) => ({ id: String(c.id), name: c.name || String(c.id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function checkbox(label, checked, onchange, extra = {}) {
    return el('label', { class: 'check', title: extra.title }, [
      el('input', { type: 'checkbox', checked: checked ? true : null, onchange: (e) => onchange(e.target.checked) }),
      el('span', { text: label }),
      extra.badge ? el('small', { class: 'badge-soon', text: extra.badge }) : null,
    ]);
  }

  function webhookItem(w, cities) {
    const url = el('input', {
      type: 'url',
      value: w.url || '',
      placeholder: 'https://discord.com/api/webhooks/...',
      autocomplete: 'off',
      spellcheck: 'false',
      class: w.url && !IkaDios.util.isDiscordWebhook(w.url) ? 'invalid' : '',
      onchange: (e) => {
        const value = e.target.value.trim();
        const invalid = !!value && !IkaDios.util.isDiscordWebhook(value);
        e.target.classList.toggle('invalid', invalid);
        if (invalid) discordMessage(t('optWebhookInvalid'), true);
        updateWebhook(w.id, { url: value });
      },
    });
    const name = el('input', {
      type: 'text',
      value: w.name || '',
      maxlength: '40',
      placeholder: t('optWebhookName'),
      onchange: (e) => updateWebhook(w.id, { name: e.target.value.trim() }),
    });

    // Message types, grouped; types not implemented yet can be assigned ahead
    const groups = {};
    for (const ev of discordEvents.EVENTS) (groups[ev.group] = groups[ev.group] || []).push(ev);
    const eventsBox = el(
      'div',
      { class: 'filter-block' },
      [
        el('strong', { text: t('optWebhookTypes') }),
        ...Object.entries(groups).map(([group, list]) =>
          el('div', { class: 'filter-group' }, [
            el('span', { class: 'muted', text: t(`optEventGroup_${group}`) }),
            ...list.map((ev) =>
              checkbox(
                t(`optEvent_${ev.id}`),
                w.events[ev.id],
                (on) => updateWebhook(w.id, { events: { ...w.events, [ev.id]: on } }),
                ev.available ? {} : { badge: t('optSoon'), title: t('optSoonHint') }
              )
            ),
          ])
        ),
      ]
    );

    // City filter: none selected means every city
    const cityBox = el('div', { class: 'filter-block' }, [
      el('strong', { text: t('optWebhookCities') }),
      el('span', { class: 'muted', text: w.cities.length ? t('optWebhookCitiesSome', { n: w.cities.length }) : t('optWebhookCitiesAll') }),
      el(
        'div',
        { class: 'filter-group' },
        cities.length
          ? cities.map((c) =>
              checkbox(c.name, w.cities.includes(c.id), (on) =>
                updateWebhook(w.id, { cities: on ? [...new Set([...w.cities, c.id])] : w.cities.filter((x) => x !== c.id) })
              )
            )
          : [el('span', { class: 'muted', text: t('optNoAccounts') })]
      ),
    ]);

    const sectionsBox = el('div', { class: 'filter-block' }, [
      el('strong', { text: t('optWebhookSections') }),
      el(
        'div',
        { class: 'filter-group' },
        discordEvents.SUMMARY_SECTIONS.map((section) =>
          checkbox(t(`optSection_${section}`), w.summarySections[section], (on) =>
            updateWebhook(w.id, { summarySections: { ...w.summarySections, [section]: on } })
          )
        )
      ),
    ]);

    return el('li', { class: 'webhook' }, [
      name,
      url,
      el('div', { class: 'events' }, [
        checkbox(t('optWebhookEnabled'), w.enabled !== false, (on) => updateWebhook(w.id, { enabled: on })),
      ]),
      el('details', { class: 'filters' }, [el('summary', { text: t('optWebhookFilters') }), eventsBox, cityBox, sectionsBox]),
      el('div', { class: 'actions' }, [
        el('button', {
          text: t('optWebhookTest'),
          onclick: async () => {
            discordMessage(t('optWebhookSending'));
            const res = await chrome.runtime.sendMessage({ type: 'ikadios:discordTest', webhookId: w.id });
            discordMessage(res?.ok ? t('optWebhookTestOk') : t('optWebhookTestFailed', { reason: res?.error || '?' }), !res?.ok);
          },
        }),
        el('button', {
          class: 'danger',
          text: t('delete'),
          onclick: async () => {
            if (!confirm(t('optWebhookConfirmDelete', { name: w.name || w.url || '' }))) return;
            const config = await getDiscord();
            await patchDiscord({ webhooks: config.webhooks.filter((x) => x.id !== w.id) });
          },
        }),
      ]),
    ]);
  }

  async function renderDiscord() {
    const [config, cities] = await Promise.all([getDiscord(), knownCities()]);
    $('numSummaryHours').value = config.summaryHours;
    $('chkMention').checked = !!config.mentionOnAttack;
    // Keep open filter panels open across re-renders
    const open = new Set([...document.querySelectorAll('#webhookList details[open]')].map((d) => d.closest('li')?.dataset.id));
    $('webhookList').replaceChildren(
      ...config.webhooks.map((w) => {
        const item = webhookItem(w, cities);
        item.dataset.id = w.id;
        if (open.has(w.id)) item.querySelector('details').open = true;
        return item;
      })
    );
  }

  // ---------- Alliance bot ----------

  const KEY_ALLIANCE = 'allianceBot';

  async function getAlliance() {
    return { pollMinutes: 5, ...((await chrome.storage.local.get(KEY_ALLIANCE))[KEY_ALLIANCE] || {}) };
  }

  async function patchAlliance(patch) {
    await chrome.storage.local.set({ [KEY_ALLIANCE]: { ...(await getAlliance()), ...patch } });
  }

  async function renderAlliance() {
    const config = await getAlliance();
    $('chkAlliance').checked = !!config.enabled;
    // The token is never shown back; a placeholder says whether one is stored
    $('txtAllianceToken').value = '';
    $('txtAllianceToken').placeholder = config.token ? t('optAllianceTokenStored') : '';
    $('txtAllianceChannel').value = config.channelId || '';
    $('numAlliancePoll').value = config.pollMinutes;
    $('chkAllianceAutoSpy').checked = !!config.autoSpy;
    $('chkAllianceAutoPlans').checked = !!config.autoPlans;
    $('chkAllianceAutoNotes').checked = !!config.autoNotes;
    $('chkAllianceAutoStatus').checked = !!config.autoStatus;
    $('numAllianceStatusHours').value = config.statusHours || 2;
    const status = await chrome.runtime.sendMessage({ type: 'ikadios:allianceStatus' }).catch(() => null);
    const st = status?.state || {};
    const counts = Object.entries(st.counts || {}).map(([k, n]) => `${t(`allianceKind_${k}`)}: ${n}`).join(', ');
    $('allianceState').textContent = st.lastPollAt
      ? t('optAllianceLastPoll', { when: i18n.formatRelative(st.lastPollAt), counts: counts || '0', error: st.lastError || '' })
      : '';
  }

  function allianceMessage(text, isError = false) {
    const box = $('allianceMessage');
    box.textContent = text;
    box.classList.toggle('error', isError);
  }

  function allianceError(res) {
    if (res?.error === 'incomplete' || res?.error === 'no-bot') return t('optAllianceIncomplete');
    if (res?.status === 401) return t('optAllianceBadToken');
    if (res?.status === 403 && res.code === 40333) return t('optAllianceBlocked');
    if (res?.status === 403 && res.code === 50013) return t('optAllianceMissingPermissions');
    if (res?.status === 403) return t('optAllianceNoAccess');
    if (res?.status === 404) return t('optAllianceNoChannel');
    return t('discordFailedReason', { reason: res?.error || '?' });
  }

  // ---------- Captured data ----------

  async function renderData() {
    const all = await chrome.storage.local.get(null);
    const counted = await chrome.runtime.sendMessage({ type: 'ikadios:captureCount' }).catch(() => null);
    $('debugCount').textContent = t('optDebugCount', { n: counted?.count ?? 0 });
    const accounts = Object.keys(all).filter((k) => k.startsWith('snap:'));
    $('accountList').replaceChildren(
      ...(accounts.length
        ? accounts.map((key) => {
            const snap = all[key];
            const cities = Object.keys(snap?.cities || {}).length;
            return el('li', {}, [
              el('span', { text: `${snap?.account?.world || key} - ${t('optCitiesCount', { n: cities })}` }),
              el('button', { text: t('optExport'), onclick: () => download(`ikadios-${key.replace(/:/g, '_')}.json`, snap) }),
              el('button', {
                class: 'danger',
                text: t('delete'),
                onclick: async () => {
                  if (!confirm(t('optConfirmDeleteAccount'))) return;
                  await chrome.storage.local.remove(key);
                  renderData();
                },
              }),
            ]);
          })
        : [el('li', {}, el('span', { class: 'muted', text: t('optNoAccounts') }))])
    );
  }

  async function exportDebug() {
    const res = await chrome.runtime.sendMessage({ type: 'ikadios:captureList' }).catch(() => null);
    const list = res?.entries || [];
    download(`ikadios-captures-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.json`, list);
  }

  // ---------- Wiring ----------

  function wire() {
    $('btnNewPack').addEventListener('click', () => openEditor(packs.newPack(t('optNewPackName'))));
    $('btnSavePack').addEventListener('click', saveEditor);
    $('btnCancelEdit').addEventListener('click', closeEditor);
    $('inputImport').addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) importFile(file);
      e.target.value = '';
    });

    const drop = $('dropZone');
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('is-over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
      for (const file of e.dataTransfer.files) importFile(file);
    });

    $('btnAddWebhook').addEventListener('click', async () => {
      const config = await getDiscord();
      await patchDiscord({ webhooks: [...config.webhooks, discordEvents.defaultWebhook()] });
    });
    $('numSummaryHours').addEventListener('change', (e) => {
      const hours = Math.min(72, Math.max(1, Math.round(Number(e.target.value) || 6)));
      e.target.value = hours;
      patchDiscord({ summaryHours: hours });
    });
    $('chkMention').addEventListener('change', (e) => patchDiscord({ mentionOnAttack: e.target.checked }));

    $('selLanguage').addEventListener('change', (e) => patchSettings({ language: e.target.value }));
    $('numAutoMinutes').addEventListener('change', (e) => {
      const minutes = Math.min(720, Math.max(10, Math.round(Number(e.target.value) || 30)));
      e.target.value = minutes;
      patchSettings({ autoRefreshMinutes: minutes });
    });
    $('chkDebug').addEventListener('change', async (e) => {
      const settings = await getSettings();
      const filter = captureFilter.normalize(settings.debugFilter);
      // Turning it on starts the duration chosen in the selector (0 = no limit)
      const minutes = Number($('selDebugDuration')?.value ?? 30);
      const until = e.target.checked && minutes ? Date.now() + minutes * 60000 : null;
      await patchSettings({ debugCapture: e.target.checked, debugFilter: { ...filter, until } });
    });
    // Keep the "recording, ends in..." line current
    setInterval(async () => renderDebugState(await getSettings()), 30000);
    $('chkAlliance').addEventListener('change', (e) => patchAlliance({ enabled: e.target.checked }));
    $('txtAllianceToken').addEventListener('change', (e) => {
      const token = e.target.value.trim();
      if (token) patchAlliance({ token });
    });
    $('txtAllianceChannel').addEventListener('change', (e) => {
      const id = e.target.value.trim();
      if (!id || /^\d{5,25}$/.test(id)) patchAlliance({ channelId: id });
      else allianceMessage(t('optAllianceNoChannel'), true);
    });
    $('numAlliancePoll').addEventListener('change', (e) => {
      const n = Math.round(Number(e.target.value));
      if (n >= 2 && n <= 60) patchAlliance({ pollMinutes: n });
    });
    $('numAllianceStatusHours').addEventListener('change', (e) => {
      const n = Math.round(Number(e.target.value));
      if (n >= 1 && n <= 24) patchAlliance({ statusHours: n });
    });
    for (const [id, key] of [['chkAllianceAutoSpy', 'autoSpy'], ['chkAllianceAutoPlans', 'autoPlans'], ['chkAllianceAutoNotes', 'autoNotes'], ['chkAllianceAutoStatus', 'autoStatus']]) {
      $(id).addEventListener('change', (e) => patchAlliance({ [key]: e.target.checked }));
    }
    $('btnAllianceTest').addEventListener('click', async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      const res = await chrome.runtime.sendMessage({ type: 'ikadios:allianceTest' }).catch((err) => ({ ok: false, error: String(err) }));
      button.disabled = false;
      allianceMessage(res?.ok ? t('optAllianceOk', { channel: res.channel }) : allianceError(res), !res?.ok);
    });
    $('btnAlliancePoll').addEventListener('click', async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      const res = await chrome.runtime.sendMessage({ type: 'ikadios:alliancePoll' }).catch((err) => ({ ok: false, error: String(err) }));
      button.disabled = false;
      allianceMessage(res?.ok ? t('optAlliancePolled', { n: res.read }) : allianceError(res), !res?.ok);
    });
    $('btnExportDebug').addEventListener('click', exportDebug);
    $('btnClearDebug').addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'ikadios:captureClear' }).catch(() => null);
      renderData();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[packs.KEY_PACKS] || changes[packs.KEY_ACTIVE]) renderPacks();
      // Inputs save on change (blur), so re-rendering never interrupts typing
      if (changes[KEY_DISCORD]) renderDiscord();
      if (changes[KEY_ALLIANCE] || changes.allianceBotState) renderAlliance();
      if (Object.keys(changes).some((k) => k.startsWith('snap:'))) renderData();
      if (changes[KEY_SETTINGS]) {
        const next = changes[KEY_SETTINGS].newValue || {};
        $('chkDebug').checked = !!next.debugCapture;
        renderDebugFilter(next);
        renderAlerts(next);
      }
    });
  }

  function renderAll() {
    i18n.applyDom();
    renderGeneral();
    renderPacks();
    renderDiscord();
    renderAlliance();
    renderData();
    if (editing) renderEditor();
  }

  async function start() {
    await i18n.init();
    i18n.onChange(renderAll);
    wire();
    renderAll();
  }

  start();
})();

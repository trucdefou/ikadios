// Players tab: the profile of any player. Cities and levels come from the world
// data (ika-map.com, see world-data.js); the rest is what IkaDios already knows:
// spy reports on the player, battles against them, and the user's own note and
// relation tag (playerNotes:<world>, small). Distances and travel times are from
// the nearest own city. Persistent tab: the search keeps its text across updates.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { el } = IkaDios.util;
  const share = IkaDios.share;

  const TAGS = ['', 'ally', 'friend', 'neutral', 'target', 'enemy', 'noTouch'];
  const TAG_COLORS = { ally: '#2e9e44', friend: '#1f6fd1', neutral: '#8a6a45', target: '#ef6c00', enemy: '#e0312b', noTouch: '#7b1fa2' };
  const MAX_NOTE = 1000;

  const state = { query: '', player: null, notes: null, notesWorld: null, world: null };
  let mounted = null;

  const lower = (s) => String(s || '').toLowerCase();
  const notesKey = (world) => `playerNotes:${world}`;

  async function loadNotes(world) {
    if (state.notesWorld === world && state.notes) return state.notes;
    state.notesWorld = world;
    state.notes = (await chrome.storage.local.get(notesKey(world)))[notesKey(world)] || {};
    return state.notes;
  }

  async function saveNote(name, patch) {
    const key = lower(name);
    const next = { ...(state.notes[key] || {}), ...patch, name, updatedAt: Date.now() };
    if (!next.note && !next.tag && !next.shared?.length) delete state.notes[key];
    else state.notes[key] = next;
    await chrome.storage.local.set({ [notesKey(state.notesWorld)]: state.notes });
  }

  // Notes imported by the worker (alliance bot) show up without reopening the tab
  if (IkaDios.util.extensionAlive()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !state.notesWorld || !changes[notesKey(state.notesWorld)]) return;
      state.notes = changes[notesKey(state.notesWorld)].newValue || {};
      if (mounted?.container.isConnected) fill(mounted.container, mounted.snapshot, mounted.helpers);
    });
  }

  // ---------- Data ----------

  function playerCities(world, name) {
    const out = [];
    for (const island of world?.islands || []) {
      for (const c of island.cities) if (lower(c.player) === lower(name)) out.push({ ...c, island });
    }
    return out.sort((a, b) => a.island.x - b.island.x || a.island.y - b.island.y);
  }

  function allPlayers(world) {
    const names = new Map();
    for (const island of world?.islands || []) for (const c of island.cities) if (c.player) names.set(lower(c.player), c.player);
    return [...names.values()].sort((a, b) => a.localeCompare(b));
  }

  function nearestOwn(snapshot, x, y) {
    let best = null;
    for (const c of IkaDios.facets.ownCities(snapshot)) {
      if (!c.coords) continue;
      const d = Math.hypot(c.coords.x - x, c.coords.y - y);
      if (!best || d < best.d) best = { d, city: c };
    }
    return best;
  }

  function spyReportsOn(snapshot, name) {
    return Object.values(snapshot?.espionage?.reports || {})
      .filter((r) => lower(r.owner) === lower(name))
      .sort((a, b) => (b.date || 0) - (a.date || 0));
  }

  function battlesWith(snapshot, name) {
    return Object.values(snapshot?.military?.combats || {})
      .filter((c) => lower(c.owner) === lower(name))
      .sort((a, b) => (b.date || 0) - (a.date || 0));
  }

  // ---------- Profile ----------

  function header(name, cities, note, i18n) {
    const { t, formatNumber } = i18n;
    const ally = cities.find((c) => c.ally)?.ally;
    const states = [...new Set(cities.map((c) => c.state).filter(Boolean))];
    const levels = cities.map((c) => c.level || 0);
    const total = levels.reduce((a, n) => a + n, 0);
    const { kpi } = IkaDios.overlayHelpers;
    return el('div', {}, [
      el('h3', { class: 'section-title' }, [
        note?.tag ? el('span', { class: 'swatch', style: { background: TAG_COLORS[note.tag] } }) : null,
        ` ${name}${ally ? ` [${ally}]` : ''}`,
        states.length ? el('span', { class: 'age', text: ` (${states.map((s) => i18n.tOr(`playerState_${s}`, s)).join(', ')})` }) : null,
      ]),
      el('div', { class: 'kpis' }, [
        kpi(t('playerCities'), formatNumber(cities.length)),
        kpi(t('playerTotalLevel'), formatNumber(total)),
        kpi(t('playerAvgLevel'), cities.length ? formatNumber(total / cities.length, { maximumFractionDigits: 1 }) : '-'),
        kpi(t('playerMaxLevel'), cities.length ? formatNumber(Math.max(...levels)) : '-'),
      ]),
    ]);
  }

  function citiesTable(snapshot, cities, i18n, openTab) {
    const { t } = i18n;
    if (!cities.length) return el('p', { class: 'empty', text: t('playerNoCities') });
    return el('div', { class: 'scroll-x' }, el('table', { class: 'grid' }, [
      el('thead', {}, el('tr', {}, [t('city'), t('mapCoords'), t('mapLevel'), t('playerIslandRes'), t('playerNearest'), t('playerTravel'), t('mapState'), ''].map((h) => el('th', { text: h })))),
      el('tbody', {}, cities.map((c) => {
        const near = nearestOwn(snapshot, c.island.x, c.island.y);
        const tg = { 1: 'wine', 2: 'marble', 3: 'glass', 4: 'sulfur' }[c.island.tradegood];
        const travel = near ? IkaDios.fleetTrack.travelMs(near.city.coords, c.island) : null;
        return el('tr', { class: c.state ? `st-${c.state}` : '' }, [
          el('td', { text: c.name }),
          el('td', {}, el('button', { class: 'link', text: `[${c.island.x}:${c.island.y}]`, title: t('islandsShowOnMap'), onclick: () => openTab('map', { center: { x: c.island.x, y: c.island.y } }) })),
          el('td', { class: 'num', text: String(c.level ?? '-') }),
          el('td', { text: [`${t('resourceShort_wood')} ${c.island.wood ?? '-'}`, tg ? `${t(`resourceShort_${tg}`)} ${c.island.tradegoodLevel ?? '-'}` : null].filter(Boolean).join(' | ') }),
          el('td', { text: near ? `${near.city.name} (${i18n.formatNumber(near.d, { maximumFractionDigits: 1 })})` : '-' }),
          el('td', { class: 'nowrap', title: t('playerTravelHint'), text: travel ? i18n.formatDuration(Math.round(travel / 1000)) : '-' }),
          el('td', { class: 'age', text: c.state ? i18n.tOr(`playerState_${c.state}`, c.state) : '' }),
          el('td', {}, el('button', {
            class: 'link',
            text: t('planAttack'),
            onclick: () => openTab('military', { plan: { x: c.island.x, y: c.island.y, name: c.name, player: c.player } }),
          })),
        ]);
      })),
    ]));
  }

  function reportsList(reports, i18n, openTab) {
    const { t } = i18n;
    if (!reports.length) return el('p', { class: 'empty', text: t('playerNoSpyReports') });
    return el('table', { class: 'grid' }, el('tbody', {}, reports.slice(0, 20).map((r) =>
      el('tr', {}, [
        el('td', { class: 'nowrap', text: r.date ? i18n.formatTime(r.date) : r.dateText || '-' }),
        el('td', { text: r.subject || '-' }),
        el('td', {}, r.x != null ? el('button', { class: 'link', text: `${r.city} [${r.x}:${r.y}]`, onclick: () => openTab('map', { center: { x: r.x, y: r.y } }) }) : r.city),
        el('td', { text: r.result || '-' }),
        el('td', {}, IkaDios.icons.button('resume', t('spyReportShow'), () => openTab('espionage'))),
      ])
    )));
  }

  function battlesList(combats, i18n, openTab) {
    const { t } = i18n;
    if (!combats.length) return el('p', { class: 'empty', text: t('playerNoBattles') });
    return el('table', { class: 'grid' }, el('tbody', {}, combats.slice(0, 20).map((c) =>
      el('tr', {}, [
        el('td', { class: 'nowrap', text: c.date ? i18n.formatTime(c.date) : '-' }),
        el('td', { class: c.result === 'won' ? 'ok-text' : c.result === 'lost' ? 'warn' : '', text: t(`battle_${c.result || 'unknown'}`) }),
        el('td', { text: c.kind || '-' }),
        el('td', {}, c.x != null ? el('button', { class: 'link', text: `${c.place} [${c.x}:${c.y}]`, onclick: () => openTab('map', { center: { x: c.x, y: c.y } }) }) : c.place),
        el('td', { class: 'num', text: c.rounds != null ? String(c.rounds) : '-' }),
      ])
    )));
  }

  function noteBox(name, note, i18n, rerender) {
    const { t } = i18n;
    const status = el('span', { class: 'hint' });
    const tag = el('select', {}, TAGS.map((k) => el('option', { value: k, selected: (note?.tag || '') === k ? true : null, text: k ? t(`playerTag_${k}`) : t('playerTagNone') })));
    const text = el('textarea', { rows: '3', style: { width: '100%' }, maxlength: String(MAX_NOTE), placeholder: t('playerNotePlaceholder') });
    text.value = note?.note || '';
    return el('div', { class: 'trade-form' }, [
      el('div', { class: 'map-toolbar' }, [
        el('label', { class: 'check' }, [t('playerTag'), tag]),
        el('button', {
          class: 'refresh',
          text: t('polisAutoSave'),
          onclick: async () => {
            await saveNote(name, { tag: tag.value, note: text.value.slice(0, MAX_NOTE) });
            status.textContent = t('playerNoteSaved');
            rerender();
            if (tag.value || text.value.trim()) {
              const snap = mounted?.snapshot;
              IkaDios.allianceAuto?.maybe('autoNotes', async () => {
                const world = snap?.account?.world;
                const url = world ? await IkaDios.intelLink.build(world, 'player', { name, tag: tag.value, note: text.value.slice(0, MAX_NOTE) }, snap?.account?.playerName || '') : null;
                return {
                  title: t('playerShareTitle', { player: name }),
                  fields: [{ name: t('playerNote'), value: [tag.value ? t(`playerTag_${tag.value}`) : null, text.value].filter(Boolean).join('\n').slice(0, 1024) || '-' }],
                  links: url ? [{ label: t('intelOpenPlayer'), url }] : [],
                };
              });
            }
          },
        }),
        status,
      ]),
      text,
      note?.updatedAt ? el('p', { class: 'age', text: t('updated', { when: i18n.formatRelative(note.updatedAt) }) }) : null,
    ]);
  }

  // Notes other players shared about this player (links or the alliance bot)
  function sharedNotes(note, i18n) {
    const { t } = i18n;
    if (!note?.shared?.length) return null;
    return el('div', {}, [
      el('h3', { class: 'section-title', text: t('playerSharedNotes') }),
      el('table', { class: 'grid' }, el('tbody', {}, note.shared.map((s) =>
        el('tr', {}, [
          el('td', { text: s.from || '?' }),
          el('td', {}, s.tag ? [el('span', { class: 'swatch', style: { background: TAG_COLORS[s.tag] } }), ` ${t(`playerTag_${s.tag}`)}`] : '-'),
          el('td', { text: s.note || '' }),
          el('td', { class: 'age', text: s.at ? i18n.formatRelative(s.at) : '' }),
        ])
      ))),
    ]);
  }

  // Discord / WhatsApp: summary, cities with coordinates, the note
  function profileShare(name, cities, note, reports, combats, i18n) {
    const { t } = i18n;
    const ally = cities.find((c) => c.ally)?.ally;
    const lines = cities.map((c) => `${c.name} [${c.island.x}:${c.island.y}] ${t('mapLevel')} ${c.level ?? '-'}${c.state ? ` (${i18n.tOr(`playerState_${c.state}`, c.state)})` : ''}`);
    const fields = [{ name: t('playerCities'), value: (lines.join('\n') || '-').slice(0, 1024) }];
    if (note?.tag || note?.note) fields.push({ name: t('playerNote'), value: [note.tag ? t(`playerTag_${note.tag}`) : null, note.note].filter(Boolean).join('\n').slice(0, 1024) });
    if (reports.length) fields.push({ name: t('spyReports'), value: reports.slice(0, 5).map((r) => `${r.dateText || ''} ${r.subject}: ${r.result}`).join('\n').slice(0, 1024) });
    if (combats.length) fields.push({ name: t('battles'), value: combats.slice(0, 5).map((c) => `${c.dateText || ''} ${t(`battle_${c.result || 'unknown'}`)} ${c.place}`).join('\n').slice(0, 1024) });
    return { title: t('playerShareTitle', { player: `${name}${ally ? ` [${ally}]` : ''}` }), fields };
  }

  function profile(snapshot, world, i18n, helpers, rerender) {
    const { t } = i18n;
    const name = state.player;
    const cities = playerCities(world, name);
    const realName = cities[0]?.player || name;
    const note = state.notes?.[lower(realName)] || null;
    const reports = spyReportsOn(snapshot, realName);
    const combats = battlesWith(snapshot, realName);
    return el('div', { class: 'player-profile' }, [
      header(realName, cities, note, i18n),
      el('div', { class: 'map-toolbar' }, [
        el('button', {
          class: 'refresh',
          text: t('playerShowOnMap'),
          onclick: () => {
            const search = IkaDios.mapTab?.state?.searches?.[0];
            if (search) Object.assign(search, { kind: 'player', text: realName });
            const first = cities[0]?.island;
            helpers.openTab('map', first ? { center: { x: first.x, y: first.y } } : {});
          },
        }),
      ]),
      share.shareBar({
        i18n,
        scopeLabel: t('playerShare'),
        build: async () => {
          const content = profileShare(realName, cities, note, reports, combats, i18n);
          const world = snapshot?.account?.world;
          const from = snapshot?.account?.playerName || '';
          const ally = cities.find((c) => c.ally)?.ally || '';
          const url = world ? await IkaDios.intelLink.build(world, 'player', { name: realName, ally, tag: note?.tag || '', note: note?.note || '' }, from).catch(() => null) : null;
          return { ...content, links: url ? [{ label: t('intelOpenPlayer'), url }] : [] };
        },
      }),
      el('h3', { class: 'section-title', text: t('playerCities') }),
      citiesTable(snapshot, cities, i18n, helpers.openTab),
      el('h3', { class: 'section-title', text: t('playerNote') }),
      noteBox(realName, note, i18n, rerender),
      sharedNotes(note, i18n),
      el('h3', { class: 'section-title', text: t('spyReports') }),
      reportsList(reports, i18n, helpers.openTab),
      el('h3', { class: 'section-title', text: t('battles') }),
      battlesList(combats, i18n, helpers.openTab),
    ]);
  }

  // Players with a note or tag, for quick access
  function notedList(i18n, select) {
    const noted = Object.values(state.notes || {}).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!noted.length) return null;
    return el('div', { class: 'map-toolbar' }, [
      el('span', { class: 'hint', text: i18n.t('playerNoted') }),
      ...noted.slice(0, 30).map((n) =>
        el('button', { class: 'link', onclick: () => select(n.name) }, [n.tag ? el('span', { class: 'swatch', style: { background: TAG_COLORS[n.tag] } }) : null, ` ${n.name}`])
      ),
    ]);
  }

  // ---------- Tab ----------

  function fill(container, snapshot, helpers) {
    const { i18n } = helpers;
    const { t } = i18n;
    const body = container.querySelector('.players-body');
    if (!body) return;
    const world = IkaDios.worldData.current();
    const rerender = () => fill(container, snapshot, helpers);
    const select = (name) => {
      state.player = name;
      state.query = name;
      const input = container.querySelector('.players-search');
      if (input) input.value = name;
      rerender();
    };
    const list = container.querySelector('#ikadios-player-names');
    if (list && world && list.childElementCount === 0) list.replaceChildren(...allPlayers(world).map((p) => el('option', { value: p })));
    body.replaceChildren(
      ...[
        notedList(i18n, select),
        !world ? el('p', { class: 'empty', text: t('mapLoading') }) : null,
        world && state.player ? profile(snapshot, world, i18n, helpers, rerender) : null,
        world && !state.player ? el('p', { class: 'hint', text: t('playerSearchHint') }) : null,
      ].filter(Boolean)
    );
  }

  function render(container, snapshot, helpers) {
    const { i18n } = helpers;
    const { t } = i18n;
    mounted = { container, snapshot, helpers };
    const pending = IkaDios.tabs.pendingOptions;
    if (pending?.id === 'players' && pending.player) {
      IkaDios.tabs.pendingOptions = null;
      state.player = pending.player;
      state.query = pending.player;
    }
    const input = el('input', {
      type: 'text',
      class: 'players-search',
      list: 'ikadios-player-names',
      value: state.query,
      placeholder: t('playerSearchPlaceholder'),
      style: { minWidth: '220px' },
      onchange: (e) => {
        state.query = e.target.value.trim();
        state.player = state.query || null;
        fill(container, mounted.snapshot, helpers);
      },
    });
    container.append(
      el('datalist', { id: 'ikadios-player-names' }),
      el('div', { class: 'map-toolbar' }, [el('strong', { text: t('playerSearch') }), input]),
      el('div', { class: 'players-body' })
    );
    const world = snapshot?.account?.world;
    Promise.all([loadNotes(world || 'unknown'), world ? IkaDios.worldData.load(world).catch(() => null) : null]).then(() => {
      if (container.isConnected) fill(container, mounted.snapshot, helpers);
    });
    fill(container, snapshot, helpers);
  }

  function update(container, snapshot, helpers) {
    mounted = { container, snapshot, helpers };
    const pending = IkaDios.tabs.pendingOptions;
    if (pending?.id === 'players' && pending.player) {
      IkaDios.tabs.pendingOptions = null;
      state.player = pending.player;
      state.query = pending.player;
      const input = container.querySelector('.players-search');
      if (input) input.value = pending.player;
      fill(container, snapshot, helpers);
      return;
    }
    // Only the profile is redrawn; the search box keeps focus and text
    if (!container.querySelector('.player-profile textarea:focus, .player-profile select:focus')) fill(container, snapshot, helpers);
  }

  // Other tabs open a profile with openTab('players', { player })
  IkaDios.tabs.register({ id: 'players', labelKey: 'tab_players', order: 90, persistent: true, render, update });
  IkaDios.playersTab = { TAG_COLORS, loadNotes, notes: () => state.notes };
})(typeof self !== 'undefined' ? self : window);

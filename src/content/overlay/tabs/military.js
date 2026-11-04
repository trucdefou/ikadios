// Military tab: troops and ships per city (from each city's military view) with
// garrison limits from the town hall, and fleet / troop movements from the
// military advisor. Every row has a checkbox; the share bar sends the selected
// rows to Discord or WhatsApp.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { el } = IkaDios.util;
  const share = IkaDios.share;

  function cityTypes(cities, key) {
    return [...new Set(cities.flatMap((c) => Object.keys(c[key] || {}).filter((id) => c[key][id] > 0)))].sort();
  }

  function matrix(cities, key, names, i18n, garrisonKey) {
    const types = cityTypes(cities, key);
    if (!types.length) return el('p', { class: 'empty', text: i18n.t(key === 'units' ? 'militaryNoUnits' : 'militaryNoShips') });
    const totals = Object.fromEntries(types.map((id) => [id, 0]));
    const rows = cities.map((c) => {
      const total = types.reduce((sum, id) => sum + (c[key]?.[id] || 0), 0);
      for (const id of types) totals[id] += c[key]?.[id] || 0;
      const limit = c.townHall?.[garrisonKey];
      return el('tr', {}, [
        share.rowCheck(key, c.id),
        el('td', { class: 'city', 'data-updated': c.militaryUpdatedAt || null }, [
          el('span', { text: c.name || c.id }),
          el('small', { class: 'age', text: i18n.formatRelative(c.militaryUpdatedAt) }),
        ]),
        ...types.map((id) => el('td', { class: c[key]?.[id] ? '' : 'na', text: c[key]?.[id] ? i18n.formatNumber(c[key][id]) : '' })),
        el('td', { class: limit != null && total > limit ? 'warn' : '', text: limit != null ? `${i18n.formatNumber(total)} / ${i18n.formatNumber(limit)}` : i18n.formatNumber(total) }),
      ]);
    });
    return el('div', { class: 'scroll-x' }, el('table', { class: 'grid matrix' }, [
      el('thead', {}, el('tr', {}, [
        share.headCheck(key, cities.map((c) => c.id)),
        el('th', { text: i18n.t('city') }),
        ...types.map((id) => el('th', { class: 'rot', title: names[id] || id }, el('span', { text: names[id] || id }))),
        el('th', { text: i18n.t('militaryGarrison') }),
      ])),
      el('tbody', {}, [
        ...rows,
        el('tr', { class: 'total' }, [
          el('td', { text: '' }),
          el('td', { text: i18n.t('total') }),
          ...types.map((id) => el('td', { text: i18n.formatNumber(totals[id]) })),
          el('td', { text: '' }),
        ]),
      ]),
    ]));
  }

  function sortedMovements(snapshot, filter = () => true) {
    return (snapshot?.military?.movements || [])
      .filter(filter)
      .slice()
      .sort((a, b) => (b.hostile - a.hostile) || (a.arrivesAt || 0) - (b.arrivesAt || 0));
  }

  const endLabel = (p) => (p ? `${p.name}${p.player ? ` (${p.player})` : ''}` : '-');

  function forcesText(m, t) {
    return [m.ships ? t('militaryShipsN', { n: m.ships }) : null, m.units ? t('militaryUnitsN', { n: m.units }) : null].filter(Boolean).join(', ');
  }

  function cargoText(m, i18n) {
    return m.cargo.map((c) => `${i18n.t(`resourceShort_${c.resource}`)} ${i18n.formatNumber(c.amount)}`).join(', ');
  }

  function movementsTable(list, scope, i18n, countdown) {
    const { t } = i18n;
    if (!list.length) return el('p', { class: 'empty', text: t('militaryNoMovements') });
    return el('table', { class: 'grid' }, [
      el('thead', {}, el('tr', {}, [
        share.headCheck(scope, list.map((m) => m.id)),
        ...[t('militaryMission'), t('origin'), t('destination'), t('militaryForces'), t('cargo'), t('arrival')].map((h) => el('th', { text: h })),
      ])),
      el('tbody', {}, list.map((m) =>
        el('tr', { class: m.hostile ? 'hostile' : '' }, [
          share.rowCheck(scope, m.id),
          el('td', { text: m.text || m.mission || '-' }),
          el('td', { text: endLabel(m.origin) }),
          el('td', { text: endLabel(m.target) }),
          el('td', { class: 'num', text: forcesText(m, t) || '-' }),
          el('td', { text: cargoText(m, i18n) || '-' }),
          share.arrivalCell(m.arrivesAt, i18n, countdown),
        ])
      )),
    ]);
  }

  // One field per selected movement: "Plunder: Esparta (Enemigo) to Urantia (Dios)"
  function movementFields(list, scope, i18n) {
    const { t } = i18n;
    return list
      .filter((m) => !scope || share.isSelected(scope, m.id))
      .map((m) => ({
        name: t('shareMoveName', { mission: m.text || m.mission || '-', from: endLabel(m.origin), to: endLabel(m.target) }),
        value: [
          m.hostile ? t('shareHostile') : null,
          forcesText(m, t) || null,
          cargoText(m, i18n) ? `${t('cargo')}: ${cargoText(m, i18n)}` : null,
          m.arrivesAt ? `${t('arrival')}: ${share.arrivalText(m.arrivesAt, i18n)}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      }));
  }

  function forceFields(cities, key, names, i18n) {
    const types = cityTypes(cities, key);
    return cities
      .filter((c) => share.isSelected(key, c.id))
      .map((c) => {
        const list = types.filter((id) => c[key]?.[id]).map((id) => `${names[id] || id} ${i18n.formatNumber(c[key][id])}`);
        return list.length ? { name: `${c.name}: ${i18n.t(key === 'units' ? 'militaryUnits' : 'militaryShips')}`, value: list.join(', ') } : null;
      })
      .filter(Boolean);
  }

  // ---------- Battles: in progress (movements in combat) and finished (war reports) ----------

  // A battle in progress is linked to its war report when the report's place is
  // the movement's target and its last round is recent
  const MATCH_WINDOW_MS = 6 * 3600000;

  function battleRows(snapshot) {
    const combats = Object.values(snapshot?.military?.combats || {}).sort((a, b) => (b.date || 0) - (a.date || 0));
    const fights = (snapshot?.military?.movements || []).filter((m) => m.inFight || m.combatant);
    const linked = new Set();
    const rows = fights.map((m) => {
      // The movement's islandId is not reliable; an own target city gives exact coordinates
      const own = snapshot?.cities?.[m.target?.cityId]?.coords;
      const samePlace = (c) => (own && c.x != null ? c.x === own.x && c.y === own.y : c.islandId && c.islandId === m.target?.islandId);
      const combat = combats.find((c) => !linked.has(c.id) && samePlace(c) && Date.now() - (c.date || 0) < MATCH_WINDOW_MS);
      if (combat) linked.add(combat.id);
      return { key: `fight:${m.id}`, status: 'ongoing', movement: m, combat: combat || null };
    });
    for (const c of combats) {
      if (!linked.has(c.id)) rows.push({ key: `combat:${c.id}`, status: c.result || 'unknown', combat: c });
    }
    return rows;
  }

  const placeText = (row) => {
    if (row.combat) return `${row.combat.place}${row.combat.x != null ? ` [${row.combat.x}:${row.combat.y}]` : ''}`;
    return endLabel(row.movement?.target);
  };

  function battlesTable(rows, i18n, openTab, onView) {
    const { t } = i18n;
    if (!rows.length) return el('p', { class: 'empty', text: t('battlesNone') });
    const status = el('p', { class: 'hint' });
    return el('div', {}, [el('div', { class: 'scroll-x' }, el('table', { class: 'grid battles' }, [
      el('thead', {}, el('tr', {}, [
        share.headCheck('battles', rows.map((r) => r.key)),
        ...[t('battleStatus'), t('battleKind'), t('battlePlace'), t('battleOwner'), t('battleRounds'), t('battleLastRound'), ''].map((h) => el('th', { text: h })),
      ])),
      el('tbody', {}, rows.map((row) => {
        const c = row.combat;
        const m = row.movement;
        return el('tr', { class: row.status === 'ongoing' ? 'hostile' : '' }, [
          share.rowCheck('battles', row.key),
          el('td', { class: row.status === 'won' ? 'ok-text' : row.status === 'lost' ? 'warn' : '', text: t(`battle_${row.status}`) }),
          el('td', { text: c?.kind || m?.text || '-' }),
          el('td', {}, c?.x != null
            ? el('button', { class: 'link', text: placeText(row), title: t('islandsShowOnMap'), onclick: () => openTab('map', { center: { x: c.x, y: c.y } }) })
            : placeText(row)),
          el('td', {}, (c?.owner || m?.target?.player)
            ? el('button', { class: 'link', text: c?.owner || m.target.player, title: t('playerOpen'), onclick: () => openTab('players', { player: c?.owner || m.target.player }) })
            : '-'),
          el('td', { class: 'num', text: c?.rounds != null ? String(c.rounds) : '-' }),
          el('td', { class: 'nowrap', text: c?.date ? i18n.formatTime(c.date) : '-' }),
          el('td', {}, c ? IkaDios.icons.button('resume', t('battleView'), () => onView(c.id, status)) : null),
        ]);
      })),
    ])), status]);
  }

  // Detailed rounds of an own battle: the worker reads one view per round, the
  // tab parses them (src/shared/battle-rounds.js). [] when unavailable.
  async function fetchRounds(combatId) {
    const res = await chrome.runtime.sendMessage({ type: 'ikadios:combatRounds', combatId }).catch(() => null);
    if (!res?.ok) return [];
    return IkaDios.battleRounds.clean(res.pages.map((html, i) => IkaDios.battleRounds.parseHtml(html, i + 1)).filter(Boolean)) || [];
  }

  // Longest import link per Discord message embed
  const BATTLE_LINK_MAX = 3800;

  // Import links of a report with its rounds (one or several links)
  async function battleLinks(text, rounds, player, i18n) {
    const world = IkaDios.store?.get()?.account?.world;
    if (!world) return [];
    const parts = await IkaDios.intelLink.buildBattle(world, { text, rounds }, player, BATTLE_LINK_MAX).catch(() => []);
    return parts.map((p) => ({
      url: p.url,
      label: parts.length > 1 && p.rounds ? i18n.t('intelOpenBattleRounds', { from: p.rounds[0], to: p.rounds[1] }) : i18n.t('intelOpenBattle'),
    }));
  }

  // Selected battles: the game's own report text when there is a war report,
  // otherwise the movement details. Links carry the detailed rounds.
  async function battleShare(rows, i18n, player) {
    const { t } = i18n;
    const fields = [];
    const reports = [];
    for (const row of rows.filter((r) => share.isSelected('battles', r.key))) {
      const title = `${t(`battle_${row.status}`)}: ${placeText(row)}`;
      if (row.combat) {
        const res = await chrome.runtime.sendMessage({ type: 'ikadios:combatExport', combatId: row.combat.id }).catch(() => null);
        if (res?.ok) {
          const rounds = await fetchRounds(row.combat.id);
          reports.push({ title, text: res.text, links: await battleLinks(res.text, rounds, player, i18n) });
          continue;
        }
        fields.push({ name: title, value: [row.combat.kind, `${t('battleRounds')}: ${row.combat.rounds ?? '-'}`, row.combat.date ? `${t('battleLastRound')}: ${i18n.formatTime(row.combat.date)}` : null, t('battleNoReport')].filter(Boolean).join('\n') });
      } else if (row.movement) {
        fields.push(...movementFields([row.movement], null, i18n).map((f) => ({ ...f, name: title })));
      }
    }
    return { title: t('battlesShareTitle', { player }), fields, reports };
  }

  // ---------- Battle report viewer and imports ----------

  // Pasted reports are kept per world (small: at most MAX_IMPORTS texts)
  const MAX_IMPORTS = 10;
  const MAX_IMPORT_TEXT = 8000;
  // rounds: detailed rounds of the shown report; round: index shown (null = summary);
  // combatId: own battle shown, whose rounds can be loaded from the game
  const viewer = { report: null, rounds: [], round: null, combatId: null, roundsLoading: false, roundsMessage: '', imports: null, world: null, loading: false };
  const importsKey = (world) => `battleImports:${world}`;

  async function loadImports(world) {
    if (viewer.world === world && viewer.imports) return viewer.imports;
    viewer.world = world;
    viewer.imports = (await chrome.storage.local.get(importsKey(world)))[importsKey(world)] || [];
    return viewer.imports;
  }

  async function saveImports() {
    await chrome.storage.local.set({ [importsKey(viewer.world)]: viewer.imports });
  }

  function show(report, rerender, { rounds = [], combatId = null } = {}) {
    viewer.report = report;
    viewer.rounds = rounds || [];
    viewer.round = null;
    viewer.combatId = combatId;
    viewer.roundsMessage = '';
    rerender();
  }

  async function loadRounds(rerender) {
    if (!viewer.combatId || viewer.roundsLoading) return;
    viewer.roundsLoading = true;
    const combatId = viewer.combatId;
    rerender();
    const rounds = await fetchRounds(combatId);
    viewer.roundsLoading = false;
    if (viewer.combatId !== combatId) return;
    viewer.rounds = rounds;
    viewer.round = rounds.length ? 0 : null;
    viewer.roundsMessage = rounds.length ? '' : IkaDios.i18n.t('battleRoundsNone');
    rerender();
  }

  // Import dialog: a popover, so data updates wait while it is open
  function openImport(container, snapshot, i18n, rerender) {
    const { t } = i18n;
    container.querySelector('.popover')?.remove();
    const area = el('textarea', { rows: '12', style: { width: '100%' }, placeholder: t('battleImportPlaceholder') });
    const status = el('p', { class: 'hint' });
    const close = () => pop.remove();
    const pop = el('div', { class: 'popover battle-import', role: 'dialog' }, [
      el('div', { class: 'popover-head' }, [el('strong', { text: t('battleImport') }), IkaDios.icons.button('remove', t('close'), close)]),
      el('p', { class: 'hint', text: t('battleImportHint') }),
      area,
      el('div', { class: 'popover-actions' }, [
        el('button', {
          class: 'refresh',
          text: t('battleImportShow'),
          onclick: async () => {
            const world = snapshot?.account?.world || 'unknown';
            // Battle links shared by IkaDios (one or several parts of a report)
            const links = IkaDios.intelLink.linksIn(area.value);
            if (links.length) {
              let last = null;
              for (const link of links) {
                const item = await IkaDios.intelLink.decode(link);
                if (item?.kind !== 'battle') continue;
                await IkaDios.intelApply.apply(item, { world, updateSnapshot: async (fn) => IkaDios.store.update(fn) });
                last = item;
              }
              if (!last) {
                status.textContent = t('battleImportInvalid');
                return;
              }
              viewer.imports = null;
              const list = await loadImports(world);
              const entry = list.find((x) => x.text === last.data.text);
              close();
              show(IkaDios.battleReport.parse(last.data.text), rerender, { rounds: entry?.rounds || last.data.rounds || [] });
              return;
            }
            const text = area.value.slice(0, MAX_IMPORT_TEXT);
            const report = IkaDios.battleReport.parse(text);
            if (!report) {
              status.textContent = t('battleImportInvalid');
              return;
            }
            await loadImports(snapshot?.account?.world || 'unknown');
            viewer.imports = [{ id: `imp_${Date.now().toString(36)}`, title: report.title, date: report.date, text, importedAt: Date.now() }, ...viewer.imports].slice(0, MAX_IMPORTS);
            await saveImports();
            close();
            show(report, rerender);
          },
        }),
        status,
      ]),
    ]);
    pop.addEventListener('keydown', (e) => e.key === 'Escape' && close());
    container.append(pop);
    area.focus();
  }

  function importsList(i18n, rerender) {
    const { t } = i18n;
    if (!viewer.imports?.length) return null;
    return el('table', { class: 'grid narrow battle-imports' }, el('tbody', {}, viewer.imports.map((item) =>
      el('tr', {}, [
        el('td', { text: item.title || t('battleReport') }),
        el('td', { class: 'age', text: [item.date || '', item.rounds?.length ? t('battleRoundsCount', { n: item.rounds.length }) : '', item.from ? t('intelSharedBy', { player: item.from }) : ''].filter(Boolean).join(' | ') }),
        el('td', { class: 'nowrap' }, [
          IkaDios.icons.button('resume', t('battleView'), () => show(IkaDios.battleReport.parse(item.text), rerender, { rounds: item.rounds })),
          IkaDios.icons.button('trash', t('delete'), async () => {
            viewer.imports = viewer.imports.filter((x) => x.id !== item.id);
            await saveImports();
            rerender();
          }),
        ]),
      ])
    )));
  }

  // Report of a battle from the list, through the game's converter
  async function viewCombat(combatId, i18n, rerender, status) {
    status.textContent = i18n.t('sharePreparing');
    const res = await chrome.runtime.sendMessage({ type: 'ikadios:combatExport', combatId }).catch(() => null);
    const report = res?.ok ? IkaDios.battleReport.parse(res.text) : null;
    if (!report) {
      status.textContent = i18n.t('battleNoReport');
      return;
    }
    status.textContent = '';
    show(report, rerender, { combatId });
  }

  function viewerSection(container, snapshot, i18n, rerender) {
    const { t } = i18n;
    const world = snapshot?.account?.world || 'unknown';
    if (!viewer.imports || viewer.world !== world) {
      if (!viewer.loading) {
        viewer.loading = true;
        loadImports(world)
          .then(() => container.isConnected && rerender())
          .finally(() => (viewer.loading = false));
      }
    }
    return el('div', { class: 'battle-viewer' }, [
      el('div', { class: 'map-toolbar' }, [
        el('button', { class: 'refresh', text: t('battleImport'), onclick: () => openImport(container, snapshot, i18n, rerender) }),
        viewer.report ? IkaDios.icons.button('remove', t('battleClose'), () => show(null, rerender)) : null,
      ]),
      viewer.report
        ? IkaDios.battleView.render(viewer.report, {
            snapshot,
            i18n,
            rounds: viewer.rounds,
            round: viewer.round,
            onRound: (index) => {
              viewer.round = index;
              rerender();
            },
            // Own battles: rounds are read from the game on request
            onLoadRounds: viewer.combatId && !viewer.rounds.length ? () => loadRounds(rerender) : null,
            roundsLoading: viewer.roundsLoading,
            roundsMessage: viewer.roundsMessage,
          })
        : null,
      importsList(i18n, rerender),
    ]);
  }

  // ---------- Attack plans: arrive together ----------

  // Plans (own and received) per world in attackPlans:<world>. Departure per own
  // city = arrival minus the travel time, with an adjustable speed (minutes per
  // map unit; 20 is the standard for merchant ships, troops and warships vary).
  const plans = { list: null, world: null, open: new Set(), minutesPerUnit: 20 };
  const plansKey = (world) => `attackPlans:${world}`;

  // Plans and battle reports received through the alliance bot (written by the
  // worker) appear without reopening the tab
  if (IkaDios.util.extensionAlive()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      let changed = false;
      if (plans.world && changes[plansKey(plans.world)]) {
        plans.list = changes[plansKey(plans.world)].newValue || [];
        changed = true;
      }
      if (viewer.world && changes[importsKey(viewer.world)]) {
        viewer.imports = changes[importsKey(viewer.world)].newValue || [];
        changed = true;
      }
      if (changed) IkaDios.overlay?.render?.();
    });
  }

  async function loadPlans(world) {
    if (plans.world === world && plans.list) return plans.list;
    plans.world = world;
    const now = Date.now();
    plans.list = ((await chrome.storage.local.get(plansKey(world)))[plansKey(world)] || []).filter((p) => p.arriveAt + IkaDios.intelApply.PLAN_KEEP_MS > now);
    return plans.list;
  }

  async function savePlans() {
    await chrome.storage.local.set({ [plansKey(plans.world)]: plans.list });
  }

  function departures(snapshot, plan) {
    const perUnit = plans.minutesPerUnit * 60000;
    return IkaDios.facets
      .ownCities(snapshot)
      .filter((c) => c.coords)
      .map((c) => {
        const d = Math.hypot(c.coords.x - plan.target.x, c.coords.y - plan.target.y);
        const travel = d === 0 ? perUnit / 2 : d * perUnit;
        return { city: c, d, travel, leaveAt: plan.arriveAt - travel };
      })
      .sort((a, b) => a.leaveAt - b.leaveAt);
  }

  const planTarget = (p) => `${p.target.name || ''}${p.target.player ? ` (${p.target.player})` : ''} [${p.target.x}:${p.target.y}]`.trim();

  function planShare(plan, snapshot, i18n) {
    const { t } = i18n;
    return async () => {
      const world = snapshot?.account?.world;
      const from = snapshot?.account?.playerName || '';
      const link = world ? await IkaDios.intelLink.build(world, 'plan', plan, from) : null;
      return {
        title: t('planShareTitle', { title: plan.title || planTarget(plan) }),
        fields: [
          { name: t('planTarget'), value: planTarget(plan) },
          { name: t('planArrival'), value: share.arrivalText(plan.arriveAt, i18n) },
          plan.note ? { name: t('planNote'), value: plan.note.slice(0, 1024) } : null,
        ].filter(Boolean),
        links: link ? [{ label: t('planOpenLink'), url: link }] : [],
      };
    };
  }

  function planCard(plan, snapshot, i18n, countdown, openTab, rerender) {
    const { t } = i18n;
    const open = plans.open.has(plan.id);
    const late = plan.arriveAt < Date.now();
    const rows = open ? departures(snapshot, plan) : [];
    return el('div', { class: 'trade-form plan-card' }, [
      el('div', { class: 'map-toolbar' }, [
        IkaDios.icons.button(open ? 'up' : 'down', t(open ? 'planHide' : 'planShow'), () => {
          if (open) plans.open.delete(plan.id);
          else plans.open.add(plan.id);
          rerender();
        }),
        el('strong', { text: plan.title || t('planUntitled') }),
        el('button', { class: 'link', text: planTarget(plan), title: t('islandsShowOnMap'), onclick: () => openTab('map', { center: plan.target }) }),
        el('span', { class: late ? 'age' : 'warn' }, [t('planArrival'), ': ', i18n.formatTime(plan.arriveAt), late ? '' : [' (', countdown(plan.arriveAt), ')']].flat()),
        plan.from ? el('span', { class: 'age', text: t('planBy', { player: plan.from }) }) : null,
        IkaDios.icons.button('trash', t('delete'), async () => {
          plans.list = plans.list.filter((p) => p.id !== plan.id);
          await savePlans();
          rerender();
        }),
      ]),
      plan.note ? el('p', { class: 'hint', text: plan.note }) : null,
      open
        ? el('table', { class: 'grid narrow' }, [
            el('thead', {}, el('tr', {}, [t('city'), t('planDistance'), t('planTravel'), t('planLeave'), ''].map((h) => el('th', { text: h })))),
            el('tbody', {}, rows.map((r) =>
              el('tr', { class: r.leaveAt < Date.now() ? 'na' : '' }, [
                el('td', { text: r.city.name }),
                el('td', { class: 'num', text: i18n.formatNumber(r.d, { maximumFractionDigits: 1 }) }),
                el('td', { class: 'nowrap', text: i18n.formatDuration(Math.round(r.travel / 1000)) }),
                el('td', { class: 'nowrap', text: i18n.formatTime(r.leaveAt) }),
                el('td', { class: 'nowrap' }, r.leaveAt < Date.now() ? t('planTooLate') : [t('planLeaveIn'), ' ', countdown(r.leaveAt)]),
              ])
            )),
          ])
        : null,
      open ? confirmations(plan, rows, i18n) : null,
      open ? share.shareBar({ i18n, scopeLabel: t('planShare'), build: planShare(plan, snapshot, i18n) }) : null,
    ]);
  }

  // Who goes: each member confirms through the alliance bot ("I go from city X" /
  // "I can't"); the list fills in as confirmations are read from the channel
  function confirmations(plan, rows, i18n) {
    const { t } = i18n;
    const list = Object.entries(plan.confirmations || {}).sort((a, b) => (a[1].leaveAt || 0) - (b[1].leaveAt || 0));
    const bot = IkaDios.allianceAuto?.ready();
    const status = el('span', { class: 'hint' });
    const viable = rows.filter((r) => r.leaveAt > Date.now());
    const city = el('select', {}, viable.map((r) => el('option', { value: r.city.id, text: `${r.city.name} (${i18n.formatTime(r.leaveAt)})` })));
    const confirm = async (state) => {
      const row = viable.find((r) => r.city.id === city.value);
      const data = { planId: plan.id, status: state, city: state === 'going' ? row?.city.name || '' : '', leaveAt: state === 'going' ? Math.round(row?.leaveAt || 0) || undefined : undefined };
      const title = state === 'going' ? t('planConfirmGoingTitle', { title: plan.title || planTarget(plan), city: data.city }) : t('planConfirmCantTitle', { title: plan.title || planTarget(plan) });
      const res = await chrome.runtime.sendMessage({ type: 'ikadios:allianceItem', kind: 'confirm', data, title }).catch((err) => ({ ok: false, error: String(err) }));
      status.textContent = res?.ok ? t('shareAllianceSent') : t('discordFailedReason', { reason: res?.error || '?' });
    };
    return el('div', { class: 'plan-confirmations' }, [
      el('strong', { text: t('planConfirmations') }),
      list.length
        ? el('table', { class: 'grid narrow' }, el('tbody', {}, list.map(([who, c]) =>
            el('tr', {}, [
              el('td', { text: who }),
              el('td', { class: c.status === 'going' ? 'ok-text' : 'warn', text: t(`planConfirm_${c.status}`) }),
              el('td', { text: c.city || '' }),
              el('td', { class: 'nowrap', text: c.leaveAt ? i18n.formatTime(c.leaveAt) : '' }),
            ])
          )))
        : el('p', { class: 'empty', text: t('planNoConfirmations') }),
      bot
        ? el('div', { class: 'map-toolbar' }, [
            viable.length ? el('label', { class: 'check' }, [t('planGoFrom'), city]) : null,
            viable.length ? el('button', { class: 'refresh', text: t('planConfirmGoing'), onclick: () => confirm('going') }) : null,
            el('button', { class: 'btn-soft danger', text: t('planConfirmCant'), onclick: () => confirm('cant') }),
            status,
          ])
        : el('p', { class: 'hint', text: t('planConfirmNeedsBot') }),
    ]);
  }

  // New plan: target coordinates, optional names, arrival date and time, note
  function openPlanForm(container, snapshot, i18n, rerender, preset = {}) {
    const { t } = i18n;
    container.querySelector('.popover')?.remove();
    const field = (attrs) => el('input', { type: 'text', ...attrs });
    const coords = field({ value: preset.x != null ? `${preset.x}:${preset.y}` : '', placeholder: '50:22', size: '7' });
    const name = field({ value: preset.name || '', maxlength: '40' });
    const player = field({ value: preset.player || '', maxlength: '40' });
    const title = field({ value: preset.title || '', maxlength: '60', placeholder: t('planTitlePlaceholder') });
    const when = el('input', { type: 'datetime-local' });
    const note = el('textarea', { rows: '2', maxlength: '300', style: { width: '100%' } });
    const status = el('p', { class: 'hint' });
    const close = () => pop.remove();
    const pop = el('div', { class: 'popover', role: 'dialog' }, [
      el('div', { class: 'popover-head' }, [el('strong', { text: t('planNew') }), IkaDios.icons.button('remove', t('close'), close)]),
      el('div', { class: 'map-toolbar' }, [el('label', { class: 'check' }, [t('planTitle'), title])]),
      el('div', { class: 'map-toolbar' }, [
        el('label', { class: 'check' }, [t('mapCoords'), coords]),
        el('label', { class: 'check' }, [t('city'), name]),
        el('label', { class: 'check' }, [t('mapPlayer'), player]),
      ]),
      el('div', { class: 'map-toolbar' }, [el('label', { class: 'check' }, [t('planArrival'), when])]),
      el('label', {}, [t('planNote'), note]),
      el('div', { class: 'popover-actions' }, [
        el('button', {
          class: 'refresh',
          text: t('planCreate'),
          onclick: async () => {
            const c = IkaDios.util.parseCoords(coords.value);
            const arriveAt = when.value ? new Date(when.value).getTime() : NaN;
            if (!c) return (status.textContent = t('planBadCoords'));
            if (!(arriveAt > Date.now())) return (status.textContent = t('autoStartPast'));
            const plan = {
              id: `plan_${Date.now().toString(36)}`,
              title: title.value.trim().slice(0, 60),
              target: { x: c.x, y: c.y, name: name.value.trim().slice(0, 40), player: player.value.trim().slice(0, 40) },
              arriveAt,
              note: note.value.slice(0, 300),
              from: snapshot?.account?.playerName || '',
              createdAt: Date.now(),
            };
            await loadPlans(snapshot?.account?.world || 'unknown');
            plans.list.unshift(plan);
            plans.open.add(plan.id);
            await savePlans();
            close();
            rerender();
            IkaDios.allianceAuto?.maybe('autoPlans', planShare(plan, snapshot, i18n));
          },
        }),
        status,
      ]),
    ]);
    pop.addEventListener('keydown', (e) => e.key === 'Escape' && close());
    container.append(pop);
    coords.focus();
  }

  function plansSection(container, snapshot, i18n, countdown, openTab, rerender) {
    const { t } = i18n;
    const world = snapshot?.account?.world || 'unknown';
    if (plans.world !== world || !plans.list) {
      loadPlans(world).then(() => container.isConnected && rerender());
      return el('p', { class: 'hint', text: t('mapLoading') });
    }
    const speed = el('input', {
      type: 'number',
      min: '1',
      max: '120',
      value: String(plans.minutesPerUnit),
      style: { width: '4em' },
      onchange: (e) => {
        const n = Number(e.target.value);
        if (n >= 1 && n <= 120) plans.minutesPerUnit = n;
        rerender();
      },
    });
    return el('div', {}, [
      el('div', { class: 'map-toolbar' }, [
        el('button', { class: 'refresh', text: t('planNew'), onclick: () => openPlanForm(container, snapshot, i18n, rerender) }),
        el('label', { class: 'check', title: t('planSpeedHint') }, [t('planSpeed'), speed, t('planSpeedUnit')]),
      ]),
      plans.list.length ? el('div', {}, plans.list.map((p) => planCard(p, snapshot, i18n, countdown, openTab, rerender))) : el('p', { class: 'empty', text: t('planNone') }),
    ]);
  }

  function render(container, snapshot, helpers) {
    const { i18n, goToView, countdown, openTab } = helpers;
    const rerender = () => {
      container.replaceChildren();
      render(container, snapshot, helpers);
    };
    const pending = IkaDios.tabs.pendingOptions;
    if (pending?.id === 'military' && pending.plan) {
      IkaDios.tabs.pendingOptions = null;
      requestAnimationFrame(() => openPlanForm(container, snapshot, i18n, rerender, pending.plan));
    }
    const { t } = i18n;
    const cities = IkaDios.facets.ownCities(snapshot);
    const names = snapshot?.unitNames || {};
    const movements = sortedMovements(snapshot);
    const battles = battleRows(snapshot);
    if (!cities.some((c) => c.militaryUpdatedAt) && !movements.length && !battles.length) {
      container.append(
        el('p', { class: 'empty', text: t('pending_military') }),
        el('h3', { class: 'section-title', text: t('plans') }),
        plansSection(container, snapshot, i18n, countdown, openTab, rerender),
        viewerSection(container, snapshot, i18n, rerender)
      );
      return;
    }
    const player = snapshot?.account?.playerName || t('discordUnknownPlayer');
    container.append(
      share.shareBar({
        i18n,
        scopeLabel: t('shareSelectedRows'),
        build: () => ({
          title: t('shareMilitaryTitle', { player }),
          fields: [
            ...movementFields(movements, 'moves', i18n),
            ...forceFields(cities, 'units', names, i18n),
            ...forceFields(cities, 'ships', names, i18n),
          ],
        }),
      }),
      el('h3', { class: 'section-title', text: t('militaryMovements') }),
      movementsTable(movements, 'moves', i18n, countdown),
      el('p', { class: 'age' }, [
        t('updated', { when: i18n.formatRelative(snapshot?.military?.updatedAt) }),
        ' ',
        el('button', { class: 'btn-soft', text: t('openMilitaryAdvisor'), onclick: () => goToView('militaryAdvisor') }),
      ]),
      el('h3', { class: 'section-title', text: t('plans') }),
      plansSection(container, snapshot, i18n, countdown, openTab, rerender),
      el('h3', { class: 'section-title', text: t('battles') }),
      share.shareBar({ i18n, scopeLabel: t('shareSelectedBattles'), build: () => battleShare(battles, i18n, player) }),
      battlesTable(battles, i18n, openTab, (combatId, status) => viewCombat(combatId, i18n, rerender, status)),
      viewerSection(container, snapshot, i18n, rerender),
      el('p', { class: 'age' }, [
        snapshot?.military?.combatsUpdatedAt ? t('updated', { when: i18n.formatRelative(snapshot.military.combatsUpdatedAt) }) : t('battlesHint'),
        ' ',
        el('button', { class: 'btn-soft', text: t('openWarReports'), onclick: () => goToView('militaryAdvisorCombatList', { activeTab: 'tab_militaryAdvisorCombatList' }) }),
      ]),
      el('h3', { class: 'section-title', text: t('militaryUnits') }),
      matrix(cities, 'units', names, i18n, 'garrisonLand'),
      el('h3', { class: 'section-title', text: t('militaryShips') }),
      matrix(cities, 'ships', names, i18n, 'garrisonSea')
    );
  }

  IkaDios.tabs.register({ id: 'military', labelKey: 'tab_military', order: 20, render });
  IkaDios.militaryTab = { movementsTable, movementFields, sortedMovements };
})(typeof self !== 'undefined' ? self : window);

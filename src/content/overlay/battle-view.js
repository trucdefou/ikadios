// Draws a parsed battle report (src/shared/battle-report.js) like the game's own
// report window: title and date, attacker against defender, unit tiles with the
// game's icons, survivors and losses per side, the statistics and the outcome.
// Unit names are matched to icons through the names IkaDios has seen in the game
// (snapshot.unitNames); unknown names get a lettered tile.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { el } = IkaDios.util;

  const normalize = (name) => String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();

  function unitIndex(snapshot) {
    const index = new Map();
    for (const [id, name] of Object.entries(snapshot?.unitNames || {})) index.set(normalize(name), id);
    return index;
  }

  function icon(name, index) {
    const id = index.get(normalize(name));
    const sprite = id ? IkaDios.battleReport.sprite(id) : null;
    if (!sprite) {
      const letters = String(name || '?').split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase();
      return el('div', { class: 'unit-icon unit-icon-text', text: letters });
    }
    return el('div', {
      class: 'unit-icon',
      style: { backgroundImage: `url("${location.origin}${sprite.path}")`, backgroundPosition: `-${sprite.x}px 0` },
    });
  }

  function tile(unit, side, index, i18n) {
    const data = unit[side];
    return el('div', { class: `unit-tile ${data.lost ? 'has-losses' : ''}`, title: unit.name }, [
      icon(unit.name, index),
      el('span', { class: 'unit-name', text: unit.name }),
      el('span', { class: 'unit-count', text: i18n.formatNumber(data.count) }),
      el('span', { class: `unit-lost ${data.lost ? 'warn' : ''}`, text: `(-${i18n.formatNumber(data.lost)})` }),
    ]);
  }

  function side(report, key, index, i18n) {
    const units = report.units.filter((u) => u[key]);
    const total = units.reduce((a, u) => a + u[key].count, 0);
    const lost = units.reduce((a, u) => a + u[key].lost, 0);
    return el('div', { class: `battle-side battle-${key}` }, [
      el('div', { class: 'battle-side-head' }, [
        el('span', { class: 'battle-role', text: i18n.t(key === 'attacker' ? 'battleAttacker' : 'battleDefender') }),
        el('strong', { text: report[key] || '-' }),
      ]),
      units.length
        ? el('div', { class: 'unit-grid' }, units.map((u) => tile(u, key, index, i18n)))
        : el('p', { class: 'empty', text: i18n.t('battleNoUnits') }),
      el('p', { class: 'battle-totals' }, [
        i18n.t('battleTotals', { units: i18n.formatNumber(total) }),
        ' ',
        el('span', { class: lost ? 'warn' : '', text: i18n.t('battleTotalLost', { n: i18n.formatNumber(lost) }) }),
      ]),
    ]);
  }

  // Damage percentages as bars, the other statistics as plain values
  function statValue(cell) {
    if (!cell) return el('td', { text: '-' });
    const pct = /^(\d{1,3})\s*%$/.exec(cell.value || '');
    if (!pct) return el('td', { class: 'num', text: cell.value });
    return el('td', {}, el('div', { class: 'stat-bar', title: cell.value }, [el('span', { style: { width: `${Math.min(100, +pct[1])}%` } }), el('em', { text: cell.value })]));
  }

  // ---------- Detailed rounds (src/shared/battle-rounds.js) ----------

  // Icon of a unit by the number of its game class (303 = s303)
  function unitIcon(unit, snapshot) {
    const id = `s${unit}`;
    const sprite = IkaDios.battleReport.sprite(id);
    const name = snapshot?.unitNames?.[id] || id;
    if (!sprite) return el('div', { class: 'unit-icon unit-icon-text', title: name, text: String(unit) });
    return el('div', {
      class: 'unit-icon',
      title: name,
      style: { backgroundImage: `url("${location.origin}${sprite.path}")`, backgroundPosition: `-${sprite.x}px 0` },
    });
  }

  const bar = (cls, pct, title) => el('div', { class: `slot-bar ${cls}`, title }, el('span', { style: { width: `${pct}%` } }));

  function slotTile(slot, snapshot, i18n) {
    if (!slot) return el('div', { class: 'round-slot empty' });
    const [unit, count, lost, hp, ammo] = slot;
    return el('div', { class: `round-slot ${count ? '' : 'dead'} ${lost ? 'has-losses' : ''}` }, [
      unitIcon(unit, snapshot),
      el('span', { class: 'unit-count', text: i18n.formatNumber(count) }),
      el('span', { class: `unit-lost ${lost ? 'warn' : ''}`, text: `(-${i18n.formatNumber(lost)})` }),
      bar('hp', hp, i18n.t('battleHitpoints', { n: hp })),
      ammo != null ? bar('ammo', ammo, i18n.t('battleAmmo', { n: ammo })) : null,
    ]);
  }

  function lineLabel(name, i18n) {
    const key = `battleLine_${name}`;
    const text = i18n.t(key);
    return text === key ? name : text;
  }

  function roundSide(side, key, snapshot, i18n) {
    const { t } = i18n;
    const lines = IkaDios.battleRounds.orderedLines(side);
    return el('div', { class: `battle-side battle-${key}` }, [
      el('div', { class: 'battle-side-head' }, [el('span', { class: 'battle-role', text: t(key === 'att' ? 'battleAttacker' : 'battleDefender') })]),
      side.players.length
        ? el('table', { class: 'grid narrow round-players' }, el('tbody', {}, side.players.map((p) =>
            el('tr', {}, [
              el('td', {}, el('strong', { text: p.name })),
              el('td', { class: 'num', text: `${i18n.formatNumber(p.units)} (-${i18n.formatNumber(p.lost)})` }),
              el('td', { title: t('battleMorale') }, bar('morale', p.morale, `${t('battleMorale')}: ${p.morale} %`)),
              el('td', { class: 'num', text: `${p.morale} %` }),
            ])
          )))
        : el('p', { class: 'empty', text: t('battleSideGone') }),
      lines.length
        ? el('div', { class: 'round-lines' }, lines.map(([name, slots]) =>
            el('div', { class: 'round-line' }, [
              el('span', { class: 'round-line-name', text: lineLabel(name, i18n) }),
              el('div', { class: 'round-slots' }, slots.map((s) => slotTile(s, snapshot, i18n))),
            ])
          ))
        : null,
      side.reserve.length
        ? el('div', { class: 'round-line round-reserve' }, [
            el('span', { class: 'round-line-name', text: t('battleReserve') }),
            el('div', { class: 'round-slots' }, side.reserve.map(([unit, count]) =>
              el('div', { class: 'round-slot' }, [unitIcon(unit, snapshot), el('span', { class: 'unit-count', text: i18n.formatNumber(count) })])
            )),
          ])
        : null,
    ]);
  }

  function roundView(round, snapshot, i18n) {
    return el('div', { class: 'round-view' }, [
      el('div', { class: 'battle-title' }, [
        el('strong', { text: i18n.t('battleRoundOf', { n: round.n, of: round.of }) }),
        round.at ? el('span', { class: 'age', text: ` (${round.at})` }) : null,
      ]),
      el('div', { class: 'battle-sides round-sides' }, [roundSide(round.att, 'att', snapshot, i18n), roundSide(round.def, 'def', snapshot, i18n)]),
      round.events.length
        ? el('div', { class: 'round-events' }, round.events.map((e) =>
            el('div', { class: 'round-event' }, [
              e.at ? el('span', { class: 'age', text: `${e.at} ` }) : null,
              el('span', { text: e.text }),
              e.units.length
                ? el('div', { class: 'round-slots' }, e.units.map(([unit, count]) =>
                    el('div', { class: 'round-slot' }, [unitIcon(unit, snapshot), el('span', { class: 'unit-count', text: i18n.formatNumber(count) })])
                  ))
                : null,
            ])
          ))
        : null,
    ]);
  }

  // Summary / round picker: previous, a list of every round, next
  function roundNav(rounds, round, onRound, i18n) {
    const { t } = i18n;
    const select = el('select', {
      'aria-label': t('battleRound'),
      onchange: (e) => onRound(e.target.value === '' ? null : Number(e.target.value)),
    }, [
      el('option', { value: '', text: t('battleSummary'), selected: round == null ? true : null }),
      ...rounds.map((r, i) => el('option', { value: String(i), text: t('battleRoundOf', { n: r.n, of: r.of }), selected: round === i ? true : null })),
    ]);
    const prev = round == null ? null : round > 0 ? round - 1 : null;
    const next = round == null ? 0 : round + 1;
    return el('div', { class: 'round-nav' }, [
      IkaDios.icons.button('prev', t('battleRoundPrev'), () => onRound(prev), { disabled: round == null }),
      select,
      IkaDios.icons.button('next', t('battleRoundNext'), () => onRound(next), { disabled: next >= rounds.length }),
    ]);
  }

  function render(report, { snapshot, i18n, rounds = [], round = null, onRound = null, onLoadRounds = null, roundsLoading = false, roundsMessage = '' }) {
    const { t } = i18n;
    const nav = rounds.length && onRound
      ? roundNav(rounds, round, onRound, i18n)
      : onLoadRounds
        ? el('div', { class: 'round-nav' }, [
            el('button', { class: 'refresh', text: t(roundsLoading ? 'battleRoundsLoading' : 'battleLoadRounds'), disabled: roundsLoading ? true : null, onclick: () => onLoadRounds() }),
            roundsMessage ? el('span', { class: 'hint', text: roundsMessage }) : null,
          ])
        : null;
    const shown = round != null ? rounds[round] : null;
    if (shown) return el('div', { class: 'battle-card' }, [nav, roundView(shown, snapshot, i18n)]);
    return el('div', {}, [nav, summary(report, { snapshot, i18n })]);
  }

  function summary(report, { snapshot, i18n }) {
    const index = unitIndex(snapshot);
    const [first, ...rest] = report.outcome;
    return el('div', { class: 'battle-card' }, [
      el('div', { class: 'battle-title' }, [el('strong', { text: report.title || i18n.t('battleReport') }), report.date ? el('span', { class: 'age', text: ` (${report.date})` }) : null]),
      el('div', { class: 'battle-sides' }, [side(report, 'attacker', index, i18n), el('div', { class: 'battle-vs', text: i18n.t('battleVs') }), side(report, 'defender', index, i18n)]),
      report.stats.length
        ? el('table', { class: 'grid narrow battle-stats' }, el('tbody', {}, report.stats.map((s) =>
            el('tr', {}, [el('td', { text: s.attacker?.name || '' }), statValue(s.attacker), statValue(s.defender), el('td', { text: s.defender?.name || '' })])
          )))
        : null,
      report.outcome.length
        ? el('div', { class: 'battle-outcome' }, [el('p', { class: 'battle-winner', text: first }), ...rest.map((line) => el('p', { text: line }))])
        : null,
    ]);
  }

  IkaDios.battleView = { render, summary, roundView, unitIndex };
})(typeof self !== 'undefined' ? self : window);

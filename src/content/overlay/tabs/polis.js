// Politics / polis tab: matrix of cities x buildings with levels and upgrades.
// Cells are green when the city has the resources for the next level, red when
// it does not, and neutral while the cost is unknown (the building view has not
// been captured at this level yet). Clicking a cell opens upgrade / downgrade actions.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { el } = IkaDios.util;
  const { RESOURCES } = IkaDios.schema;

  // Building column order chosen by dragging the headers (list of building types;
  // types not in the list keep the default order after the listed ones)
  const KEY_ORDER = 'polisColumnOrder';
  let columnOrder = [];
  chrome.storage.local
    .get(KEY_ORDER)
    .then((r) => {
      columnOrder = Array.isArray(r[KEY_ORDER]) ? r[KEY_ORDER] : [];
    })
    .catch(() => {});

  function orderedColumns(columns) {
    const rank = (type) => {
      const i = columnOrder.indexOf(type);
      return i < 0 ? columnOrder.length + columns.indexOf(type) : i;
    };
    return [...columns].sort((a, b) => rank(a) - rank(b));
  }

  function saveOrder(order) {
    columnOrder = order;
    chrome.storage.local.set({ [KEY_ORDER]: order }).catch(() => {});
  }

  function isBuilding(b, row) {
    return row.constructing && row.constructing.pos === b.pos;
  }

  // Text color: affordability. Background: grey while another building of the
  // city is being upgraded (resources may be there, but the slot is taken).
  function cellClass(b, row) {
    if (isBuilding(b, row)) return 'busy';
    const blocked = row.constructing ? ' blocked' : '';
    if (!b.upgrade.known || b.upgrade.unknownStock) return `up-unknown${blocked}`;
    return (b.upgrade.enough ? 'up-ok' : 'up-lack') + blocked;
  }

  function cellTitle(b, row, i18n) {
    const lines = [i18n.buildingName(b.type)];
    if (b.levels.length > 1) lines.push(i18n.t('polisAllLevels', { levels: b.levels.join(', ') }));
    if (isBuilding(b, row)) {
      lines.push(i18n.t('upgrading'));
    } else {
      if (row.constructing) lines.push(i18n.t('polisBlocked', { building: i18n.buildingName(row.constructing.type) }));
      if (!b.upgrade.known) lines.push(i18n.t('polisCostUnknown'));
      else if (b.upgrade.unknownStock) lines.push(i18n.t('polisStockUnknown'));
      else if (b.upgrade.enough) lines.push(i18n.t('polisCanUpgrade'));
      else {
        const missing = Object.entries(b.upgrade.missing).map(([r, n]) => `${i18n.t(`resourceShort_${r}`)} ${i18n.formatNumber(n)}`);
        lines.push(i18n.t('polisMissing', { list: missing.join(', ') }));
      }
    }
    lines.push(i18n.t('polisClickHint'));
    return lines.join('\n');
  }

  // Automation of one building, inside the popover: target level and on/off.
  // Checked: the task is active and automations are switched on; unchecked: the
  // task is kept but inactive (does nothing).
  async function fillAutomation(box, row, b, i18n) {
    const { t } = i18n;
    box.replaceChildren(el('p', { class: 'hint', text: t('loading') }));
    const existing = await IkaDios.automationTab.taskFor(row.id, b.pos);
    const target = el('input', {
      type: 'number',
      min: String(b.level + 1),
      max: '100',
      value: String(existing?.targetLevel > b.level ? existing.targetLevel : b.level + 1),
      style: { width: '4em' },
    });
    const active = el('input', { type: 'checkbox', checked: !existing || existing.status !== 'paused' ? true : null });
    const status = el('p', { class: 'hint', text: existing ? t('polisAutoExisting', { level: existing.targetLevel }) : '' });
    const save = async () => {
      const level = Number(target.value);
      if (!Number.isInteger(level) || level <= b.level || level > 100) {
        status.textContent = t('autoAddError_invalid');
        return;
      }
      const res = await IkaDios.automationTab.saveBuildingTask(row, b, level, active.checked);
      status.textContent = res.ok ? t(active.checked ? 'polisAutoSavedActive' : 'polisAutoSavedInactive') : t(`autoAddError_${res.error === 'invalid' ? 'invalid' : 'other'}`);
      remove.hidden = !res.ok;
    };
    const remove = el('button', {
      class: 'btn-soft danger',
      text: t('polisAutoRemove'),
      hidden: existing ? null : true,
      onclick: async () => {
        const res = await IkaDios.automationTab.removeBuildingTask(row.id, b.pos);
        status.textContent = res.ok ? t('polisAutoRemoved') : t('autoAddError_other');
        if (res.ok) remove.hidden = true;
      },
    });
    box.replaceChildren(
      el('div', { class: 'popover-actions' }, [
        el('label', { class: 'check' }, [t('autoTargetLevel'), ' ', target]),
        el('label', { class: 'check', title: t('polisAutoActiveHint') }, [active, ' ', t('polisAutoActive')]),
        el('button', { class: 'refresh', text: t('polisAutoSave'), onclick: save }),
        remove,
      ]),
      status
    );
    target.focus();
  }

  function openPopover(container, row, b, helpers) {
    const { i18n, buildingAction, openTab } = helpers;
    const { t } = i18n;
    container.querySelector('.popover')?.remove();
    const up = b.upgrade;

    const costRows = up.known
      ? RESOURCES.filter((r) => up.cost[r]).map((r) => {
          const have = row.resources[r];
          const lacking = up.missing[r];
          return el('tr', { class: lacking ? 'lack' : 'ok' }, [
            el('td', { text: t(`resource_${r}`) }),
            el('td', { class: 'num', text: i18n.formatNumber(up.cost[r]) }),
            el('td', { class: 'num', text: have != null ? i18n.formatNumber(have) : '-' }),
            el('td', { class: 'num', text: lacking ? `-${i18n.formatNumber(lacking)}` : t('polisOk') }),
          ]);
        })
      : [];

    const close = () => pop.remove();
    const pop = el('div', { class: 'popover', role: 'dialog' }, [
      el('div', { class: 'popover-head' }, [
        el('strong', { text: `${i18n.buildingName(b.type)} (${row.name})` }),
        el('button', { class: 'icon', title: t('close'), text: 'x', onclick: close }),
      ]),
      el('p', { text: t('polisLevelChange', { from: b.level, to: b.level + 1 }) }),
      up.known
        ? el('table', { class: 'grid narrow' }, [
            el('thead', {}, el('tr', {}, [t('polisResource'), t('polisNeeded'), t('polisHave'), t('polisBalance')].map((h) => el('th', { text: h })))),
            el('tbody', {}, costRows),
          ])
        : el('p', { class: 'hint', text: t('polisCostUnknown') }),
      up.time ? el('p', { class: 'hint', text: t('polisBuildTime', { time: up.time }) }) : null,
      up.updatedAt ? el('p', { class: 'age', text: t('lastUpdated', { when: i18n.formatRelative(up.updatedAt) }) }) : null,
      el('div', { class: 'popover-actions' }, [
        el('button', {
          class: 'refresh',
          text: t('polisUpgrade'),
          disabled: row.constructing || (up.known && !up.enough && !up.unknownStock) ? true : null,
          title: isBuilding(b, row)
            ? t('upgrading')
            : row.constructing
              ? t('polisBlocked', { building: i18n.buildingName(row.constructing.type) })
              : up.known && !up.enough
                ? t('polisNotEnough')
                : '',
          onclick: () => {
            buildingAction('upgrade', up);
            close();
          },
        }),
        el('button', {
          class: 'refresh',
          text: t('polisDowngrade'),
          disabled: isBuilding(b, row) || b.level <= 1 ? true : null,
          title: t('polisDowngradeHint'),
          onclick: () => {
            buildingAction('demolish', up);
            close();
          },
        }),
        el('button', {
          class: 'refresh',
          text: t('polisAutomate'),
          'aria-expanded': 'false',
          onclick: (e) => {
            const button = e.currentTarget;
            const box = pop.querySelector('.popover-auto');
            const open = box.hidden;
            box.hidden = !open;
            button.setAttribute('aria-expanded', String(open));
            if (open) fillAutomation(box, row, b, i18n);
          },
        }),
        up.known && Object.keys(up.missing || {}).length
          ? el('button', {
              class: 'btn-soft',
              text: t('polisAskAlliance'),
              title: t('polisAskAllianceHint'),
              onclick: () => {
                close();
                openTab('trade', {
                  request: {
                    cityId: row.id,
                    items: Object.entries(up.missing).map(([resource, amount]) => ({ resource, amount })),
                    note: t('polisAskAllianceNote', { building: i18n.buildingName(b.type), level: b.level + 1 }),
                  },
                });
              },
            })
          : null,
      ]),
      el('div', { class: 'popover-auto', hidden: true }),
    ]);
    pop.addEventListener('keydown', (e) => e.key === 'Escape' && close());
    container.append(pop);
    pop.querySelector('button.refresh:not([disabled])')?.focus();
  }

  function happinessCell(th, i18n) {
    if (!th || th.happiness == null) return el('td', { class: 'na', text: '-' });
    const s = th.satisfaction || {};
    const parts = Object.entries(s)
      .filter(([, v]) => v)
      .map(([k, v]) => `${i18n.t(`satisfaction_${k}`)}: ${i18n.formatSigned(v)}`);
    const title = [
      i18n.t(`happiness_${th.happinessLevel || 'neutral'}`),
      ...parts,
      th.corruption ? `${i18n.t('polisCorruption')}: ${th.corruption}%` : null,
      th.growth != null ? `${i18n.t('polisGrowth')}: ${i18n.formatNumber(th.growth, { maximumFractionDigits: 2 })}` : null,
    ].filter(Boolean).join('\n');
    return el('td', { class: `happy-${th.happinessLevel || 'neutral'}`, title, 'data-updated': th.updatedAt || null, text: i18n.formatSigned(th.happiness) });
  }

  function render(container, snapshot, helpers) {
    const { i18n, countdown } = helpers;
    const { t } = i18n;
    const data = IkaDios.facets.polis(snapshot);

    if (!data.rows.length || !data.columns.length) {
      container.append(el('p', { class: 'empty', text: t('emptyPolis') }));
      return;
    }

    const columns = orderedColumns(data.columns);
    const rerender = () => {
      container.replaceChildren();
      render(container, snapshot, helpers);
    };
    // Drag a building header onto another to move the column there
    let dragged = null;
    const columnHead = (type) =>
      el(
        'th',
        {
          class: 'rot drag-col',
          title: `${i18n.buildingName(type)}\n${t('polisDragHint')}`,
          draggable: 'true',
          ondragstart: (e) => {
            dragged = type;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', type);
            e.currentTarget.classList.add('dragging');
          },
          ondragend: (e) => {
            dragged = null;
            e.currentTarget.classList.remove('dragging');
          },
          ondragover: (e) => {
            if (!dragged || dragged === type) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            e.currentTarget.classList.add('drop-target');
          },
          ondragleave: (e) => e.currentTarget.classList.remove('drop-target'),
          ondrop: (e) => {
            e.preventDefault();
            if (!dragged || dragged === type) return;
            const order = columns.filter((c) => c !== dragged);
            // Dropped on a column to its right: place after it; to its left: before it
            const after = columns.indexOf(dragged) < columns.indexOf(type);
            order.splice(order.indexOf(type) + (after ? 1 : 0), 0, dragged);
            saveOrder(order);
            rerender();
          },
        },
        el('span', { text: i18n.buildingName(type) })
      );

    const head = el('tr', {}, [
      el('th', { text: t('city') }),
      el('th', { text: t('citizens') }),
      el('th', { text: t('polisHappiness') }),
      el('th', { text: t('polisActionPoints'), title: t('polisActionPointsHint') }),
      ...columns.map(columnHead),
    ]);

    const rows = data.rows.map((row) =>
      el('tr', {}, [
        el('td', { class: 'city' }, [
          el('span', { text: `${row.isCapital ? '* ' : ''}${row.name || row.id}` }),
          el('small', { class: 'age', text: i18n.formatRelative(row.updatedAt) }),
        ]),
        el('td', { 'data-updated': row.updatedAt || null }, row.citizens != null ? `${i18n.formatNumber(row.citizens)} / ${i18n.formatNumber(row.population)}` : '-'),
        happinessCell(row.townHall, i18n),
        el('td', { 'data-updated': row.townHall?.updatedAt || null, text: row.townHall?.actionPoints != null ? `${row.townHall.actionPoints} / ${row.townHall.maxActionPoints}` : '-' }),
        ...columns.map((type) => {
          const b = row.byType[type];
          if (!b) return el('td', { class: 'na', text: '' });
          return el(
            'td',
            {
              class: `lvl ${cellClass(b, row)}`,
              title: cellTitle(b, row, i18n),
              'data-updated': b.upgrade.updatedAt || row.updatedAt || null,
              tabindex: '0',
              onclick: () => openPopover(container, row, b, helpers),
              onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && openPopover(container, row, b, helpers),
            },
            [String(b.level), b.underConstruction && b.upgradeEndsAt ? [' ', countdown(b.upgradeEndsAt)] : null].flat()
          );
        }),
      ])
    );

    container.append(
      el('div', { class: 'scroll-x' }, el('table', { class: 'grid matrix' }, [el('thead', {}, head), el('tbody', {}, rows)])),
      el('p', { class: 'hint' }, [
        el('span', { class: 'legend up-ok', text: t('polisLegendOk') }),
        el('span', { class: 'legend up-lack', text: t('polisLegendLack') }),
        el('span', { class: 'legend up-unknown', text: t('polisLegendUnknown') }),
        el('span', { class: 'legend up-ok blocked', text: t('polisLegendBlocked') }),
        el('span', { class: 'legend busy', text: t('upgrading') }),
        ' ',
        t('hintPolis'),
        ' ',
        columnOrder.length
          ? el('button', {
              class: 'btn-soft',
              text: t('polisResetOrder'),
              onclick: () => {
                saveOrder([]);
                rerender();
              },
            })
          : null,
      ])
    );
  }

  IkaDios.tabs.register({ id: 'polis', labelKey: 'tab_polis', order: 10, render });
})(typeof self !== 'undefined' ? self : window);

// Espionage tab: spies per city (training / defending / on missions / capacity)
// and the spy reports read from the hideout's "Reports" and "Archive" tabs. Each
// report row can be expanded (report text), opened on the map, and selected for
// sharing to Discord or WhatsApp.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { el } = IkaDios.util;
  const share = IkaDios.share;

  // Expanded report ids survive re-renders
  const expanded = new Set();

  function spiesTable(cities, i18n, goToView) {
    const { t } = i18n;
    return el('table', { class: 'grid' }, [
      el('thead', {}, el('tr', {}, [t('city'), t('spiesDefending'), t('spiesOnMission'), t('spiesTraining'), t('spiesCanTrain'), ''].map((h) => el('th', { text: h })))),
      el('tbody', {}, cities.map((c) => {
        const hideout = (c.buildings || []).find((b) => b.type === 'safehouse');
        return el('tr', { 'data-updated': c.spies.updatedAt || null }, [
          el('td', { class: 'city' }, [el('span', { text: c.name || c.id }), el('small', { class: 'age', text: i18n.formatRelative(c.spies.updatedAt) })]),
          el('td', { class: 'num', text: i18n.formatNumber(c.spies.defending) }),
          el('td', { class: 'num', text: i18n.formatNumber(c.spies.onMission) }),
          el('td', { class: 'num', text: i18n.formatNumber(c.spies.training) }),
          el('td', { class: 'num', text: c.spies.canTrain != null ? i18n.formatNumber(c.spies.canTrain) : '-' }),
          el('td', {}, hideout ? el('button', { class: 'link', text: t('openInGame'), onclick: () => goToView('safehouse', { cityId: c.id, position: hideout.pos }) }) : null),
        ]);
      })),
    ]);
  }

  const target = (r) => `${r.city}${r.x != null ? ` [${r.x}:${r.y}]` : ''}`;
  const agentsText = (r) => (r.agents ? `${r.agents.lost} / ${r.agents.sent}` : '-');

  function reportsTable(reports, i18n, openTab, rerender) {
    const { t } = i18n;
    const rows = [];
    for (const r of reports) {
      const open = expanded.has(r.id);
      rows.push(
        el('tr', {}, [
          share.rowCheck('spyReports', r.id),
          el('td', { class: 'nowrap' }, [
            IkaDios.icons.button(open ? 'up' : 'down', t(open ? 'spyReportHide' : 'spyReportShow'), () => {
              if (open) expanded.delete(r.id);
              else expanded.add(r.id);
              rerender();
            }),
          ]),
          el('td', { class: 'nowrap', text: r.date ? i18n.formatTime(r.date) : r.dateText || '-' }),
          el('td', {}, r.owner ? el('button', { class: 'link', text: r.owner, title: t('playerOpen'), onclick: () => openTab('players', { player: r.owner }) }) : '-'),
          el('td', {}, r.x != null
            ? el('button', { class: 'link', text: target(r), title: t('islandsShowOnMap'), onclick: () => openTab('map', { center: { x: r.x, y: r.y } }) })
            : target(r)),
          el('td', {}, [r.subject || '-', r.sharedBy ? el('small', { class: 'age', text: ` (${t('intelSharedBy', { player: r.sharedBy })})` }) : null]),
          el('td', { text: r.result || '-' }),
          el('td', { class: `num ${r.agents?.lost ? 'warn' : ''}`, title: t('spyAgentsHint'), text: agentsText(r) }),
        ])
      );
      if (open) {
        rows.push(
          el('tr', { class: 'spy-report-body' }, [
            el('td', {}),
            el('td', { colspan: '7' }, [
              ...(r.lines || []).map((line) => el('div', { text: line })),
              r.cities?.length
                ? el('div', { class: 'map-toolbar' }, [
                    el('span', { class: 'hint', text: t('spyReportCities') }),
                    ...r.cities.map((c) =>
                      el('button', { class: 'link', text: `${c.name} [${c.x}:${c.y}]`, title: t('islandsShowOnMap'), onclick: () => openTab('map', { center: { x: c.x, y: c.y } }) })
                    ),
                  ])
                : null,
            ]),
          ])
        );
      }
    }
    return el('div', { class: 'scroll-x' }, el('table', { class: 'grid spy-reports' }, [
      el('thead', {}, el('tr', {}, [
        share.headCheck('spyReports', reports.map((r) => r.id)),
        el('th', {}),
        ...[t('date'), t('spyOwner'), t('spyTarget'), t('spyMission'), t('spyResult'), t('spyAgents')].map((h) => el('th', { text: h })),
      ])),
      el('tbody', {}, rows),
    ]));
  }

  // One field per selected report, with its text
  function reportFields(reports, i18n) {
    const { t } = i18n;
    return reports
      .filter((r) => share.isSelected('spyReports', r.id))
      .map((r) => ({
        name: `${r.subject || t('spyMission')}: ${target(r)}`.slice(0, 256),
        value: [
          `${t('spyOwner')}: ${r.owner || '-'}`,
          `${t('spyResult')}: ${r.result || '-'}`,
          `${t('spyAgents')}: ${agentsText(r)}`,
          r.date ? `${t('date')}: ${i18n.formatTime(r.date)}` : null,
          ...(r.lines || []),
        ]
          .filter(Boolean)
          .join('\n')
          .slice(0, 1024),
      }));
  }

  function render(container, snapshot, helpers) {
    const { i18n, goToView, openTab } = helpers;
    const { t } = i18n;
    const { kpi } = IkaDios.overlayHelpers;
    const rerender = () => {
      container.replaceChildren();
      render(container, snapshot, helpers);
    };
    const cities = IkaDios.facets.ownCities(snapshot).filter((c) => c.spies);
    const reports = Object.values(snapshot?.espionage?.reports || {}).sort((a, b) => (b.date || 0) - (a.date || 0));
    const hideoutCity = IkaDios.facets.ownCities(snapshot).find((c) => (c.buildings || []).some((b) => b.type === 'safehouse'));
    const hideout = hideoutCity?.buildings.find((b) => b.type === 'safehouse');
    const openReports = (tab) => hideout && goToView('safehouse', { cityId: hideoutCity.id, position: hideout.pos, activeTab: tab });

    if (cities.length) {
      const sum = (k) => cities.reduce((acc, c) => acc + (c.spies[k] || 0), 0);
      container.append(
        el('div', { class: 'kpis' }, [
          kpi(t('spiesDefending'), i18n.formatNumber(sum('defending'))),
          kpi(t('spiesOnMission'), i18n.formatNumber(sum('onMission'))),
          kpi(t('spiesTraining'), i18n.formatNumber(sum('training'))),
        ]),
        spiesTable(cities, i18n, goToView)
      );
    } else {
      container.append(el('p', { class: 'empty', text: t('pending_espionage') }));
    }

    const player = snapshot?.account?.playerName || t('discordUnknownPlayer');
    container.append(
      el('h3', { class: 'section-title', text: t('spyReports') }),
      el('p', { class: 'age' }, [
        snapshot?.espionage?.reportsUpdatedAt ? t('updated', { when: i18n.formatRelative(snapshot.espionage.reportsUpdatedAt) }) : t('spyReportsHint'),
        ' ',
        hideout ? el('button', { class: 'link', text: t('spyOpenReports'), onclick: () => openReports('tabReports') }) : null,
        ' ',
        hideout ? el('button', { class: 'link', text: t('spyOpenArchive'), onclick: () => openReports('tabArchive') }) : null,
      ])
    );
    if (!reports.length) {
      container.append(el('p', { class: 'empty', text: t('spyNoReports') }));
      return;
    }
    container.append(
      share.shareBar({
        i18n,
        scopeLabel: t('shareSelectedRows'),
        build: async () => {
          const world = snapshot?.account?.world;
          const selected = reports.filter((r) => share.isSelected('spyReports', r.id));
          const links = [];
          for (const r of selected.slice(0, 5)) {
            const url = world ? await IkaDios.intelLink.build(world, 'spy', { report: r }, player).catch(() => null) : null;
            if (url) links.push({ label: t('intelOpenSpy', { subject: r.subject || target(r) }), url });
          }
          return { title: t('spyShareTitle', { player }), fields: reportFields(reports, i18n), links };
        },
      }),
      reportsTable(reports, i18n, openTab, rerender)
    );
  }

  IkaDios.tabs.register({ id: 'espionage', labelKey: 'tab_espionage', order: 55, render });
})(typeof self !== 'undefined' ? self : window);

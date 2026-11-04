// Finances tab: gold, income and upkeep breakdown, hours left if the balance is negative.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { el } = IkaDios.util;

  function render(container, snapshot, { i18n, goToView }) {
    const { t } = i18n;
    const { kpi } = IkaDios.overlayHelpers;
    const d = IkaDios.facets.finances(snapshot);

    container.append(
      el('div', { class: 'kpis' }, [
        kpi(t('gold'), i18n.formatNumber(d.gold), d.updatedAt),
        kpi(t('netPerHour'), d.net != null ? i18n.formatSigned(d.net) : '-', d.updatedAt),
        d.hoursLeft != null ? kpi(t('goldRunsOutIn'), i18n.formatDuration(d.hoursLeft * 3600), d.updatedAt) : null,
      ])
    );

    const line = (key, value) =>
      el('tr', { 'data-updated': d.updatedAt || null }, [el('td', { text: t(key) }), el('td', { class: 'num', text: value != null ? i18n.formatSigned(value) : '-' })]);

    container.append(
      el('table', { class: 'grid narrow' }, [
        el('tbody', {}, [
          line('income', d.income),
          line('upkeep', d.upkeep),
          line('scientistsUpkeep', d.scientistsUpkeep),
          line('godGold', d.godGoldResult),
        ]),
      ]),
      el('p', { class: 'age', text: t('updated', { when: i18n.formatRelative(d.updatedAt) }) }),
      d.perCity.length
        ? el('table', { class: 'grid' }, [
            el('thead', {}, el('tr', {}, [t('city'), t('income'), t('scientistsUpkeep'), t('financesResult')].map((h) => el('th', { text: h })))),
            el('tbody', {}, d.perCity.map((c) =>
              el('tr', { 'data-updated': d.perCityUpdatedAt || null }, [
                el('td', { text: c.name || c.id }),
                el('td', { class: 'num', text: i18n.formatSigned(c.income) }),
                el('td', { class: 'num', text: i18n.formatSigned(-Math.abs(c.scientists || 0)) }),
                el('td', { class: 'num', text: i18n.formatSigned(c.result) }),
              ])
            )),
          ])
        : null,
      el('button', { class: 'btn-soft', text: t('openFinances'), onclick: () => goToView('finances') })
    );
  }

  IkaDios.tabs.register({ id: 'finances', labelKey: 'tab_finances', order: 70, render });
})(typeof self !== 'undefined' ? self : window);

// Transport tab: merchant ships and freighters, plus transport movements (from the
// military advisor) with row selection and sharing.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { el } = IkaDios.util;

  const isTransport = (m) => m.mission === 'transport' || (m.cargo?.length && !m.units);

  function render(container, snapshot, { i18n, countdown, goToView }) {
    const { t } = i18n;
    const { kpi } = IkaDios.overlayHelpers;
    const data = IkaDios.facets.transport(snapshot);
    const pair = (free, max) => (max != null ? `${i18n.formatNumber(free)} / ${i18n.formatNumber(max)}` : '-');
    const military = IkaDios.militaryTab;
    const list = military.sortedMovements(snapshot, isTransport);
    const player = snapshot?.account?.playerName || t('discordUnknownPlayer');

    container.append(
      el('div', { class: 'kpis' }, [
        kpi(t('transportersFree'), pair(data.freeTransporters, data.maxTransporters), data.updatedAt),
        kpi(t('freightersFree'), pair(data.freeFreighters, data.maxFreighters), data.updatedAt),
      ]),
      list.length
        ? IkaDios.share.shareBar({
            i18n,
            scopeLabel: t('shareSelectedRows'),
            build: () => ({ title: t('shareTransportTitle', { player }), fields: military.movementFields(list, 'transports', i18n) }),
          })
        : '',
      el('h3', { class: 'section-title', text: t('tab_transport') }),
      list.length
        ? military.movementsTable(list, 'transports', i18n, countdown)
        : el('p', { class: 'empty' }, [
            t('emptyTransport'),
            ' ',
            el('button', { class: 'btn-soft', text: t('openMilitaryAdvisor'), onclick: () => goToView('militaryAdvisor') }),
          ]),
      el('p', { class: 'age', text: t('updated', { when: i18n.formatRelative(snapshot?.military?.updatedAt || data.updatedAt) }) })
    );
  }

  IkaDios.tabs.register({ id: 'transport', labelKey: 'tab_transport', order: 40, render });
})(typeof self !== 'undefined' ? self : window);

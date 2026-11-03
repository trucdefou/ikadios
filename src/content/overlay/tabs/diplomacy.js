// Diplomacy tab: message counters and the latest inbox entries (metadata only).
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { el } = IkaDios.util;

  function render(container, snapshot, { i18n, goToView }) {
    const { t } = i18n;
    const { kpi } = IkaDios.overlayHelpers;
    const d = snapshot?.diplomacy || {};
    if (!d.updatedAt) {
      container.append(
        el('p', { class: 'empty', text: t('pending_diplomacy') }),
        el('button', { class: 'link', text: t('openInGame'), onclick: () => goToView('diplomacyAdvisor') })
      );
      return;
    }
    container.append(
      el('div', { class: 'kpis' }, [
        kpi(t('diplomacyUnread'), i18n.formatNumber(d.unreadMessages), d.updatedAt),
        kpi(t('diplomacyAgora'), i18n.formatNumber(d.agora), d.updatedAt),
        kpi(t('diplomacyAlliance'), i18n.formatNumber(d.alliance), d.updatedAt),
        kpi(t('diplomacyInbox'), d.inbox != null ? `${i18n.formatNumber(d.inbox)} / ${i18n.formatNumber(d.outbox)}` : '-', d.updatedAt),
      ])
    );
    const rows = (d.messages || []).map((m) =>
      el('tr', { title: m.excerpt || '' }, [
        el('td', { text: m.sender }),
        el('td', { text: m.subject }),
        el('td', { text: m.city }),
        el('td', { text: m.date }),
      ])
    );
    container.append(
      rows.length
        ? el('table', { class: 'grid' }, [
            el('thead', {}, el('tr', {}, [t('diplomacyFrom'), t('diplomacySubject'), t('city'), t('diplomacyDate')].map((h) => el('th', { text: h })))),
            el('tbody', {}, rows),
          ])
        : el('p', { class: 'empty', text: t('diplomacyNoMessages') }),
      el('p', { class: 'hint', text: t('diplomacyPrivacy') }),
      el('button', { class: 'link', text: t('openInGame'), onclick: () => goToView('diplomacyAdvisor') })
    );
  }

  IkaDios.tabs.register({ id: 'diplomacy', labelKey: 'tab_diplomacy', order: 50, render });
})(typeof self !== 'undefined' ? self : window);

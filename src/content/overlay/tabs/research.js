// Research tab: points, scientists and the next research of every branch.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { el } = IkaDios.util;

  // Experiments still needed to afford a research: crystal and minimum time
  function experimentsFor(branch, research, glassStock) {
    const exp = research.experiment;
    if (!exp?.points || branch.maxed || branch.cost == null || research.points == null) return null;
    const missing = branch.cost - research.points;
    if (missing <= 0) return { count: 0 };
    const count = Math.ceil(missing / exp.points);
    const glass = count * exp.glass;
    return {
      count,
      glass,
      enoughGlass: glass <= glassStock,
      // The first one can run now; each further one waits for the cooldown
      hours: exp.cooldownHours != null ? (count - 1) * exp.cooldownHours : null,
    };
  }

  function experimentsCell(info, i18n) {
    const { t } = i18n;
    if (!info) return el('td', { class: 'na', text: '-' });
    if (info.count === 0) return el('td', { class: 'na', text: '0' });
    return el('td', { class: info.enoughGlass ? '' : 'warn' }, [
      el('strong', { text: i18n.formatNumber(info.count) }),
      el('small', { class: 'age', text: ` ${t('researchExpGlass', { glass: i18n.formatNumber(info.glass) })}` }),
      info.hours ? el('small', { class: 'age', text: ` ${t('researchExpTime', { time: i18n.formatDuration(info.hours * 3600) })}` }) : null,
    ]);
  }

  function render(container, snapshot, { i18n, countdown, goToView }) {
    const { t } = i18n;
    const { kpi } = IkaDios.overlayHelpers;
    const r = snapshot?.research || {};
    if (!r.updatedAt) {
      container.append(
        el('p', { class: 'empty', text: t('pending_research') }),
        el('button', { class: 'link', text: t('openInGame'), onclick: () => goToView('researchAdvisor') })
      );
      return;
    }
    const scientists = IkaDios.facets.ownCities(snapshot).reduce((sum, c) => sum + (c.townHall?.scientists || 0), 0);
    const glassStock = IkaDios.facets.summary(snapshot).cities.reduce((sum, c) => sum + (c.resources.glass.amount || 0), 0);
    const exp = r.experiment;
    container.append(
      el('div', { class: 'kpis' }, [
        kpi(t('researchPoints'), i18n.formatNumber(r.points), r.updatedAt),
        kpi(t('researchPerHour'), r.pointsPerHour != null ? i18n.formatNumber(r.pointsPerHour, { maximumFractionDigits: 2 }) : '-', r.updatedAt),
        kpi(t('researchScientists'), i18n.formatNumber(r.scientists ?? scientists), r.updatedAt),
        exp ? kpi(t('researchExperiment'), t('researchExperimentValue', { points: i18n.formatNumber(exp.points), glass: i18n.formatNumber(exp.glass) }), exp.updatedAt) : null,
        kpi(t('researchGlassStock'), i18n.formatNumber(glassStock)),
      ])
    );
    const rows = (r.branches || []).map((b) => {
      let status;
      if (b.maxed) status = el('span', { class: 'na', text: t('researchMaxed') });
      else if (b.cost != null && r.points != null && r.points >= b.cost) status = el('strong', { class: 'ok-text', text: t('researchAvailable') });
      else if (b.availableAt) status = el('span', {}, [t('researchIn'), ' ', countdown(b.availableAt)]);
      else status = el('span', { text: '-' });
      return el('tr', { class: b.active ? 'is-current' : '', 'data-updated': r.updatedAt }, [
        el('td', {}, [el('strong', { text: b.label || t(`researchBranch_${b.id}`) }), b.active ? el('small', { class: 'age', text: ` ${t('researchCurrent')}` }) : null]),
        el('td', { title: b.effect || '', text: b.next || '-' }),
        el('td', { class: 'num', text: b.cost != null ? i18n.formatNumber(b.cost) : '-' }),
        el('td', {}, status),
        experimentsCell(experimentsFor(b, r, glassStock), i18n),
      ]);
    });
    container.append(
      el('table', { class: 'grid' }, [
        el('thead', {}, el('tr', {}, [t('researchBranch'), t('researchNext'), t('researchCost'), t('researchStatus'), t('researchExperiments')].map((h) => el('th', { text: h })))),
        el('tbody', {}, rows),
      ]),
      el('p', { class: 'age', text: t('updated', { when: i18n.formatRelative(r.updatedAt) }) }),
      exp ? el('p', { class: 'hint', text: t('researchExpHint', { hours: exp.cooldownHours ?? '?' }) }) : el('p', { class: 'hint', text: t('researchExpPending') })
    );
  }

  IkaDios.tabs.register({ id: 'research', labelKey: 'tab_research', order: 30, render });
})(typeof self !== 'undefined' ? self : window);

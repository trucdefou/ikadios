// Summary tab: one row per city with resources, wine, population and construction.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { el } = IkaDios.util;
  const { RESOURCES } = IkaDios.schema;

  function resourceCell(r, i18n, updatedAt) {
    const pct = r.fill != null ? Math.round(r.fill * 100) : null;
    const level = pct == null ? '' : pct >= 95 ? 'is-full' : pct >= 80 ? 'is-high' : '';
    const title = [
      r.capacity != null ? `${i18n.formatNumber(r.amount)} / ${i18n.formatNumber(r.capacity)}` : null,
      r.perHour ? i18n.t('perHour', { value: i18n.formatSigned(r.perHour) }) : null,
      r.toFull ? i18n.t('fullIn', { time: i18n.formatDuration(r.toFull) }) : null,
    ]
      .filter(Boolean)
      .join('\n');
    return el('td', { class: `res ${level}`, title, 'data-updated': updatedAt || null }, [
      el('span', { class: 'num', text: i18n.formatNumber(r.amount) }),
      pct != null ? el('span', { class: 'bar' }, el('span', { style: { width: `${Math.min(pct, 100)}%` } })) : null,
    ]);
  }

  function render(container, snapshot, { i18n, countdown, goToView, stamp }) {
    const { t } = i18n;
    const data = IkaDios.facets.summary(snapshot);
    const g = data.global;

    container.append(
      el('div', { class: 'kpis' }, [
        kpi(t('gold'), i18n.formatNumber(g.gold), g.updatedAt),
        kpi(t('transporters'), g.maxTransporters != null ? `${g.freeTransporters} / ${g.maxTransporters}` : '-', g.updatedAt),
        kpi(t('ambrosia'), i18n.formatNumber(g.ambrosia), g.updatedAt),
        kpi(t('cities'), String(data.cities.length)),
      ])
    );

    const status = el('span', { class: 'hint' });
    container.append(
      el('div', { class: 'popover-actions' }, [
        IkaDios.icons.brand(el('button', {
          class: 'refresh discord',
          text: t('sendToDiscord'),
          onclick: async (e) => {
            // Keep the element: inside the Shadow DOM, event.target is cleared after an await
            const button = e.currentTarget;
            button.disabled = true;
            try {
              const res = await chrome.runtime.sendMessage({ type: 'ikadios:discordSummary' });
              status.textContent = IkaDios.discordResultText(res, i18n);
            } catch (err) {
              status.textContent = t('discordFailedReason', { reason: String(err?.message || err) });
            } finally {
              button.disabled = false;
            }
          },
        }), 'discord'),
        status,
      ])
    );

    const alerts = IkaDios.overlay.currentAlerts();
    if (alerts.length) {
      container.append(
        el(
          'div',
          { class: 'alerts' },
          alerts.map((a) => {
            const target = IkaDios.alerts.viewFor(a);
            return el('button', {
              class: `alert is-${a.severity}`,
              text: IkaDios.alerts.describe(a, i18n),
              onclick: () => target && goToView(target.view, target.params),
            });
          })
        )
      );
    }

    if (!data.cities.length) {
      container.append(el('p', { class: 'empty', text: t('emptySummary') }));
      return;
    }

    const head = el('tr', {}, [
      el('th', { text: t('city') }),
      ...RESOURCES.map((r) => el('th', { class: `res-head res-${r}`, title: t(`resource_${r}`), text: t(`resourceShort_${r}`) })),
      el('th', { text: t('wineLeft') }),
      el('th', { text: t('citizens') }),
      el('th', { text: t('construction') }),
    ]);

    const rows = data.cities.map((c) =>
      el('tr', {}, [
        el('td', { class: 'city', title: c.coords ? `[${c.coords.x}:${c.coords.y}]` : '' }, [
          el('span', { text: c.name || c.id }),
          el('small', { class: 'age', text: i18n.formatRelative(c.updatedAt) }),
        ]),
        ...RESOURCES.map((r) => resourceCell(c.resources[r], i18n, c.updatedAt)),
        stamp(el('td', { class: c.wineHours != null && c.wineHours < 12 ? 'warn' : '' }, c.wineHours != null ? i18n.formatDuration(c.wineHours * 3600) : '-'), c.updatedAt),
        stamp(el('td', {}, c.citizens != null ? `${i18n.formatNumber(c.citizens)} / ${i18n.formatNumber(c.population)}` : '-'), c.updatedAt),
        el(
          'td',
          { 'data-updated': c.buildingsUpdatedAt || null },
          c.construction
            ? [i18n.buildingName(c.construction.type), ' ', countdown(c.construction.upgradeEndsAt)]
            : '-'
        ),
      ])
    );

    container.append(el('table', { class: 'grid' }, [el('thead', {}, head), el('tbody', {}, rows)]));
  }

  // updatedAt (ms) makes the box show its data age on hover
  function kpi(label, value, updatedAt) {
    return el('div', { class: 'kpi', 'data-updated': updatedAt || null }, [el('span', { class: 'kpi-label', text: label }), el('strong', { text: value })]);
  }

  function advisorView(advisor) {
    return { cities: 'tradeAdvisor', military: 'militaryAdvisor', research: 'researchAdvisor', diplomacy: 'diplomacyAdvisor' }[advisor];
  }

  IkaDios.tabs.register({ id: 'summary', labelKey: 'tab_summary', order: 0, render });
  // Text for a Discord send result; `noWebhookKey` explains a missing channel
  IkaDios.discordResultText = (res, i18n, noWebhookKey = 'discordNoWebhook') => {
    if (res?.ok) return i18n.t('discordSent');
    if (!res) return i18n.t('discordNoResponse');
    if (res.error === 'no-webhook' || res.error === 'filtered') return i18n.t(noWebhookKey);
    return i18n.t('discordFailedReason', { reason: res.error || '?' });
  };

  IkaDios.overlayHelpers = { kpi, advisorView };
})(typeof self !== 'undefined' ? self : window);

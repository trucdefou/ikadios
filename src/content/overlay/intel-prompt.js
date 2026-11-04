// "Import this?" notice for a shared link opened by hand (#ikadios-share=...):
// says what it is and who sent it, and applies it only after a click.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { el } = IkaDios.util;

  // Tab that shows each kind once imported
  const TAB = { battle: 'military', spy: 'espionage', player: 'players', plan: 'military' };

  function describe(item, i18n) {
    const { t } = i18n;
    const d = item.data;
    if (item.kind === 'battle') {
      const title = t('intelBattle', { title: IkaDios.battleReport.parse(d.text)?.title || t('battleReport') });
      const rounds = d.rounds || [];
      return rounds.length ? `${title} ${t('intelBattleRounds', { from: rounds[0].n, to: rounds[rounds.length - 1].n })}` : title;
    }
    if (item.kind === 'spy') return t('intelSpy', { subject: d.report.subject || '-', owner: d.report.owner || '-' });
    if (item.kind === 'player') return t('intelPlayer', { name: d.name, tag: d.tag ? t(`playerTag_${d.tag}`) : '-', note: d.note || '' });
    return t('intelPlan', { title: d.title || '-', x: d.target.x, y: d.target.y, when: i18n.formatTime(d.arriveAt) });
  }

  function box(item, i18n) {
    const { t } = i18n;
    const status = el('span', { class: 'hint' });
    const close = () => IkaDios.overlay.notice(null);
    return el('div', { class: 'trade-form delivery intel-import' }, [
      el('strong', { text: t('intelFrom', { player: item.from || '?' }) }),
      el('div', { text: describe(item, i18n) }),
      el('div', { class: 'trade-row' }, [
        el('button', {
          class: 'refresh',
          text: t('mapImport'),
          onclick: async () => {
            const snap = IkaDios.store.get();
            const world = snap?.account?.world || IkaDios.util.parseGameHost(location.hostname).world;
            const res = await IkaDios.intelApply.apply(item, { world, updateSnapshot: async (fn) => IkaDios.store.update(fn) });
            status.textContent = t(res.added ? 'intelImported' : 'intelAlready');
            IkaDios.overlay.showTab(TAB[item.kind]);
            setTimeout(close, 2500);
          },
        }),
        el('button', { class: 'btn-soft danger', text: t('deliveryDiscard'), onclick: close }),
        status,
      ]),
      el('p', { class: 'age', text: t('intelHint') }),
    ]);
  }

  function show(item, i18n) {
    IkaDios.overlay.showTab(TAB[item.kind]);
    IkaDios.overlay.notice(box(item, i18n));
  }

  IkaDios.intelPrompt = { show, describe, TAB };
})(typeof self !== 'undefined' ? self : window);

// Popup: detected account, overlay toggle and quick advisor pack switch.
(function () {
  'use strict';

  const { el } = IkaDios.util;
  const i18n = IkaDios.i18n;
  const packs = IkaDios.packs;
  const t = (...a) => i18n.t(...a);

  const $ = (id) => document.getElementById(id);

  async function gameTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true, url: 'https://*.ikariam.gameforge.com/*' });
    return tab || null;
  }

  async function renderStatus() {
    const tab = await gameTab();
    $('btnToggle').disabled = !tab;
    if (!tab) {
      $('status').textContent = t('popupNoGameTab');
      return;
    }
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'ikadios:status' });
      $('status').textContent = res?.updatedAt
        ? t('popupStatus', { world: res.world, when: i18n.formatRelative(res.updatedAt) })
        : t('popupWaitingData', { world: res?.world || '' });
    } catch {
      $('status').textContent = t('popupReloadTab');
    }
  }

  async function renderPacks() {
    const [all, activeId] = await Promise.all([packs.getPacks(), packs.getActivePackId()]);
    $('selPack').replaceChildren(
      ...Object.values(all).map((p) => el('option', { value: p.id, text: packs.localized(p.name, i18n.locale) || p.id }))
    );
    $('selPack').value = activeId;
  }

  async function start() {
    await i18n.init();
    i18n.applyDom();
    renderStatus();
    renderPacks();

    $('btnToggle').addEventListener('click', async () => {
      const tab = await gameTab();
      if (tab) chrome.tabs.sendMessage(tab.id, { type: 'ikadios:toggleOverlay' }).catch(() => {});
      window.close();
    });
    $('selPack').addEventListener('change', (e) => packs.setActivePackId(e.target.value));
    $('btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  }

  start();
})();

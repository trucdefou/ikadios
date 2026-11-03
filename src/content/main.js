// Content script entry point (isolated world).
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { parseGameHost, log } = IkaDios.util;

  async function start() {
    const host = parseGameHost(location.hostname);
    // Lobby and other non-world pages have no game to observe
    if (!host.server) return;

    await IkaDios.i18n.init({ gameLang: host.lang });
    await IkaDios.bridge.init({ world: host.world });
    IkaDios.bridge.requestModel();

    // Delivery link from Discord (#ikadios-trade=...): keep it, clean the URL
    const delivery = IkaDios.tradeLink.parse(location.hash);
    if (delivery) {
      IkaDios.tradeDelivery = delivery;
      history.replaceState(null, '', location.pathname + location.search);
    }
    // Shared map link (#ikadios-map=...): the map tab asks before importing
    const mapImport = location.hash.includes(IkaDios.mapShare.HASH_KEY) ? await IkaDios.mapShare.decode(location.hash) : null;
    if (mapImport) {
      IkaDios.mapImport = mapImport;
      history.replaceState(null, '', location.pathname + location.search);
    }

    // Shared item link (#ikadios-share=...): asks before importing
    const intelImport = location.hash.includes(IkaDios.intelLink.HASH_KEY) ? await IkaDios.intelLink.decode(location.hash) : null;
    if (intelImport) history.replaceState(null, '', location.pathname + location.search);

    onBody(async () => {
      IkaDios.allianceAuto.init();
      IkaDios.advisorsSkin.init();
      await IkaDios.overlay.mount();
      if (IkaDios.mapImport) IkaDios.overlay.showTab('map');
      if (intelImport) IkaDios.intelPrompt.show(intelImport, IkaDios.i18n);
      if (IkaDios.tradeDelivery) {
        const { settings } = await chrome.storage.local.get('settings');
        // Checkbox in the Trade tab: deliver from the IkaDios panel or the game's window
        if (settings?.deliveryMode === 'panel') {
          IkaDios.overlay.showTab('trade');
          window.postMessage(
            { source: IkaDios.util.MESSAGE_SOURCE, direction: 'content', kind: 'transportClose', payload: { to: IkaDios.tradeDelivery.to } },
            location.origin
          );
        } else {
          prefillDelivery(IkaDios.tradeDelivery);
        }
      }
    });

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg?.type === 'ikadios:toggleOverlay') {
        IkaDios.overlay.toggle();
        sendResponse({ ok: true });
      }
      if (msg?.type === 'ikadios:status') {
        const snap = IkaDios.store.get();
        sendResponse({ ok: true, world: host.world, account: snap?.account, updatedAt: snap?.global?.updatedAt || 0 });
      }
    });

    // Debug helpers. In DevTools pick the "IkaDios" context in the console dropdown.
    root.ikadiosDump = () => IkaDios.store.get();
    root.ikadiosLastActions = () => IkaDios.bridge.lastActions();
    log('ready on', host.world);
  }

  // Opens the game's transport window to the requester's city with the asked
  // amounts typed in. If that fails, the Trade tab shows the delivery panel instead.
  function prefillDelivery(request) {
    const onResult = (event) => {
      if (event.source !== window || event.data?.source !== IkaDios.util.MESSAGE_SOURCE || event.data.kind !== 'transportPrefillResult') return;
      window.removeEventListener('message', onResult);
      const res = event.data.payload || {};
      if (res.ok) return;
      IkaDios.tradeDeliveryError = res.error || 'undefined';
      IkaDios.overlay.showTab('trade');
    };
    window.addEventListener('message', onResult);
    const amounts = Object.fromEntries(request.items.map((i) => [i.resource, i.amount]));
    window.postMessage({ source: IkaDios.util.MESSAGE_SOURCE, direction: 'content', kind: 'transportPrefill', payload: { to: request.to, amounts } }, location.origin);
  }

  function onBody(fn) {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
  }

  start();
})(typeof self !== 'undefined' ? self : window);

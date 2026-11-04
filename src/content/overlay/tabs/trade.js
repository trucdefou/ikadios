// Trade tab: market offers around your cities (best price first) and the stock of
// each resource across the account.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { el } = IkaDios.util;
  const { RESOURCES } = IkaDios.schema;

  const MAX_ROWS = 8;

  function stockTable(snapshot, i18n) {
    const cities = IkaDios.facets.summary(snapshot).cities;
    const totals = Object.fromEntries(RESOURCES.map((r) => [r, cities.reduce((a, c) => a + (c.resources[r].amount || 0), 0)]));
    const perHour = Object.fromEntries(RESOURCES.map((r) => [r, cities.reduce((a, c) => a + (c.resources[r].perHour || 0), 0)]));
    return el('table', { class: 'grid' }, [
      el('thead', {}, el('tr', {}, [i18n.t('tradeResource'), i18n.t('tradeStock'), i18n.t('tradePerHour')].map((h) => el('th', { text: h })))),
      el('tbody', {}, RESOURCES.map((r) =>
        el('tr', {}, [
          el('td', { text: i18n.t(`resource_${r}`) }),
          el('td', { class: 'num', text: i18n.formatNumber(totals[r]) }),
          el('td', { class: `num ${perHour[r] < 0 ? 'warn' : ''}`, text: i18n.formatSigned(perHour[r]) }),
        ])
      )),
    ]);
  }

  function marketTable(entry, snapshot, i18n) {
    const from = snapshot?.cities?.[entry.fromCityId]?.name || '';
    // Buying: cheapest first; selling: best paying first
    const offers = [...entry.offers].sort((a, b) => (entry.kind === 'buy' ? a.price - b.price : b.price - a.price)).slice(0, MAX_ROWS);
    return el('div', {}, [
      el('h3', { class: 'section-title', text: i18n.t(`tradeMarket_${entry.kind}`, { resource: i18n.t(`resource_${entry.resource}`), city: from }) }),
      el('table', { class: 'grid', 'data-updated': entry.updatedAt }, [
        el('thead', {}, el('tr', {}, [i18n.t('tradeSeller'), i18n.t('tradeAmount'), i18n.t('tradePrice'), i18n.t('tradeDistance')].map((h) => el('th', { text: h })))),
        el('tbody', {}, offers.map((o) =>
          el('tr', {}, [
            el('td', { text: o.player ? `${o.city} (${o.player})` : o.city }),
            el('td', { class: 'num', text: i18n.formatNumber(o.amount) }),
            el('td', { class: 'num', text: i18n.formatNumber(o.price) }),
            el('td', { class: 'num', text: i18n.formatNumber(o.distance) }),
          ])
        )),
      ]),
      el('p', { class: 'age', text: i18n.t('updated', { when: i18n.formatRelative(entry.updatedAt) }) }),
    ]);
  }

  // ---------- Alliance request / offer (sent to Discord) ----------

  const MAX_ITEMS = 5;
  // Form state survives data updates and tab switches
  const form = { kind: 'need', cityId: null, items: [{ resource: 'wood', amount: '' }], exchange: '', note: '' };

  // Same content as the Discord message, as WhatsApp text (*bold*). WhatsApp has
  // no way to post into a group by itself: this opens WhatsApp with the text ready
  // and the player picks the group and sends.
  function whatsappText(snapshot, i18n, items) {
    const { t } = i18n;
    const city = snapshot?.cities?.[form.cityId];
    const coords = city?.coords ? ` [${city.coords.x}:${city.coords.y}]` : '';
    const player = snapshot?.account?.playerName || t('discordUnknownPlayer');
    const lines = [
      `*${t(form.kind === 'offer' ? 'tradeListingTitleOffer' : 'tradeListingTitleNeed', { player })}*`,
      form.note ? form.note : null,
      `${t(form.kind === 'offer' ? 'tradeListingOffers' : 'tradeListingNeeds')}: ${items.map((i) => `${t(`resource_${i.resource}`)} ${i18n.formatNumber(i.amount)}`).join(', ')}`,
      city ? `${t(form.kind === 'offer' ? 'tradeListingFrom' : 'tradeListingDeliverTo')}: ${city.name}${coords}` : null,
      form.exchange ? `${t('tradeListingExchange')}: ${form.exchange}` : null,
    ];
    if (form.kind === 'need' && city && snapshot?.account?.world) {
      const link = IkaDios.tradeLink.build(snapshot.account.world, {
        to: String(form.cityId),
        toName: city.name,
        coords: city.coords || null,
        player,
        items,
        note: form.note || '',
      });
      lines.push(`${t('tradeListingSendLink')}: ${link}`);
    }
    return lines.filter(Boolean).join('\n');
  }

  function listingForm(snapshot, i18n) {
    const { t } = i18n;
    const cities = IkaDios.facets.ownCities(snapshot);
    if (!form.cityId && cities.length) form.cityId = cities[0].id;
    const status = el('span', { class: 'hint' });

    const kind = el('select', { onchange: (e) => (form.kind = e.target.value) }, [
      el('option', { value: 'need', text: t('tradeListingKindNeed') }),
      el('option', { value: 'offer', text: t('tradeListingKindOffer') }),
    ]);
    kind.value = form.kind;

    const city = el(
      'select',
      { onchange: (e) => (form.cityId = e.target.value) },
      cities.map((c) => el('option', { value: c.id, text: c.coords ? `${c.name} [${c.coords.x}:${c.coords.y}]` : c.name }))
    );
    city.value = form.cityId || '';

    const itemsBox = el('div', { class: 'trade-items' });
    const drawItems = () =>
      itemsBox.replaceChildren(
        ...form.items.map((item, i) => {
          const res = el(
            'select',
            { onchange: (e) => (item.resource = e.target.value) },
            RESOURCES.map((r) => el('option', { value: r, text: t(`resource_${r}`) }))
          );
          res.value = item.resource;
          return el('div', { class: 'trade-item' }, [
            res,
            el('input', {
              type: 'number',
              min: '0',
              step: '1000',
              value: item.amount,
              placeholder: t('tradeAmount'),
              oninput: (e) => (item.amount = e.target.value),
            }),
            form.items.length > 1
              ? el('button', { class: 'btn-soft danger', text: t('remove'), onclick: () => { form.items.splice(i, 1); drawItems(); } })
              : null,
          ]);
        }),
        form.items.length < MAX_ITEMS
          ? el('button', { class: 'btn-soft', text: t('tradeListingAddResource'), onclick: () => { form.items.push({ resource: 'marble', amount: '' }); drawItems(); } })
          : ''
      );
    drawItems();

    const exchange = el('input', { type: 'text', maxlength: '120', value: form.exchange, placeholder: t('tradeListingExchangePlaceholder'), oninput: (e) => (form.exchange = e.target.value) });
    const note = el('input', { type: 'text', maxlength: '300', value: form.note, placeholder: t('tradeListingNotePlaceholder'), oninput: (e) => (form.note = e.target.value) });

    const send = el('button', {
      class: 'refresh discord',
      text: t('sendToDiscord'),
      onclick: async () => {
        const items = form.items.filter((i) => Number(i.amount) > 0).map((i) => ({ resource: i.resource, amount: Number(i.amount) }));
        if (!items.length) {
          status.textContent = t('tradeListingEmpty');
          return;
        }
        send.disabled = true;
        try {
          const res = await chrome.runtime.sendMessage({ type: 'ikadios:discordTradeListing', listing: { ...form, items } });
          status.textContent = IkaDios.discordResultText(res, i18n, 'tradeListingNoWebhook');
        } catch (err) {
          status.textContent = t('discordFailedReason', { reason: String(err?.message || err) });
        } finally {
          send.disabled = false;
        }
      },
    });

    // Alliance bot channel: the other members' IkaDios list the request in the
    // Alliance tab, where one of them can take it ("I will send it")
    const alliance = el('button', {
      class: 'refresh',
      text: t('shareAlliance'),
      title: t('shareAllianceHint'),
      hidden: IkaDios.allianceAuto?.ready() ? null : true,
      onclick: async () => {
        const items = form.items.filter((i) => Number(i.amount) > 0).map((i) => ({ resource: i.resource, amount: Number(i.amount) }));
        if (!items.length) {
          status.textContent = t('tradeListingEmpty');
          return;
        }
        alliance.disabled = true;
        const res = await chrome.runtime.sendMessage({ type: 'ikadios:allianceTradeListing', listing: { ...form, items } }).catch((err) => ({ ok: false, error: String(err) }));
        alliance.disabled = false;
        status.textContent = res?.ok ? t('shareAllianceSent') : t('discordFailedReason', { reason: res?.error || '?' });
      },
    });

    const whatsapp = el('button', {
      class: 'refresh whatsapp',
      text: t('shareWhatsApp'),
      title: t('shareWhatsAppHint'),
      onclick: () => {
        const items = form.items.filter((i) => Number(i.amount) > 0).map((i) => ({ resource: i.resource, amount: Number(i.amount) }));
        if (!items.length) {
          status.textContent = t('tradeListingEmpty');
          return;
        }
        const url = `https://api.whatsapp.com/send?text=${encodeURIComponent(whatsappText(snapshot, i18n, items))}`;
        window.open(url, '_blank', 'noopener');
        status.textContent = t('shareWhatsAppOpened');
      },
    });

    return el('div', { class: 'trade-form' }, [
      el('h3', { class: 'section-title', text: t('tradeListingTitle') }),
      el('div', { class: 'trade-row' }, [kind, el('span', { text: t('tradeListingIn') }), city]),
      itemsBox,
      el('div', { class: 'trade-row' }, [exchange]),
      el('div', { class: 'trade-row' }, [note]),
      el('div', { class: 'trade-row' }, [
        IkaDios.icons.brand(send, 'discord'),
        IkaDios.icons.brand(alliance, 'discord', t('shareAllianceShort')),
        IkaDios.icons.brand(whatsapp, 'whatsapp'),
        status,
      ]),
    ]);
  }

  // ---------- Pending delivery (opened from a Discord link) ----------

  const SHIP_CAPACITY = 500;

  // Origin with the most of what is asked, excluding the destination itself
  function bestOrigin(cities, request) {
    let best = null;
    for (const c of cities) {
      if (c.id === request.to) continue;
      const score = request.items.reduce((acc, i) => acc + Math.min(i.amount, c.resources[i.resource]?.amount || 0), 0);
      if (!best || score > best.score) best = { id: c.id, score };
    }
    return best?.id || null;
  }

  function deliveryPanel(snapshot, i18n) {
    const { t } = i18n;
    const request = IkaDios.tradeDelivery;
    const cities = IkaDios.facets.summary(snapshot).cities;
    const status = el('span', { class: 'hint' });
    const where = `${request.toName || request.to}${request.coords ? ` [${request.coords.x}:${request.coords.y}]` : ''}`;
    const state = (IkaDios.tradeDeliveryState = IkaDios.tradeDeliveryState || { from: null, amounts: {} });
    // Cities may arrive after the panel was first drawn (link opened on page load)
    if (!state.from || !cities.some((c) => c.id === state.from)) {
      state.from = bestOrigin(cities, request);
      state.amounts = {};
    }

    const amountsBox = el('div');
    const shipsInfo = el('span', { class: 'age' });
    const drawAmounts = () => {
      const origin = cities.find((c) => c.id === state.from);
      amountsBox.replaceChildren(
        ...request.items.map((item) => {
          const stock = Math.floor(origin?.resources[item.resource]?.amount || 0);
          if (state.amounts[item.resource] === undefined) state.amounts[item.resource] = Math.min(item.amount, stock);
          return el('div', { class: 'trade-item' }, [
            el('span', { class: 'delivery-res', text: t(`resource_${item.resource}`) }),
            el('input', {
              type: 'number',
              min: '0',
              max: String(stock),
              step: '500',
              value: String(state.amounts[item.resource]),
              oninput: (e) => {
                // Not clamped: an amount above the stock is shown and blocks sending
                state.amounts[item.resource] = Math.max(0, Math.floor(Number(e.target.value) || 0));
                updateShips();
              },
            }),
            el('span', { class: 'age', text: t('deliveryAskedStock', { asked: i18n.formatNumber(item.amount), stock: i18n.formatNumber(stock) }) }),
          ]);
        })
      );
      updateShips();
    };
    // Checks before sending; any problem disables the Send button
    const problems = () => {
      const origin = cities.find((c) => c.id === state.from);
      const list = [];
      if (!origin) list.push(t('deliveryProblemOrigin'));
      const total = Object.values(state.amounts).reduce((a, n) => a + (n || 0), 0);
      if (!total) list.push(t('tradeListingEmpty'));
      for (const [resource, amount] of Object.entries(state.amounts)) {
        const stock = Math.floor(origin?.resources[resource]?.amount || 0);
        if (amount > stock) list.push(t('deliveryProblemStock', { resource: t(`resource_${resource}`), amount: i18n.formatNumber(amount), stock: i18n.formatNumber(stock) }));
      }
      const free = snapshot?.global?.freeTransporters;
      const freighters = snapshot?.global?.freeFreighters || 0;
      const needed = Math.ceil(total / SHIP_CAPACITY);
      // Freighters can carry the rest; without them, merchant ships must be enough
      if (free != null && needed > free && !freighters) list.push(t('deliveryShipsShort', { n: needed, free }));
      return { list, needed, free };
    };

    const problemsBox = el('ul', { class: 'delivery-problems' });
    const updateShips = () => {
      const { list, needed, free } = problems();
      shipsInfo.textContent = t('deliveryShips', { n: needed, free: free ?? '-' });
      problemsBox.replaceChildren(...list.map((p) => el('li', { class: 'warn', text: p })));
      if (send) {
        send.disabled = list.length > 0 || sending;
        send.title = list.join('\n');
      }
    };
    let send = null;
    let sending = false;

    const origin = el(
      'select',
      {
        onchange: (e) => {
          state.from = e.target.value;
          state.amounts = {};
          drawAmounts();
        },
      },
      cities.filter((c) => c.id !== request.to).map((c) => el('option', { value: c.id, text: c.coords ? `${c.name} [${c.coords.x}:${c.coords.y}]` : c.name }))
    );
    origin.value = state.from || '';

    send = el('button', {
      class: 'refresh',
      text: t('deliverySend'),
      onclick: () => {
        const amounts = Object.fromEntries(Object.entries(state.amounts).filter(([, n]) => n > 0));
        if (problems().list.length) return;
        sending = true;
        send.disabled = true;
        status.className = 'hint';
        status.textContent = t('deliverySending');
        const onResult = (event) => {
          if (event.source !== window || event.data?.source !== IkaDios.util.MESSAGE_SOURCE || event.data.kind !== 'transportSendResult') return;
          window.removeEventListener('message', onResult);
          sending = false;
          updateShips();
          const res = event.data.payload || {};
          if (res.ok) {
            status.className = 'ok-text';
            status.textContent = t('deliverySent') + (res.message ? ` (${res.message})` : '');
            IkaDios.tradeDelivery = null;
            IkaDios.tradeDeliveryState = null;
          } else {
            status.className = 'warn';
            // The game's own message when it rejected the transport
            const reason = res.error === 'game' && res.message ? res.message : t(`deliveryError_${res.error}`);
            status.textContent = t('deliveryFailed', { reason });
          }
        };
        window.addEventListener('message', onResult);
        window.postMessage({ source: IkaDios.util.MESSAGE_SOURCE, direction: 'content', kind: 'transportSend', payload: { from: state.from, to: request.to, amounts } }, location.origin);
      },
    });
    const discard = el('button', {
      class: 'btn-soft danger',
      text: t('deliveryDiscard'),
      onclick: () => {
        IkaDios.tradeDelivery = null;
        IkaDios.tradeDeliveryState = null;
        panel.remove();
      },
    });

    const prefillError = IkaDios.tradeDeliveryError;
    const panel = el('div', { class: 'trade-form delivery', 'data-cities': String(IkaDios.facets.ownCities(snapshot).length) }, [
      el('h3', { class: 'section-title', text: t('deliveryTitle', { player: request.player || '?' }) }),
      prefillError ? el('p', { class: 'warn', text: t('deliveryPrefillFailed', { reason: t(`deliveryError_${prefillError}`) }) }) : null,
      el('p', { text: t('deliveryTo', { city: where }) }),
      request.note ? el('p', { class: 'hint', text: request.note }) : null,
      el('div', { class: 'trade-row' }, [el('span', { text: t('deliveryFrom') }), origin]),
      amountsBox,
      el('div', { class: 'trade-row' }, [shipsInfo]),
      problemsBox,
      el('div', { class: 'trade-row' }, [send, discard, status]),
      el('p', { class: 'age', text: t('deliveryHint') }),
    ]);
    drawAmounts();
    return panel;
  }

  // How delivery links are handled: 'panel' (this tab) or 'game' (the game's
  // transport window with the amounts filled in). Stored in settings.deliveryMode.
  function deliveryModeToggle(i18n, settings) {
    const { t } = i18n;
    return el('label', { class: 'check delivery-mode', title: t('deliveryModeHint') }, [
      el('input', {
        type: 'checkbox',
        checked: settings.deliveryMode === 'panel' ? true : null,
        onchange: async (e) => {
          // Read before awaiting: inside the Shadow DOM, event.target is cleared once dispatch ends
          const mode = e.target.checked ? 'panel' : 'game';
          const current = (await chrome.storage.local.get('settings')).settings || {};
          await chrome.storage.local.set({ settings: { ...current, deliveryMode: mode } });
        },
      }),
      el('span', { text: t('deliveryModePanel') }),
    ]);
  }

  // Prefill from another tab (Polis "ask the alliance"): {cityId, items}
  function applyPending() {
    const pending = IkaDios.tabs.pendingOptions;
    if (pending?.id !== 'trade' || !pending.request) return;
    IkaDios.tabs.pendingOptions = null;
    form.kind = 'need';
    form.cityId = pending.request.cityId || form.cityId;
    form.items = pending.request.items.map((i) => ({ resource: i.resource, amount: String(Math.ceil(i.amount)) }));
    form.note = pending.request.note || '';
  }

  function fillDynamic(box, snapshot, i18n) {
    const { t } = i18n;
    box.replaceChildren(el('h3', { class: 'section-title', text: t('tradeAccountStock') }), stockTable(snapshot, i18n));
    const markets = Object.values(snapshot?.market || {}).sort((a, b) => b.updatedAt - a.updatedAt);
    if (markets.length) for (const m of markets) box.append(marketTable(m, snapshot, i18n));
    else box.append(el('p', { class: 'empty', text: t('pending_trade') }));
  }

  function render(container, snapshot, { i18n }) {
    applyPending();
    const dynamic = el('div', { class: 'trade-dynamic' });
    const toggleBox = el('div', { class: 'trade-row' });
    container.append(toggleBox);
    chrome.storage.local.get('settings').then(({ settings }) => toggleBox.replaceChildren(deliveryModeToggle(i18n, settings || {})));
    if (IkaDios.tradeDelivery) container.append(deliveryPanel(snapshot, i18n));
    container.append(listingForm(snapshot, i18n), dynamic);
    fillDynamic(dynamic, snapshot, i18n);
  }

  // Persistent: data updates refresh stock and market only, never the form being typed
  function update(container, snapshot, { i18n }) {
    if (IkaDios.tabs.pendingOptions?.id === 'trade') {
      container.replaceChildren();
      render(container, snapshot, { i18n });
      return;
    }
    const dynamic = container.querySelector('.trade-dynamic');
    if (dynamic) fillDynamic(dynamic, snapshot, i18n);
    // The delivery panel is redrawn when the city list changes (e.g. it was empty
    // because the link opened before the account data loaded); its state is kept
    const panel = container.querySelector('.trade-form.delivery');
    const cityCount = IkaDios.facets.ownCities(snapshot).length;
    if (IkaDios.tradeDelivery && (!panel || panel.dataset.cities !== String(cityCount))) {
      const fresh = deliveryPanel(snapshot, i18n);
      if (panel) panel.replaceWith(fresh);
      else container.querySelector('.trade-form')?.before(fresh);
    }
  }

  IkaDios.tabs.register({ id: 'trade', labelKey: 'tab_trade', order: 60, persistent: true, render, update });
})(typeof self !== 'undefined' ? self : window);

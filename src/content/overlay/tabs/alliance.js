// Alliance tab: what the alliance shares through IkaDios. Member status (each
// member's IkaDios posts it to the bot channel), resource requests with "I will
// send it" (so two members do not send the same thing), and the active attack
// plans. Data written by the worker (src/background/alliance.js) or by imported
// links: allianceMembers:<world>, allianceRequests:<world>, attackPlans:<world>.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { el } = IkaDios.util;

  const STALE_MS = 24 * 3600000;
  const SHOWN_DONE = 5;
  let mounted = null;

  const lower = (s) => String(s || '').toLowerCase();
  const keys = (world) => ({ members: `allianceMembers:${world}`, requests: `allianceRequests:${world}`, plans: `attackPlans:${world}` });

  async function load(world) {
    const k = keys(world);
    const [stored, status] = await Promise.all([
      chrome.storage.local.get([k.members, k.requests, k.plans]),
      chrome.runtime.sendMessage({ type: 'ikadios:allianceStatus' }).catch(() => null),
    ]);
    return { members: stored[k.members] || {}, requests: stored[k.requests] || [], plans: stored[k.plans] || [], bot: status };
  }

  async function saveRequests(world, list) {
    await chrome.storage.local.set({ [keys(world).requests]: list });
  }

  // ---------- Sections ----------

  function botSection(data, i18n) {
    const { t } = i18n;
    const status = el('span', { class: 'hint' });
    const run = (type, okText) => async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      const res = await chrome.runtime.sendMessage({ type }).catch((err) => ({ ok: false, error: String(err) }));
      button.disabled = false;
      status.textContent = res?.ok ? okText(res) : t('discordFailedReason', { reason: res?.error || '?' });
    };
    if (!data.bot?.ready) {
      return el('div', { class: 'trade-form' }, [
        el('p', { text: t('allianceNoBot') }),
        el('button', { class: 'refresh', text: t('allianceOpenOptions'), onclick: () => chrome.runtime.sendMessage({ type: 'ikadios:openOptions' }).catch(() => {}) }),
      ]);
    }
    const st = data.bot.state || {};
    return el('div', { class: 'map-toolbar' }, [
      el('span', { text: st.lastPollAt ? t('allianceLastRead', { when: i18n.formatRelative(st.lastPollAt) }) : t('allianceNotReadYet') }),
      st.lastError ? el('span', { class: 'error', text: st.lastError }) : null,
      el('button', { class: 'refresh', text: t('optAlliancePollNow'), onclick: run('ikadios:alliancePoll', (r) => t('optAlliancePolled', { n: r.read })) }),
      el('button', { class: 'refresh', text: t('alliancePublishStatus'), title: t('alliancePublishStatusHint'), onclick: run('ikadios:alliancePublishStatus', () => t('shareAllianceSent')) }),
      status,
    ]);
  }

  function membersSection(data, i18n) {
    const { t, formatNumber } = i18n;
    const rows = Object.entries(data.members).sort((a, b) => a[0].localeCompare(b[0]));
    if (!rows.length) return el('p', { class: 'empty', text: t('allianceNoMembers') });
    const total = (key) => rows.reduce((a, [, m]) => a + (Number(m[key]) || 0), 0);
    const num = (v) => (v == null ? '-' : formatNumber(v));
    return el('div', { class: 'scroll-x' }, el('table', { class: 'grid' }, [
      el('thead', {}, el('tr', {}, [t('allianceMember'), t('playerCities'), t('allianceFreeShips'), t('allianceUnits'), t('allianceWarships'), t('allianceHostile'), t('allianceGold'), t('allianceUpdated')].map((h) => el('th', { text: h })))),
      el('tbody', {}, [
        ...rows.map(([name, m]) =>
          el('tr', { class: Date.now() - (m.at || 0) > STALE_MS ? 'na' : m.hostile ? 'hostile' : '' }, [
            el('td', {}, el('button', { class: 'link', text: name, onclick: () => mounted?.helpers.openTab('players', { player: name }) })),
            el('td', { class: 'num', text: num(m.cities) }),
            el('td', { class: 'num', text: m.freeShips != null ? `${formatNumber(m.freeShips)} / ${num(m.maxShips)}` : '-' }),
            el('td', { class: 'num', text: num(m.units) }),
            el('td', { class: 'num', text: num(m.warships) }),
            el('td', { class: `num ${m.hostile ? 'warn' : ''}`, text: num(m.hostile) }),
            el('td', { class: 'num', text: num(m.gold) }),
            el('td', { class: 'age', text: i18n.formatRelative(m.at) }),
          ])
        ),
        el('tr', { class: 'total' }, [
          el('td', { text: t('total') }),
          el('td', { class: 'num', text: formatNumber(total('cities')) }),
          el('td', { class: 'num', text: `${formatNumber(total('freeShips'))} / ${formatNumber(total('maxShips'))}` }),
          el('td', { class: 'num', text: formatNumber(total('units')) }),
          el('td', { class: 'num', text: formatNumber(total('warships')) }),
          el('td', { class: 'num', text: formatNumber(total('hostile')) }),
          el('td', { class: 'num', text: formatNumber(total('gold')) }),
          el('td', {}),
        ]),
      ]),
    ]));
  }

  const itemsText = (items, i18n) => items.map((i) => `${i18n.t(`resourceShort_${i.resource}`)} ${i18n.formatNumber(i.amount)}`).join(', ');

  function requestsSection(data, snapshot, i18n, rerender) {
    const { t } = i18n;
    const world = snapshot?.account?.world;
    const me = lower(snapshot?.account?.playerName);
    const bot = data.bot?.ready;
    const open = data.requests.filter((r) => r.status !== 'done');
    const done = data.requests.filter((r) => r.status === 'done').slice(0, SHOWN_DONE);
    if (!open.length && !done.length) return el('p', { class: 'empty', text: t('allianceNoRequests') });
    const status = el('p', { class: 'hint' });
    const claim = async (r, state) => {
      const title = t(`allianceClaimTitle_${state}`, { player: r.from, items: itemsText(r.items, i18n) });
      const res = await chrome.runtime.sendMessage({ type: 'ikadios:allianceItem', kind: 'claim', data: { requestId: r.id, status: state }, title }).catch((err) => ({ ok: false, error: String(err) }));
      status.textContent = res?.ok ? t('shareAllianceSent') : t('discordFailedReason', { reason: res?.error || '?' });
    };
    const deliver = (r) => {
      IkaDios.tradeDelivery = { to: r.cityId, toName: r.city, coords: r.x != null ? { x: r.x, y: r.y } : null, player: r.from, items: r.items, note: r.note || '' };
      mounted?.helpers.openTab('trade');
    };
    const remove = async (r) => {
      await saveRequests(world, data.requests.filter((x) => x !== r));
      rerender();
    };
    const row = (r) => {
      const mine = lower(r.from) === me;
      const helpers = Object.keys(r.claims || {});
      const claimedByMe = helpers.some((h) => lower(h) === me);
      return el('tr', { class: r.status === 'done' ? 'na' : helpers.length ? '' : 'hostile' }, [
        el('td', { text: r.from || '?' }),
        el('td', {}, r.x != null ? el('button', { class: 'link', text: `${r.city} [${r.x}:${r.y}]`, onclick: () => mounted?.helpers.openTab('map', { center: { x: r.x, y: r.y } }) }) : r.city),
        el('td', { text: itemsText(r.items, i18n) }),
        el('td', { text: r.note || '' }),
        el('td', { class: helpers.length ? 'ok-text' : 'warn', text: r.status === 'done' ? t('allianceRequestDone') : helpers.length ? t('allianceTakenBy', { players: helpers.join(', ') }) : t('allianceNobody') }),
        el('td', { class: 'age', text: i18n.formatRelative(r.at) }),
        el('td', { class: 'nowrap' }, r.status === 'done' ? [IkaDios.icons.button('trash', t('delete'), () => remove(r))] : [
          !mine && bot && !claimedByMe ? el('button', { class: 'refresh', text: t('allianceClaim'), onclick: () => claim(r, 'claim') }) : null,
          !mine && bot && claimedByMe ? el('button', { class: 'link', text: t('allianceUnclaim'), onclick: () => claim(r, 'cancel') }) : null,
          !mine ? el('button', { class: 'link', text: t('allianceDeliver'), onclick: () => deliver(r) }) : null,
          mine && bot ? el('button', { class: 'refresh', text: t('allianceMarkDone'), onclick: () => claim(r, 'done') }) : null,
          IkaDios.icons.button('trash', t('delete'), () => remove(r)),
        ]),
      ]);
    };
    return el('div', {}, [
      el('div', { class: 'scroll-x' }, el('table', { class: 'grid' }, [
        el('thead', {}, el('tr', {}, [t('allianceRequester'), t('destination'), t('cargo'), t('planNote'), t('allianceWho'), t('date'), ''].map((h) => el('th', { text: h })))),
        el('tbody', {}, [...open, ...done].map(row)),
      ])),
      bot ? null : el('p', { class: 'hint', text: t('allianceClaimNeedsBot') }),
      status,
    ]);
  }

  function plansSection(data, i18n) {
    const { t } = i18n;
    const active = data.plans.filter((p) => p.arriveAt > Date.now()).sort((a, b) => a.arriveAt - b.arriveAt);
    if (!active.length) return el('p', { class: 'empty', text: t('planNone') });
    return el('table', { class: 'grid' }, el('tbody', {}, active.map((p) => {
      const going = Object.values(p.confirmations || {}).filter((c) => c.status === 'going').length;
      return el('tr', {}, [
        el('td', {}, el('strong', { text: p.title || t('planUntitled') })),
        el('td', { text: `[${p.target.x}:${p.target.y}] ${p.target.player || ''}` }),
        el('td', { class: 'nowrap', text: i18n.formatTime(p.arriveAt) }),
        el('td', { text: t('alliancePlanGoing', { n: going }) }),
        el('td', {}, el('button', { class: 'link', text: t('allianceOpenPlan'), onclick: () => mounted?.helpers.openTab('military') })),
      ]);
    })));
  }

  // ---------- Tab ----------

  async function fill(container, snapshot, helpers) {
    const { i18n } = helpers;
    const { t } = i18n;
    const world = snapshot?.account?.world;
    if (!world) return;
    const data = await load(world);
    if (!container.isConnected) return;
    const rerender = () => fill(container, mounted.snapshot, mounted.helpers);
    container.replaceChildren(
      el('p', { class: 'hint', text: t('allianceIntro') }),
      botSection(data, i18n),
      el('h3', { class: 'section-title', text: t('allianceMembers') }),
      membersSection(data, i18n),
      el('h3', { class: 'section-title', text: t('allianceRequests') }),
      requestsSection(data, snapshot, i18n, rerender),
      el('h3', { class: 'section-title', text: t('plans') }),
      plansSection(data, i18n)
    );
  }

  function render(container, snapshot, helpers) {
    mounted = { container, snapshot, helpers };
    container.append(el('p', { class: 'hint', text: helpers.i18n.t('mapLoading') }));
    fill(container, snapshot, helpers);
  }

  function update(container, snapshot, helpers) {
    mounted = { container, snapshot, helpers };
  }

  // Data written by the worker or by imports: redraw when it changes
  if (IkaDios.util.extensionAlive()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !mounted?.container.isConnected) return;
      const relevant = Object.keys(changes).some((k) => /^(allianceMembers|allianceRequests|attackPlans):/.test(k) || k === 'allianceBotState' || k === 'allianceBot');
      if (relevant) fill(mounted.container, mounted.snapshot, mounted.helpers);
    });
  }

  IkaDios.tabs.register({ id: 'alliance', labelKey: 'tab_alliance', order: 95, persistent: true, render, update });
})(typeof self !== 'undefined' ? self : window);

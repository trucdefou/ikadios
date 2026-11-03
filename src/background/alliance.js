// Alliance bot (option 2 of collaboration): a Discord bot created by the
// alliance, whose token and private channel each member enters in the options.
// IkaDios posts shared items to that channel (same messages and import links as
// the webhooks) and reads it every few minutes, importing what other members
// posted: spy reports, battle reports, player notes, attack plans and map layers.
// Nothing is imported from the user's own posts. Config in allianceBot (token,
// channelId, enabled, pollMinutes, auto*); progress in allianceBotState.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { warn } = IkaDios.util;

  const API = 'https://discord.com/api/v10';
  const KEY = 'allianceBot';
  const STATE_KEY = 'allianceBotState';
  const ALARM = 'ikadios-alliance';
  const DEFAULT_POLL_MIN = 5;
  const MIN_POLL_MIN = 2;
  const MAX_RETRIES = 3;
  const PAGE = 50;
  const ID = /^\d{5,25}$/;

  async function getConfig() {
    return (await chrome.storage.local.get(KEY))[KEY] || {};
  }

  async function getState() {
    return (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || {};
  }

  async function setState(patch) {
    await chrome.storage.local.set({ [STATE_KEY]: { ...(await getState()), ...patch } });
  }

  const ready = (c) => c.enabled && typeof c.token === 'string' && c.token.length > 20 && ID.test(String(c.channelId || ''));

  // Discord rejects bot-token requests carrying a browser User-Agent (403, code
  // 40333 "internal network error") and asks bots for "DiscordBot (url, version)".
  // Firefox lets fetch set it; Chrome drops the header, so a session rule sets it
  // on the extension's own requests only (Discord web in a tab is not touched).
  const BOT_UA = `DiscordBot (https://github.com/trucdefou/ikadios, ${chrome.runtime.getManifest().version})`;
  const UA_RULE_ID = 1;

  let uaRule = null;
  const installUserAgentRule = () => (uaRule ||= addUserAgentRule());

  async function addUserAgentRule() {
    const dnr = chrome.declarativeNetRequest;
    if (!dnr?.updateSessionRules) return;
    await dnr
      .updateSessionRules({
        removeRuleIds: [UA_RULE_ID],
        addRules: [
          {
            id: UA_RULE_ID,
            priority: 1,
            action: { type: 'modifyHeaders', requestHeaders: [{ header: 'User-Agent', operation: 'set', value: BOT_UA }] },
            condition: {
              urlFilter: '||discord.com/api/',
              initiatorDomains: [chrome.runtime.id],
              tabIds: [chrome.tabs.TAB_ID_NONE],
              resourceTypes: ['xmlhttprequest', 'other'],
            },
          },
        ],
      })
      .catch((err) => console.warn('[IkaDios] user agent rule failed', err));
  }

  async function api(config, path, init = {}, attempt = 0) {
    await installUserAgentRule();
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bot ${config.token.trim()}`, 'Content-Type': 'application/json', 'User-Agent': BOT_UA, ...(init.headers || {}) },
    });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const data = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.ceil((Number(data.retry_after) || 1) * 1000)));
      return api(config, path, init, attempt + 1);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      // 401 bad token, 403 no access to the channel, 404 unknown channel
      // `code`: Discord's JSON error code (50001 missing access, 50013 missing
      // permissions, 40333 request blocked by Discord)
      return { ok: false, status: res.status, code: Number(body?.code) || 0, error: `HTTP ${res.status}${body?.message ? ` - ${body.message}` : ''}` };
    }
    return { ok: true, body };
  }

  // ---------- Publishing ----------

  async function share(share) {
    const config = await getConfig();
    if (!ready(config)) return { ok: false, error: 'no-bot' };
    const acc = await IkaDios.discord.account();
    if (!acc) return { ok: false, error: 'no-account' };
    await IkaDios.discord.ensureLocale(acc.world);
    const bodies = IkaDios.discord.shareBodies(share, acc);
    if (!bodies.length) return { ok: false, error: 'empty' };
    for (const body of bodies) {
      // Bots cannot set a username per message
      const { username, ...rest } = body;
      const res = await api(config, `/channels/${config.channelId}/messages`, { method: 'POST', body: JSON.stringify(rest) });
      if (!res.ok) return res;
    }
    return { ok: true, sent: bodies.length };
  }

  async function test() {
    const config = await getConfig();
    if (!config.token || !ID.test(String(config.channelId || ''))) return { ok: false, error: 'incomplete' };
    const res = await api({ ...config }, `/channels/${config.channelId}`);
    if (!res.ok) return res;
    const read = await api({ ...config }, `/channels/${config.channelId}/messages?limit=1`);
    if (!read.ok) return { ...read, channel: res.body?.name };
    return { ok: true, channel: res.body?.name || config.channelId };
  }

  // ---------- Reading ----------

  // Message text and embeds (descriptions, links, fields) where links can be
  function messageText(m) {
    const parts = [m.content || ''];
    for (const e of m.embeds || []) parts.push(e.url || '', e.description || '', ...(e.fields || []).map((f) => f.value || ''));
    return parts.join('\n');
  }

  // Snowflake ids compare as numbers
  const newer = (a, b) => (a.length !== b.length ? a.length > b.length : a > b);

  async function importMapLayer(world, decoded, from) {
    const key = `mapLayers:${world}`;
    const data = (await chrome.storage.local.get(key))[key] || { layers: [], activeLayerId: null };
    for (const layer of decoded.layers) {
      const name = `${from || decoded.from || '?'}: ${layer.name}`.slice(0, 40);
      const existing = data.layers.find((l) => l.name === name && l.shared);
      if (existing) existing.marks = layer.marks;
      else data.layers.push({ id: `layer_sh_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name, visible: true, shared: true, marks: layer.marks });
    }
    await chrome.storage.local.set({ [key]: data });
  }

  async function poll() {
    const config = await getConfig();
    if (!ready(config)) return { ok: false, error: 'no-bot' };
    const acc = await IkaDios.refreshEngine.getAccount();
    if (!acc?.world) return { ok: false, error: 'no-account' };
    const snapshot = await IkaDios.refreshEngine.loadSnapshot(acc);
    const me = String(snapshot.account?.playerName || '').toLowerCase();
    const state = await getState();
    const query = state.lastMessageId ? `after=${state.lastMessageId}&limit=${PAGE}` : `limit=${PAGE}`;
    const res = await api(config, `/channels/${config.channelId}/messages?${query}`);
    if (!res.ok) {
      await setState({ lastPollAt: Date.now(), lastError: res.error });
      return res;
    }
    const messages = (res.body || []).slice().sort((a, b) => (newer(a.id, b.id) ? 1 : -1));
    const counts = { ...(state.counts || {}) };
    let lastId = state.lastMessageId || null;
    const ctx = {
      world: acc.world,
      updateSnapshot: async (fn) => {
        const current = await IkaDios.refreshEngine.loadSnapshot(acc);
        await IkaDios.refreshEngine.saveSnapshot(acc, fn(current) || current);
      },
    };
    for (const m of messages) {
      if (!lastId || newer(m.id, lastId)) lastId = m.id;
      for (const link of IkaDios.intelLink.linksIn(messageText(m))) {
        // Links of another world (another server) are skipped
        if (!link.startsWith(`https://${acc.world}.`)) continue;
        try {
          if (link.includes(`#${IkaDios.mapShare.HASH_KEY}=`)) {
            const decoded = await IkaDios.mapShare.decode(link);
            if (!decoded || String(decoded.from || '').toLowerCase() === me) continue;
            await importMapLayer(acc.world, decoded, decoded.from);
            counts.map = (counts.map || 0) + 1;
            continue;
          }
          const item = await IkaDios.intelLink.decode(link);
          if (!item || String(item.from || '').toLowerCase() === me) continue;
          if (item.kind === 'request' && !m.webhook_id && m.author?.bot) item.data = { ...item.data, messageId: m.id };
          const result = await IkaDios.intelApply.apply(item, ctx);
          if (!result.added) continue;
          counts[item.kind] = (counts[item.kind] || 0) + 1;
          if (item.kind === 'plan') notify(acc.world, item);
        } catch (err) {
          warn('alliance import failed', err);
        }
      }
    }
    await setState({ lastMessageId: lastId, lastPollAt: Date.now(), lastError: null, counts });
    return { ok: true, read: messages.length };
  }

  async function notify(world, item) {
    try {
      await IkaDios.discord.ensureLocale(world);
      chrome.notifications.create(`ikadios:plan:${Date.now()}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: IkaDios.i18n.t('alliancePlanTitle', { player: item.from || '?' }).slice(0, 100),
        message: IkaDios.i18n.t('alliancePlanMessage', { x: item.data.target.x, y: item.data.target.y, when: IkaDios.i18n.formatTime(item.data.arriveAt) }).slice(0, 300),
        priority: 2,
      });
    } catch (err) {
      warn('alliance notification failed', err);
    }
  }

  // ---------- Coordination messages ----------

  async function post(config, body) {
    const { username, ...rest } = body;
    return api(config, `/channels/${config.channelId}/messages`, { method: 'POST', body: JSON.stringify(rest) });
  }

  // One short embed with the link that carries the item (people read the title,
  // IkaDios reads the link)
  async function postItem(kind, data, title) {
    if (!['claim', 'confirm', 'status', 'request', 'plan'].includes(kind)) return { ok: false, error: 'kind' };
    const config = await getConfig();
    if (!ready(config)) return { ok: false, error: 'no-bot' };
    const acc = await IkaDios.discord.account();
    if (!acc) return { ok: false, error: 'no-account' };
    const from = IkaDios.discord.playerLabel(acc.snapshot);
    const link = await IkaDios.intelLink.build(acc.world, kind, data, from);
    const res = await post(config, {
      allowed_mentions: { parse: [] },
      embeds: [{ title: String(title || kind).slice(0, 256), url: link, description: `[IkaDios](${link})`, color: 0x8a6a45, timestamp: new Date().toISOString() }],
    });
    // The sender's own copy is applied here, since reading skips own messages
    if (res.ok) await IkaDios.intelApply.apply({ kind, from, at: Date.now(), data: IkaDios.intelLink.CLEAN?.[kind]?.(data) || data }, { world: acc.world, updateSnapshot: async () => {} });
    if (res.ok && kind === 'claim') await updateRequestMessage(config, acc.world, data.requestId).catch((err) => warn('request message edit failed', err));
    return res.ok ? { ok: true, messageId: res.body?.id } : res;
  }

  const REQUEST_COLORS = { open: 0xc0392b, taken: 0x2e8b57, done: 0x777777 };
  // Status markers shown in Discord, written as escapes: red circle, ship, check mark
  const REQUEST_MARKS = { open: '\u{1F534}', taken: '\u{1F6A2}', done: '\u{2705}' };

  // Writes the current state of a request (who sends it, or received) into the
  // request's own bot message, in the embed author line above the title. Every
  // member uses the same bot, so any of them may edit it. The channel is read
  // first so claims of other members not yet imported are not lost.
  async function updateRequestMessage(config, world, requestId) {
    await poll().catch(() => null);
    const key = `allianceRequests:${world}`;
    const request = ((await chrome.storage.local.get(key))[key] || []).find((r) => r.id === requestId);
    if (!request?.messageId || !ID.test(String(request.messageId))) return { ok: false, error: 'no-message' };
    const path = `/channels/${config.channelId}/messages/${request.messageId}`;
    const current = await api(config, path);
    if (!current.ok) return current;
    const [first, ...rest] = current.body?.embeds || [];
    if (!first) return { ok: false, error: 'no-embed' };
    await IkaDios.discord.ensureLocale(world);
    const t = IkaDios.i18n.t;
    const helpers = Object.keys(request.claims || {});
    const state = request.status === 'done' ? 'done' : helpers.length ? 'taken' : 'open';
    const text = state === 'done' ? t('allianceRequestDone') : state === 'taken' ? t('allianceTakenBy', { players: helpers.join(', ') }) : t('allianceNobody');
    const embed = { ...first, author: { name: `${REQUEST_MARKS[state]} ${t('allianceRequestStatusLine', { status: text })}`.slice(0, 256) }, color: REQUEST_COLORS[state] };
    return api(config, path, { method: 'PATCH', body: JSON.stringify({ embeds: [embed, ...rest], allowed_mentions: { parse: [] } }) });
  }

  async function tradeListing(listing) {
    const config = await getConfig();
    if (!ready(config)) return { ok: false, error: 'no-bot' };
    const acc = await IkaDios.discord.account();
    if (!acc) return { ok: false, error: 'no-account' };
    await IkaDios.discord.ensureLocale(acc.world);
    const built = await IkaDios.discord.tradeListingBody(listing, acc);
    if (!built) return { ok: false, error: 'empty' };
    const res = await post(config, built.body);
    if (res.ok && built.request) await IkaDios.discord.rememberRequest(acc, { ...built.request, messageId: res.body?.id });
    return res.ok ? { ok: true } : res;
  }

  // ---------- Member status ----------

  const STATUS_ALARM = 'ikadios-alliance-status';
  const DEFAULT_STATUS_HOURS = 2;

  function statusOf(snapshot) {
    const cities = Object.values(snapshot.cities || {});
    const sum = (key) => cities.reduce((a, c) => a + Object.values(c[key] || {}).reduce((x, n) => x + (Number(n) || 0), 0), 0);
    return {
      cities: cities.length,
      freeShips: snapshot.global?.freeTransporters ?? null,
      maxShips: snapshot.global?.maxTransporters ?? null,
      units: sum('units'),
      warships: sum('ships'),
      hostile: snapshot.military?.hostileCount || 0,
      gold: snapshot.global?.gold != null ? Math.round(snapshot.global.gold) : null,
    };
  }

  // Posts this player's status and deletes the previous one, so the channel keeps
  // one status message per member
  async function publishStatus() {
    const config = await getConfig();
    if (!ready(config) || !config.autoStatus) return { ok: false, error: 'off' };
    const acc = await IkaDios.discord.account();
    if (!acc) return { ok: false, error: 'no-account' };
    await IkaDios.discord.ensureLocale(acc.world);
    const status = statusOf(acc.snapshot);
    const t = IkaDios.i18n.t;
    const res = await postItem('status', status, t('allianceStatusTitle', { player: IkaDios.discord.playerLabel(acc.snapshot), ships: status.freeShips ?? '-', units: status.units, hostile: status.hostile }));
    if (!res.ok) return res;
    const state = await getState();
    if (state.statusMessageId) await api(config, `/channels/${config.channelId}/messages/${state.statusMessageId}`, { method: 'DELETE' }).catch(() => null);
    await setState({ statusMessageId: res.messageId, statusAt: Date.now() });
    return { ok: true };
  }

  async function scheduleStatus() {
    const config = await getConfig();
    await chrome.alarms.clear(STATUS_ALARM);
    if (!ready(config) || !config.autoStatus) return;
    const hours = Math.min(24, Math.max(1, Number(config.statusHours) || DEFAULT_STATUS_HOURS));
    chrome.alarms.create(STATUS_ALARM, { delayInMinutes: 1, periodInMinutes: hours * 60 });
  }

  // ---------- Schedule ----------

  async function schedule() {
    const config = await getConfig();
    await chrome.alarms.clear(ALARM);
    if (!ready(config)) return;
    const minutes = Math.max(MIN_POLL_MIN, Number(config.pollMinutes) || DEFAULT_POLL_MIN);
    chrome.alarms.create(ALARM, { delayInMinutes: 0.5, periodInMinutes: minutes });
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) poll().catch((err) => warn('alliance poll failed', err));
    if (alarm.name === STATUS_ALARM) publishStatus().catch((err) => warn('alliance status failed', err));
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    const before = changes[KEY].oldValue || {};
    const after = changes[KEY].newValue || {};
    // Another channel starts from its latest messages
    if (before.channelId !== after.channelId) chrome.storage.local.remove(STATE_KEY);
    schedule();
    scheduleStatus();
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return undefined;
    const handlers = {
      'ikadios:allianceShare': () => share(msg.share),
      'ikadios:allianceTest': () => test(),
      'ikadios:alliancePoll': () => poll(),
      'ikadios:allianceItem': () => postItem(msg.kind, msg.data, msg.title),
      'ikadios:openOptions': async () => {
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      },
      'ikadios:allianceTradeListing': () => tradeListing(msg.listing),
      'ikadios:alliancePublishStatus': () => publishStatus(),
      'ikadios:allianceStatus': async () => ({ ok: true, config: { ...(await getConfig()), token: undefined }, ready: ready(await getConfig()), state: await getState() }),
    };
    const fn = handlers[msg?.type];
    if (!fn) return undefined;
    fn()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  });

  async function init() {
    await installUserAgentRule();
    if (!(await chrome.alarms.get(ALARM))) await schedule();
    if (!(await chrome.alarms.get(STATUS_ALARM))) await scheduleStatus();
  }

  IkaDios.alliance = { init, poll, share, test, schedule, ready, postItem, publishStatus, statusOf };
})(self);

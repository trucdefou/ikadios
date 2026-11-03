// Discord webhooks (service worker). Sends alliance-facing messages as embeds:
//  - attack alerts, automatically, when the military advisor turns to "alert"
//  - account summary, every N hours (alarm) and on demand from the overlay
//  - test messages from the options page
// Webhook URLs stay in chrome.storage.local. Each webhook has its own queue that
// honours Discord's rate limits (429 + retry_after).
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { warn } = IkaDios.util;
  const i18n = IkaDios.i18n;

  const KEY_DISCORD = 'discord';
  const KEY_LAST_ACCOUNT = 'lastAccount';
  const ALARM_SUMMARY = 'ikadios-discord-summary';
  const ATTACK_COOLDOWN_MS = 10 * 60 * 1000;
  const MAX_RETRIES = 3;

  const COLORS = { attack: 0xd0342c, summary: 0xd9a441, test: 0x4f8a3c };
  // Longest link placed in a message; longer map links fall back to files / pasting
  const MAX_LINK_IN_MESSAGE = 3800;
  const RESOURCE_ORDER = ['wood', 'wine', 'marble', 'glass', 'sulfur'];

  const DEFAULTS = { webhooks: [], summaryHours: 6, mentionOnAttack: true };

  const events = IkaDios.discordEvents;

  async function getConfig() {
    const stored = (await chrome.storage.local.get(KEY_DISCORD))[KEY_DISCORD] || {};
    const config = { ...DEFAULTS, ...stored };
    return { ...config, webhooks: config.webhooks.map(events.normalize) };
  }

  const isValidUrl = IkaDios.util.isDiscordWebhook;

  // ---------- Sending ----------

  const queues = new Map();

  function enqueue(url, body) {
    const previous = queues.get(url) || Promise.resolve();
    const next = previous.then(() => post(url, body)).catch((err) => ({ ok: false, error: String(err) }));
    queues.set(url, next);
    return next;
  }

  // body.files: [{name, blob}] are sent as multipart attachments (payload_json + files[n])
  function requestInit(body) {
    const { files, ...payload } = body;
    if (!files?.length) {
      return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
    }
    const form = new FormData();
    form.append('payload_json', JSON.stringify(payload));
    files.forEach((f, i) => form.append(`files[${i}]`, f.blob, f.name));
    return { method: 'POST', body: form };
  }

  async function post(url, body, attempt = 0) {
    const res = await fetch(`${url}?wait=true`, requestInit(body));
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const data = await res.json().catch(() => ({}));
      const waitMs = Math.ceil((Number(data.retry_after) || 1) * 1000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return post(url, body, attempt + 1);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      warn('discord webhook failed', res.status, text.slice(0, 500));
      // Discord explains rejections in JSON ({message, errors}); pass it on to the UI
      let detail = '';
      try {
        const body = JSON.parse(text);
        const first = JSON.stringify(body.errors || {}).match(/"message":"([^"]+)"/)?.[1];
        detail = [body.message, first].filter(Boolean).join(': ');
      } catch {
        detail = text.slice(0, 120);
      }
      return { ok: false, error: `HTTP ${res.status}${detail ? ` - ${detail}` : ''}` };
    }
    return { ok: true };
  }

  // Sends to every enabled webhook subscribed to `event` (or to one webhook by id).
  // `build(webhook)` returns the body for that webhook after its filters, or null
  // when nothing is left for it (e.g. none of its cities is involved).
  async function dispatch(event, build, { webhookId = null } = {}) {
    const config = await getConfig();
    const targets = config.webhooks.filter(
      (w) => w.enabled !== false && isValidUrl(w.url) && (webhookId ? w.id === webhookId : w.events?.[event])
    );
    if (!targets.length) return { ok: false, error: 'no-webhook' };
    const jobs = targets.map((w) => ({ w, body: typeof build === 'function' ? build(w) : build })).filter((j) => j.body);
    if (!jobs.length) return { ok: false, error: 'filtered' };
    const results = await Promise.all(jobs.map((j) => enqueue(j.w.url.trim(), j.body)));
    const failed = results.find((r) => !r.ok);
    return { ok: !failed, sent: results.filter((r) => r.ok).length, total: jobs.length, error: failed?.error };
  }

  // ---------- Messages ----------

  async function account() {
    const last = (await chrome.storage.local.get(KEY_LAST_ACCOUNT))[KEY_LAST_ACCOUNT];
    if (!last?.world) return null;
    const key = `snap:${last.world}:${last.avatarId ?? 'unknown'}`;
    const snapshot = IkaDios.schema.migrate((await chrome.storage.local.get(key))[key]);
    return snapshot ? { world: last.world, snapshot } : null;
  }

  // Messages use the extension language (setting, else the game server's language).
  // init() registers a settings listener, so it runs once per worker lifetime.
  let localeReady = null;
  function ensureLocale(world) {
    if (!localeReady) localeReady = i18n.init({ gameLang: IkaDios.util.parseGameHost(`${world}.x`).lang });
    return localeReady;
  }

  // Player name as shown in the game; the numeric id is never sent
  function playerLabel(snapshot) {
    return snapshot.account?.playerName || i18n.t('discordUnknownPlayer');
  }

  const short = (n) => (n == null ? '-' : i18n.formatNumber(n, { notation: 'compact', maximumFractionDigits: 1 }));

  function footer(world, snapshot) {
    const server = snapshot?.account?.serverName;
    return { text: `IkaDios - ${server ? `${server} (${world})` : world}` };
  }

  // "29/10/26 21:23 (in 2h 15m)": arrival date/time and the time left when sent
  function arrivalText(ms) {
    const left = (ms - Date.now()) / 1000;
    return `${i18n.formatTime(ms)} (${left > 0 ? i18n.t('arrivalIn', { time: i18n.formatDuration(left) }) : i18n.t('done')})`;
  }

  function hostileMovements(snapshot) {
    return (snapshot.military?.movements || []).filter((m) => m.hostile && (!m.arrivesAt || m.arrivesAt > Date.now()));
  }

  function attackBody(world, snapshot, mention, webhook) {
    const all = hostileMovements(snapshot);
    // With movement details the channel's city filter applies
    const moves = webhook ? all.filter((m) => !m.target?.cityId || events.wantsCity(webhook, m.target.cityId)) : all;
    if (all.length && !moves.length) return null;
    const fields = moves.slice(0, 20).map((m) => ({
      name: i18n.t('discordAttackField', { city: m.target?.name || '?', attacker: m.origin?.player || '?', from: m.origin?.name || '?' }).slice(0, 256),
      value: [
        m.text || m.mission,
        m.units ? i18n.t('militaryUnitsN', { n: m.units }) : null,
        m.ships ? i18n.t('militaryShipsN', { n: m.ships }) : null,
        m.arrivesAt ? `${i18n.t('arrival')}: ${arrivalText(m.arrivesAt)}` : null,
      ]
        .filter(Boolean)
        .join(' | ')
        .slice(0, 1024),
    }));
    return {
      username: 'IkaDios',
      content: mention ? '@here' : undefined,
      allowed_mentions: { parse: mention ? ['everyone'] : [] },
      embeds: [
        {
          title: i18n.t('discordAttackTitle'),
          description: i18n.t('discordAttackBody', { player: playerLabel(snapshot), world }),
          color: COLORS.attack,
          fields: fields.length ? fields : undefined,
          timestamp: new Date().toISOString(),
          footer: footer(world, snapshot),
        },
      ],
    };
  }

  function summaryBody(world, snapshot, webhook) {
    const summary = IkaDios.facets.summary(snapshot);
    const sections = webhook?.summarySections || {};
    const cities = summary.cities.filter((c) => !webhook || events.wantsCity(webhook, c.id));
    if (!cities.length) return null;
    const totals = {};
    for (const city of cities) {
      for (const r of RESOURCE_ORDER) totals[r] = (totals[r] || 0) + (city.resources[r].amount || 0);
    }
    const resourceLine = (res) =>
      RESOURCE_ORDER.map((r) => `${i18n.t(`resourceShort_${r}`)} ${short(res[r])}`).join(' | ');

    const g = summary.global;
    const fields = [];
    if (sections.overview !== false) {
      fields.push(
        { name: i18n.t('gold'), value: short(g.gold), inline: true },
        {
          name: i18n.t('transporters'),
          value: g.maxTransporters != null ? `${g.freeTransporters} / ${g.maxTransporters}` : '-',
          inline: true,
        }
      );
    }
    if (sections.totals !== false) fields.push({ name: i18n.t('discordTotals'), value: resourceLine(totals) });
    const perCity = ['cityResources', 'wine', 'construction'].some((s) => sections[s] !== false);
    if (perCity) {
      // Discord allows 25 fields per embed
      for (const city of cities.slice(0, 25 - fields.length)) {
        const lines = [
          sections.cityResources !== false
            ? resourceLine(Object.fromEntries(RESOURCE_ORDER.map((r) => [r, city.resources[r].amount])))
            : null,
          sections.wine !== false && city.wineHours != null
            ? `${i18n.t('wineLeft')}: ${i18n.formatDuration(city.wineHours * 3600)}`
            : null,
          sections.construction !== false && city.construction
            ? `${i18n.t('construction')}: ${i18n.buildingName(city.construction.type)}`
            : null,
        ].filter(Boolean);
        if (lines.length) fields.push({ name: city.name || city.id, value: lines.join('\n').slice(0, 1024) });
      }
    }
    if (!fields.length) return null;
    return {
      username: 'IkaDios',
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: i18n.t('discordSummaryTitle', { player: playerLabel(snapshot) }),
          color: COLORS.summary,
          fields,
          timestamp: new Date().toISOString(),
          footer: footer(world, snapshot),
        },
      ],
    };
  }

  // A painted map layer, grouped by label: "objetivo: [12:34], [12:35]"
  async function sendMapLayer(layer) {
    const acc = await account();
    if (!acc) return { ok: false, error: 'no-account' };
    await ensureLocale(acc.world);
    const groups = {};
    for (const [coord, mark] of Object.entries(layer?.marks || {})) {
      if (mark.expiresAt && mark.expiresAt <= Date.now()) continue;
      const label = mark.label || i18n.t('discordLayerNoLabel');
      (groups[label] = groups[label] || []).push({ coord, expiresAt: mark.expiresAt });
    }
    const fields = Object.entries(groups)
      .slice(0, 25)
      .map(([label, list]) => {
        const soonest = list.map((m) => m.expiresAt).filter(Boolean).sort((a, b) => a - b)[0];
        const coords = list.map((m) => `[${m.coord}]`).join(', ');
        return {
          name: label.slice(0, 256),
          value: `${coords}${soonest ? `\n${i18n.t('layerExpires', { when: `<t:${Math.floor(soonest / 1000)}:R>` })}` : ''}`.slice(0, 1024),
        };
      });
    if (!fields.length) return { ok: false, error: 'empty' };
    // Link that opens the IkaDios map and offers to import this layer
    const link = await IkaDios.mapShare.buildLink(acc.world, [{ name: layer.name, marks: layer.marks }], playerLabel(acc.snapshot));
    const description = [
      i18n.t('discordLayerBody', { player: playerLabel(acc.snapshot) }),
      link.length <= MAX_LINK_IN_MESSAGE ? `[${i18n.t('mapShareImportLink')}](${link})` : i18n.t('discordLayerPasteHint'),
    ].join('\n');
    return dispatch('mapLayer', {
      username: 'IkaDios',
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: i18n.t('discordLayerTitle', { name: String(layer.name || '').slice(0, 200) }),
          url: link.length <= 2000 ? link : undefined,
          description,
          color: COLORS.summary,
          fields,
          timestamp: new Date().toISOString(),
          footer: footer(acc.world, acc.snapshot),
        },
      ],
    });
  }

  // Alliance trade request or offer, written in the Trade tab:
  // { kind: 'need' | 'offer', cityId, items: [{resource, amount}], exchange, note }
  async function sendTradeListing(listing) {
    const acc = await account();
    if (!acc) return { ok: false, error: 'no-account' };
    await ensureLocale(acc.world);
    const built = await tradeListingBody(listing, acc);
    if (!built) return { ok: false, error: 'empty' };
    // A channel filtered to other cities does not get this listing
    const res = await dispatch('tradeListing', (webhook) => (listing.cityId && !events.wantsCity(webhook, listing.cityId) ? null : built.body));
    if (res.ok && built.request) await rememberRequest(acc, built.request);
    return res;
  }

  // The requester keeps their own request, to see who takes it
  async function rememberRequest(acc, request) {
    await IkaDios.intelApply.apply({ kind: 'request', from: playerLabel(acc.snapshot), at: Date.now(), data: request }, { world: acc.world, updateSnapshot: async () => {} });
  }

  // Message body of a listing, shared by the webhooks and the alliance bot. A
  // request ('need') carries the delivery link and an IkaDios link that adds it to
  // the alliance requests (with "I will send it").
  async function tradeListingBody(listing, acc) {
    const items = (listing?.items || []).filter((i) => i.resource && Number(i.amount) > 0).slice(0, 5);
    if (!items.length) return null;
    const city = acc.snapshot.cities?.[listing.cityId];
    const coords = city?.coords ? ` [${city.coords.x}:${city.coords.y}]` : '';
    const resourceList = items.map((i) => `${i18n.t(`resource_${i.resource}`)}: **${i18n.formatNumber(Number(i.amount))}**`).join('\n');
    const deliverUrl = listing.kind === 'need' && city ? IkaDios.tradeLink.build(acc.world, {
      to: String(listing.cityId),
      toName: city.name,
      coords: city.coords || null,
      player: playerLabel(acc.snapshot),
      items,
      note: listing.note || '',
    }) : null;
    const fields = [
      { name: i18n.t(listing.kind === 'offer' ? 'tradeListingOffers' : 'tradeListingNeeds'), value: resourceList.slice(0, 1024) },
      city ? { name: i18n.t(listing.kind === 'offer' ? 'tradeListingFrom' : 'tradeListingDeliverTo'), value: `${city.name}${coords}`.slice(0, 1024), inline: true } : null,
      listing.exchange ? { name: i18n.t('tradeListingExchange'), value: String(listing.exchange).slice(0, 1024), inline: true } : null,
      deliverUrl ? { name: i18n.t('tradeListingSendField'), value: `[${i18n.t('tradeListingSendLink')}](${deliverUrl})\n${i18n.t('tradeListingSendHint')}`.slice(0, 1024) } : null,
    ].filter(Boolean);
    const body = {
      username: 'IkaDios',
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: i18n.t(listing.kind === 'offer' ? 'tradeListingTitleOffer' : 'tradeListingTitleNeed', { player: playerLabel(acc.snapshot) }),
          url: deliverUrl || undefined,
          // The player's own message goes right under the title
          description: listing.note ? String(listing.note).slice(0, 2000) : undefined,
          color: listing.kind === 'offer' ? COLORS.test : COLORS.summary,
          fields,
          timestamp: new Date().toISOString(),
          footer: footer(acc.world, acc.snapshot),
        },
      ],
    };
    let request = null;
    if (listing.kind === 'need' && city) {
      request = {
        id: `req_${Date.now().toString(36)}`,
        cityId: String(listing.cityId),
        city: city.name,
        x: city.coords?.x,
        y: city.coords?.y,
        items: items.map((i) => ({ resource: i.resource, amount: Math.round(Number(i.amount)) })),
        note: String(listing.note || '').slice(0, 300),
      };
      const link = await IkaDios.intelLink.build(acc.world, 'request', request, playerLabel(acc.snapshot)).catch(() => null);
      if (link) body.embeds[0].fields.push({ name: i18n.t('allianceRequestField'), value: `[${i18n.t('allianceRequestLink')}](${link})`.slice(0, 1024) });
      if (!link) request = null;
    }
    return { body, request };
  }

  // Rows shared from an overlay table (Military, Transport): {title, fields: [{name, value}]}
  // Manual shares: fields (one per selected row) and optional long texts
  // (`reports`: [{title, text}], e.g. battle reports), each sent as its own embed
  // with the text in a code block so the game's column layout survives. Discord
  // allows 6000 characters of embeds per message, so long texts go one per message.
  const SHARE_TEXT_MAX = 3900;
  // Only IkaDios links to the game are put in shared messages
  const isShareLink = (url) => /^https:\/\/s\d+-[a-z]{2,3}\.ikariam\.gameforge\.com\/index\.php#ikadios-(?:share|map)=[A-Za-z0-9_-]+$/.test(String(url || ''));

  // Message bodies for a manual share, shared by the webhooks and the alliance bot
  // (src/background/alliance.js): an embed with the fields and the import links,
  // then one embed per long text (battle report) with its own link
  function shareBodies(share, acc) {
    const fields = (share?.fields || [])
      .slice(0, 25)
      .map((f) => ({ name: String(f.name || '-').slice(0, 256), value: String(f.value || '-').slice(0, 1024) }));
    const reports = (share?.reports || []).slice(0, 10).filter((r) => r && r.text);
    // Import links as markdown links, as many as fit in an embed description
    const linkLines = [];
    let room = 4000;
    for (const l of share?.links || []) {
      const line = `[${String(l.label || 'IkaDios').replace(/[[\]]/g, '').slice(0, 80)}](${l.url})`;
      if (!isShareLink(l.url) || line.length > room) continue;
      linkLines.push(line);
      room -= line.length + 1;
    }
    const base = { username: 'IkaDios', allowed_mentions: { parse: [] } };
    const bodies = [];
    if (fields.length || (!reports.length && linkLines.length)) {
      bodies.push({
        ...base,
        embeds: [
          {
            title: String(share.title || '').slice(0, 256),
            color: COLORS.summary,
            description: linkLines.join('\n') || undefined,
            fields,
            timestamp: new Date().toISOString(),
            footer: footer(acc.world, acc.snapshot),
          },
        ],
      });
    }
    for (const r of reports) {
      // Import links: one, or several when a long battle's rounds are split
      const links = (Array.isArray(r.links) ? r.links : r.link ? [{ url: r.link, label: r.linkLabel }] : [])
        .filter((l) => isShareLink(l?.url))
        .map((l) => `[${String(l.label || 'IkaDios').replace(/[[\]]/g, '').slice(0, 80)}](${l.url})`);
      // A code block keeps the report's dotted columns aligned; a single short
      // import link goes below it, otherwise each link gets its own embed
      const inline = links.length === 1 && links[0].length <= 1200 ? `\n${links[0]}` : '';
      const text = String(r.text).replace(/`{3}/g, "'''").slice(0, Math.max(200, Math.min(SHARE_TEXT_MAX, 4080 - inline.length)));
      const description = `${'```'}\n${text}\n${'```'}${inline}`;
      const embeds = [
        {
          title: String(r.title || share.title || '').slice(0, 256),
          color: COLORS.summary,
          description,
          timestamp: new Date().toISOString(),
          footer: footer(acc.world, acc.snapshot),
        },
        ...(inline ? [] : links.filter((l) => l.length <= 4096).map((l) => ({ color: COLORS.summary, description: l }))),
      ];
      bodies.push(...packEmbeds(embeds).map((group) => ({ ...base, embeds: group })));
    }
    return bodies;
  }

  // Embeds grouped into messages within Discord's limits (10 embeds and 6000
  // characters per message), in order
  const EMBED_CHARS_MAX = 5800;
  function packEmbeds(embeds) {
    const size = (e) => (e.title || '').length + (e.description || '').length + (e.footer?.text || '').length;
    const groups = [];
    let group = [];
    let chars = 0;
    for (const e of embeds) {
      if (group.length && (group.length >= 10 || chars + size(e) > EMBED_CHARS_MAX)) {
        groups.push(group);
        group = [];
        chars = 0;
      }
      group.push(e);
      chars += size(e);
    }
    if (group.length) groups.push(group);
    return groups;
  }

  async function sendShare(share) {
    const acc = await account();
    if (!acc) return { ok: false, error: 'no-account' };
    await ensureLocale(acc.world);
    const bodies = shareBodies(share, acc);
    if (!bodies.length) return { ok: false, error: 'empty' };
    let result = null;
    for (const body of bodies) {
      result = await dispatch('manual', body);
      if (!result?.ok) return result;
    }
    return result;
  }


  // Shared map: image of the map view plus a link that offers to import the visible
  // layers. A link too long for a message is replaced by the layers JSON file.
  async function sendMapShare({ imageDataUrl, link, layers, layersFile }) {
    const acc = await account();
    if (!acc) return { ok: false, error: 'no-account' };
    await ensureLocale(acc.world);
    const image = imageDataUrl ? await (await fetch(imageDataUrl)).blob() : null;
    const linkFits = link && link.length <= MAX_LINK_IN_MESSAGE;
    const summary = (layers || []).map((l) => `- ${String(l.name).slice(0, 60)}: ${i18n.t('layerMarks', { n: l.count })}`).join('\n');
    const description = [
      summary,
      linkFits ? `[${i18n.t('mapShareImportLink')}](${link})` : i18n.t('mapShareFileNote'),
    ]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 4000);
    const files = [];
    if (image) files.push({ name: 'ikadios-map.png', blob: image });
    if (!linkFits && layersFile) files.push({ name: 'ikadios-layers.json', blob: new Blob([JSON.stringify(layersFile)], { type: 'application/json' }) });
    return dispatch('mapLayer', {
      username: 'IkaDios',
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: i18n.t('mapShareTitle', { player: playerLabel(acc.snapshot) }),
          description,
          color: COLORS.summary,
          image: image ? { url: 'attachment://ikadios-map.png' } : undefined,
          timestamp: new Date().toISOString(),
          footer: footer(acc.world, acc.snapshot),
        },
      ],
      files,
    });
  }

  async function sendSummary({ webhookId = null, event = 'summary' } = {}) {
    const acc = await account();
    if (!acc) return { ok: false, error: 'no-account' };
    await ensureLocale(acc.world);
    i18n.setGameBuildingNames(acc.snapshot.buildingNames);
    return dispatch(event, (webhook) => summaryBody(acc.world, acc.snapshot, webhook), { webhookId });
  }

  async function sendTest(webhookId) {
    const acc = await account();
    await ensureLocale(acc?.world || 's1-en');
    return dispatch(
      'test',
      {
        username: 'IkaDios',
        allowed_mentions: { parse: [] },
        embeds: [{ title: i18n.t('discordTestTitle'), description: i18n.t('discordTestBody'), color: COLORS.test, footer: footer(acc?.world || '-', acc?.snapshot) }],
      },
      { webhookId }
    );
  }

  // ---------- Automatic triggers ----------

  const lastAttackSent = new Map();

  // Fires on every snapshot write (game tab or background refresh)
  // Hostile movement ids and the advisor alert flag of a snapshot
  function attackSignature(snap) {
    const ids = (snap?.military?.movements || []).filter((m) => m.hostile).map((m) => m.id).sort();
    return { alert: !!snap?.advisorState?.military?.alert, ids };
  }

  // Fires on every snapshot write (game tab or background refresh): reports a new
  // hostile movement, or the advisor alert turning on
  async function onSnapshotChange(key, oldValue, newValue) {
    const before = attackSignature(oldValue);
    const after = attackSignature(newValue);
    const newMove = after.ids.some((id) => !before.ids.includes(id));
    if (!newMove && !(after.alert && !before.alert)) return;
    const world = newValue.account?.world || key.split(':')[1];
    // Cooldown per set of hostile movements: a new attack is always reported
    const cooldownKey = `${world}:${after.ids.join(',')}`;
    const last = lastAttackSent.get(cooldownKey) || 0;
    if (Date.now() - last < ATTACK_COOLDOWN_MS) return;
    lastAttackSent.set(cooldownKey, Date.now());
    const config = await getConfig();
    await ensureLocale(world);
    const snapshot = IkaDios.schema.migrate(newValue);
    await dispatch('attack', (webhook) => attackBody(world, snapshot, config.mentionOnAttack, webhook));
  }

  async function scheduleSummary() {
    const config = await getConfig();
    await chrome.alarms.clear(ALARM_SUMMARY);
    const subscribed = config.webhooks.some((w) => w.enabled !== false && w.events?.summary && isValidUrl(w.url));
    const hours = Math.max(1, Number(config.summaryHours) || DEFAULTS.summaryHours);
    if (subscribed) chrome.alarms.create(ALARM_SUMMARY, { delayInMinutes: hours * 60, periodInMinutes: hours * 60 });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, change] of Object.entries(changes)) {
      if (key.startsWith('snap:')) onSnapshotChange(key, change.oldValue, change.newValue).catch((err) => warn('discord attack', err));
    }
    if (changes[KEY_DISCORD]) scheduleSummary();
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_SUMMARY) sendSummary().catch((err) => warn('discord summary', err));
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'ikadios:discordSummary') {
      sendSummary({ event: 'manual' }).then(sendResponse);
      return true;
    }
    if (msg?.type === 'ikadios:discordTradeListing') {
      sendTradeListing(msg.listing).then(sendResponse);
      return true;
    }
    if (msg?.type === 'ikadios:discordShare') {
      sendShare(msg.share).then(sendResponse);
      return true;
    }
    if (msg?.type === 'ikadios:discordMapShare') {
      sendMapShare(msg.share || {}).then(sendResponse);
      return true;
    }
    if (msg?.type === 'ikadios:discordMapLayer') {
      sendMapLayer(msg.layer).then(sendResponse);
      return true;
    }
    if (msg?.type === 'ikadios:discordTest') {
      sendTest(msg.webhookId).then(sendResponse);
      return true;
    }
    return undefined;
  });

  async function init() {
    if (!(await chrome.alarms.get(ALARM_SUMMARY))) await scheduleSummary();
  }

  IkaDios.discord = { init, isValidUrl, sendSummary, sendTest, dispatch, ensureLocale, shareBodies, account, isShareLink, tradeListingBody, rememberRequest, playerLabel };
})(self);

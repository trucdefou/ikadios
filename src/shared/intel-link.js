// Shared intelligence links: one format for everything a player can pass to the
// alliance (battle reports, spy reports, player notes, attack plans). The link
// is the game URL with a fragment `#ikadios-share=<deflate base64url JSON>`, so it
// travels in Discord / WhatsApp messages (option 1, opened by hand) and is also
// what the alliance bot channel carries (option 2, read automatically).
// Links are untrusted input: decode() keeps only well-formed, bounded values.
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});

  const HASH_KEY = 'ikadios-share';
  const VERSION = 1;
  const MAX_ENCODED = 12000;
  // battle, spy, player, plan: shared items; request, claim, confirm, status:
  // alliance coordination (resource requests and who sends them, plan
  // confirmations, member status), mostly carried by the alliance bot channel
  const KINDS = ['battle', 'spy', 'player', 'plan', 'request', 'claim', 'confirm', 'status'];
  const RESOURCES = ['wood', 'wine', 'marble', 'glass', 'sulfur'];
  const CLAIM_STATES = ['claim', 'cancel', 'done'];
  const CONFIRM_STATES = ['going', 'cant'];
  const TAGS = ['', 'ally', 'friend', 'neutral', 'target', 'enemy', 'noTouch'];

  const text = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').slice(0, max);
  const int = (v, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null;
  };
  const coord = (v) => int(v, 0, 100);

  // Per kind: keep only the expected fields, cut to size
  const CLEAN = {
    // text: the game's converter text; rounds (optional): detailed rounds
    // (src/shared/battle-rounds.js), possibly a part of them (long battles are
    // split over several links, each with the same text)
    battle(d) {
      const t = text(d?.text, 8000);
      if (t.length <= 20) return null;
      const rounds = IkaDios.battleRounds?.clean(d?.rounds);
      return rounds ? { text: t, rounds } : { text: t };
    },
    spy(d) {
      const r = d?.report;
      if (!r || typeof r !== 'object') return null;
      const ratio = (x) => (x && int(x.lost, 0, 1e6) != null && int(x.sent, 0, 1e6) != null ? { lost: int(x.lost, 0, 1e6), sent: int(x.sent, 0, 1e6) } : null);
      return {
        report: {
          owner: text(r.owner, 40),
          city: text(r.city, 40),
          x: coord(r.x),
          y: coord(r.y),
          subject: text(r.subject, 120),
          result: text(r.result, 160),
          agents: ratio(r.agents),
          date: int(r.date, 0, 4e12),
          dateText: text(r.dateText, 30),
          lines: (Array.isArray(r.lines) ? r.lines : []).slice(0, 80).map((l) => text(l, 300)),
          cities: (Array.isArray(r.cities) ? r.cities : []).slice(0, 50).map((c) => ({ name: text(c?.name, 40), x: coord(c?.x), y: coord(c?.y) })).filter((c) => c.x != null && c.y != null),
        },
      };
    },
    player(d) {
      const name = text(d?.name, 40).trim();
      if (!name) return null;
      return { name, ally: text(d?.ally, 12), tag: TAGS.includes(d?.tag) ? d.tag : '', note: text(d?.note, 1000) };
    },
    plan(d) {
      const x = coord(d?.target?.x);
      const y = coord(d?.target?.y);
      const arriveAt = int(d?.arriveAt, 1e12, 4e12);
      if (x == null || y == null || !arriveAt) return null;
      return {
        id: text(d?.id, 30) || `plan_${arriveAt.toString(36)}`,
        title: text(d?.title, 60),
        target: { x, y, name: text(d?.target?.name, 40), player: text(d?.target?.player, 40) },
        arriveAt,
        note: text(d?.note, 300),
      };
    },
    request(d) {
      const id = text(d?.id, 30).trim();
      const items = (Array.isArray(d?.items) ? d.items : [])
        .slice(0, 5)
        .map((i) => ({ resource: i?.resource, amount: int(i?.amount, 1, 1e7) }))
        .filter((i) => RESOURCES.includes(i.resource) && i.amount);
      if (!id || !/^\d{1,12}$/.test(String(d?.cityId)) || !items.length) return null;
      return { id, cityId: String(d.cityId), city: text(d?.city, 40), x: coord(d?.x), y: coord(d?.y), items, note: text(d?.note, 300) };
    },
    claim(d) {
      const requestId = text(d?.requestId, 30).trim();
      return requestId && CLAIM_STATES.includes(d?.status) ? { requestId, status: d.status } : null;
    },
    confirm(d) {
      const planId = text(d?.planId, 30).trim();
      if (!planId || !CONFIRM_STATES.includes(d?.status)) return null;
      return { planId, status: d.status, city: text(d?.city, 40), leaveAt: int(d?.leaveAt, 1e12, 4e12) };
    },
    status(d) {
      const n = (v) => int(v, 0, 1e9);
      return {
        cities: n(d?.cities),
        freeShips: n(d?.freeShips),
        maxShips: n(d?.maxShips),
        units: n(d?.units),
        warships: n(d?.warships),
        hostile: n(d?.hostile),
        gold: n(d?.gold),
      };
    },
  };

  async function build(world, kind, data, from) {
    if (!KINDS.includes(kind)) throw new Error('kind');
    const clean = CLEAN[kind](data);
    if (!clean) throw new Error('data');
    const payload = { v: VERSION, k: kind, f: text(from, 40), a: Date.now(), d: clean };
    return `https://${world}.ikariam.gameforge.com/index.php#${HASH_KEY}=${await IkaDios.mapShare.encodeObject(payload)}`;
  }

  // Battle report links that each stay within maxLength: the text in every link
  // and the rounds spread over them in order. A link that cannot take even one
  // round carries the text alone. Returns [{ url, rounds: [first, last] | null }].
  async function buildBattle(world, data, from, maxLength) {
    const rounds = IkaDios.battleRounds?.clean(data?.rounds) || [];
    const links = [];
    let start = 0;
    while (start < rounds.length) {
      let best = null;
      let end = start + 1;
      // Grow the part one round at a time while the link still fits
      while (end <= rounds.length) {
        const link = await build(world, 'battle', { text: data.text, rounds: rounds.slice(start, end) }, from);
        if (link.length > maxLength) break;
        best = { link, end };
        end += 1;
      }
      if (!best) break;
      links.push({ url: best.link, rounds: [rounds[start].n, rounds[best.end - 1].n] });
      start = best.end;
    }
    if (!links.length) links.push({ url: await build(world, 'battle', { text: data.text }, from), rounds: null });
    return links;
  }

  // Returns { kind, from, at, data } or null
  async function decode(hashOrText) {
    const m = new RegExp(`${HASH_KEY}=([A-Za-z0-9_-]{1,${MAX_ENCODED}})`).exec(String(hashOrText || ''));
    if (!m) return null;
    let raw;
    try {
      raw = await IkaDios.mapShare.decodeObject(m[1]);
    } catch {
      return null;
    }
    if (!raw || raw.v !== VERSION || !KINDS.includes(raw.k)) return null;
    const data = CLEAN[raw.k](raw.d);
    if (!data) return null;
    return { kind: raw.k, from: text(raw.f, 40), at: int(raw.a, 0, 4e12) || null, data };
  }

  // Every share or map link in a message text (bot channel)
  function linksIn(message) {
    const out = [];
    const re = /https:\/\/s\d+-[a-z]{2,3}\.ikariam\.gameforge\.com\/index\.php#(?:ikadios-share|ikadios-map)=[A-Za-z0-9_-]+/g;
    for (const m of String(message || '').matchAll(re)) out.push(m[0]);
    return out;
  }

  IkaDios.intelLink = { HASH_KEY, KINDS, TAGS, RESOURCES, CLEAN, build, buildBattle, decode, linksIn };
})(typeof self !== 'undefined' ? self : window);

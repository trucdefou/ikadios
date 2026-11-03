// Battle rounds from the game's detailed war report (view
// militaryAdvisorDetailedReportView, one page per round: combatRound=1..N).
// parseHtml() reads one page into a compact round (needs DOMParser: tab or
// tests); clean() validates rounds received from other players (no DOM, also
// used by the worker through intel-link). Read from ids, classes and numbers
// only, so it works in every game language.
//
// Round: { n, of, at, att: side, def: side, events: [{ at, text, units }] }
// Side: { players: [{ name, units, lost, morale }], reserve: [[unit, count]],
//         lines: { <location>: [slot] } }
// Slot: 0 (empty) or [unit, count, lost, hp, ammo?]; unit is the number of the
// game's unit class (s303 gives 303), hp and ammo are percentages read from the
// height of the game's bars (32 px = 100 %).
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});

  const MAX_ROUNDS = 40;
  const MAX_SLOTS = 12;
  const MAX_LINES = 12;
  const MAX_PLAYERS = 12;
  const MAX_EVENTS = 12;
  const BAR_PX = 32;
  // Battle lines in the order the game draws them, front first
  const LINE_ORDER = ['main', 'flankLeft', 'flankRight', 'longRange', 'artillery', 'air', 'airfighter'];
  const SIZE_CLASSES = ['location', 'small', 'medium', 'large', 'big', 'huge'];

  const num = (text) => {
    const digits = String(text || '').replace(/[^\d]/g, '');
    return digits ? Number(digits) : 0;
  };
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const unitOf = (node) => {
    const cls = [...(node?.classList || [])].find((c) => /^s\d{3}$/.test(c));
    return cls ? Number(cls.slice(1)) : null;
  };
  const barPct = (node) => {
    const px = /height:\s*(\d+(?:\.\d+)?)px/.exec(node?.getAttribute('style') || '');
    return px ? clamp(Math.round(100 - (Number(px[1]) / BAR_PX) * 100), 0, 100) : 100;
  };
  // "30 (-1)" gives [30, 1]
  const countLost = (text) => {
    const m = /^\s*([\d.,\s ]+?)\s*\(\s*-?\s*([\d.,\s ]+)\)/.exec(String(text || ''));
    return m ? [num(m[1]), num(m[2])] : [num(text), 0];
  };
  const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();

  function slotOf(node) {
    if (node.classList.contains('empty')) return 0;
    const unit = unitOf(node);
    if (!unit) return null;
    const [count, lost] = countLost(node.querySelector('.number')?.textContent);
    const slot = [unit, count, lost, barPct(node.querySelector('.loss'))];
    const ammo = node.querySelector('.ammoLoss');
    if (ammo) slot.push(barPct(ammo));
    return slot;
  }

  function fieldOf(field) {
    const lines = {};
    for (const loc of field?.querySelectorAll('.location') || []) {
      const name = [...loc.classList].find((c) => !SIZE_CLASSES.includes(c) && /^[a-zA-Z]{2,20}$/.test(c));
      if (!name) continue;
      const slots = [...loc.querySelectorAll('.slot')].map(slotOf).filter((s) => s !== null);
      // Lines without units are left out (the viewer draws only occupied ones)
      if (slots.some(Boolean)) lines[name] = slots;
    }
    return lines;
  }

  function reserveOf(box, prefix) {
    const out = [];
    for (const li of box?.querySelectorAll(`ul[id^="${prefix}Page"] li`) || []) {
      const unit = [li, ...li.querySelectorAll('*')].map(unitOf).find(Boolean);
      if (unit) out.push([unit, num(li.textContent)]);
    }
    return out;
  }

  // Morale tables: th.atter marks the attacker's, th.deffer the defender's
  function playersOf(doc, cls) {
    const players = [];
    for (const table of doc.querySelectorAll('table.container_morale')) {
      if (!table.querySelector(`th.${cls}`)) continue;
      for (const row of table.querySelectorAll('tr')) {
        const name = row.querySelector('td.avatarName');
        if (!name) continue;
        const [units, lost] = countLost(row.querySelector('td.militarySize')?.textContent);
        players.push({ name: clean(name.textContent), units, lost, morale: num(row.querySelector('td.morale')?.textContent) });
      }
    }
    return players;
  }

  function eventsOf(doc) {
    const out = [];
    for (const box of doc.querySelectorAll('.container_events > div')) {
      const text = clean(box.querySelector('.description')?.textContent);
      if (!text) continue;
      const units = [...box.querySelectorAll('.unitlist li')].map((li) => [unitOf(li), num(li.querySelector('.amount')?.textContent)]).filter((u) => u[0]);
      out.push({ at: clean(box.querySelector('.bold')?.textContent), text, units });
    }
    return out;
  }

  // One page of the detailed report (the HTML of the view) or null
  function parseHtml(html, requested) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const view = doc.querySelector('#militaryAdvisorDetailedReportView');
    if (!view || !view.querySelector('#battlefield')) return null;
    const head = view.querySelector('.round_nav .headline_big');
    const pos = /(\d+)\s*\/\s*(\d+)/.exec(head?.textContent || '');
    const rounds = [...view.querySelectorAll('.round_nav [data-round]')].map((a) => Number(a.getAttribute('data-round')));
    const linkRounds = [...view.querySelectorAll('.round_nav a[href*="combatRound="]')].map((a) => num(/combatRound=(\d+)/.exec(a.getAttribute('href'))?.[1]));
    const cellText = head?.parentElement?.textContent || '';
    const date = /\(([^()]*\d[^()]*)\)\s*$/.exec(clean(cellText));
    return {
      n: pos ? Number(pos[1]) : Number(requested) || 1,
      of: pos ? Number(pos[2]) : Math.max(1, ...rounds, ...linkRounds),
      at: date ? date[1].trim() : '',
      att: { players: playersOf(doc, 'atter'), reserve: reserveOf(view.querySelector('#resAttacker'), 'attacker'), lines: fieldOf(view.querySelector('#fieldAttacker')) },
      def: { players: playersOf(doc, 'deffer'), reserve: reserveOf(view.querySelector('#resDefender'), 'defender'), lines: fieldOf(view.querySelector('#fieldDefender')) },
      events: eventsOf(doc),
    };
  }

  // ---------- Validation of shared rounds (untrusted input) ----------

  const int = (v, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null;
  };
  const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, max);
  const pair = (u) => (Array.isArray(u) && int(u[0], 1, 999) != null && int(u[1], 0, 1e7) != null ? [int(u[0], 1, 999), int(u[1], 0, 1e7)] : null);

  function cleanSlot(s) {
    if (s === 0) return 0;
    if (!Array.isArray(s) || int(s[0], 1, 999) == null) return null;
    const out = [int(s[0], 1, 999), int(s[1], 0, 1e7) ?? 0, int(s[2], 0, 1e7) ?? 0, int(s[3], 0, 100) ?? 100];
    if (s.length > 4 && int(s[4], 0, 100) != null) out.push(int(s[4], 0, 100));
    return out;
  }

  function cleanSide(side) {
    const lines = {};
    for (const [name, slots] of Object.entries(side?.lines && typeof side.lines === 'object' ? side.lines : {}).slice(0, MAX_LINES)) {
      if (!/^[a-zA-Z]{2,20}$/.test(name) || !Array.isArray(slots)) continue;
      const list = slots.slice(0, MAX_SLOTS).map(cleanSlot).filter((s) => s !== null);
      if (list.some(Boolean)) lines[name] = list;
    }
    return {
      players: (Array.isArray(side?.players) ? side.players : []).slice(0, MAX_PLAYERS).map((p) => ({
        name: text(p?.name, 40),
        units: int(p?.units, 0, 1e8) ?? 0,
        lost: int(p?.lost, 0, 1e8) ?? 0,
        morale: int(p?.morale, 0, 100) ?? 0,
      })),
      reserve: (Array.isArray(side?.reserve) ? side.reserve : []).slice(0, 40).map(pair).filter(Boolean),
      lines,
    };
  }

  function cleanRound(r) {
    const n = int(r?.n, 1, 999);
    if (n == null) return null;
    return {
      n,
      of: int(r.of, n, 999) ?? n,
      at: text(r.at, 30),
      att: cleanSide(r.att),
      def: cleanSide(r.def),
      events: (Array.isArray(r.events) ? r.events : []).slice(0, MAX_EVENTS).map((e) => ({
        at: text(e?.at, 30),
        text: text(e?.text, 200),
        units: (Array.isArray(e?.units) ? e.units : []).slice(0, 30).map(pair).filter(Boolean),
      })),
    };
  }

  // A list of rounds, sorted, one per number, or null when none is valid
  function cleanList(list) {
    if (!Array.isArray(list)) return null;
    const seen = new Set();
    const out = [];
    for (const r of list.slice(0, MAX_ROUNDS)) {
      const round = cleanRound(r);
      if (!round || seen.has(round.n)) continue;
      seen.add(round.n);
      out.push(round);
    }
    out.sort((a, b) => a.n - b.n);
    return out.length ? out : null;
  }

  // Lines of a side in drawing order (known lines first, then any other)
  function orderedLines(side) {
    const names = Object.keys(side?.lines || {});
    return [...LINE_ORDER.filter((n) => names.includes(n)), ...names.filter((n) => !LINE_ORDER.includes(n))].map((name) => [name, side.lines[name]]);
  }

  IkaDios.battleRounds = { parseHtml, clean: cleanList, orderedLines, MAX_ROUNDS, LINE_ORDER };
})(typeof self !== 'undefined' ? self : window);

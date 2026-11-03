// Battle reports in the game's export format ("Battle report converter", plain
// text or BBCode), parsed into a structure the overlay can draw like the game's
// own report. Language independent: the layout is read from its shape (dotted
// columns, " - " between attacker and defender, dashed separator lines), never
// from words. Unit icons come from the game's sprites (50x50 cells).
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});

  const MAX_TEXT = 20000;
  const SEPARATOR = /^-{10,}$/;
  // "Hoplite.....150(-0)" (count and losses) or "Generals.....0,00" (a value)
  const UNIT_CELL = /^(.*?)\.{2,}\s*([\d.,\s  ]+)\(\s*-?\s*([\d.,\s  ]+)\)\s*$/;
  const VALUE_CELL = /^(.*?)\.{2,}\s*(\S.*?)\s*$/;
  const EMPTY_CELL = /^\.+$/;

  // Sprite offsets of each unit (px, negative x) in the game's military and fleet
  // button sprites, read from the game's CSS (s72-es, 2026-10-31)
  const SPRITES = {
    army: {
      path: '/cdn/all/both/characters/military/buttons_sprite.png',
      x: { s301: 0, s302: 50, s303: 100, s304: 200, s305: 550, s306: 500, s307: 600, s308: 350, s309: 450, s310: 300, s311: 250, s312: 400, s313: 150, s314: 650, s315: 750, s316: 1095, s317: 800, s318: 850, s319: 900, s320: 997, s321: 949, s322: 1047, s323: 1194, s324: 1292, s325: 1342, s326: 1144, s327: 1243 },
    },
    fleet: {
      path: '/cdn/all/both/characters/fleet/buttons_sprite.png',
      x: { s210: 50, s211: 150, s212: 350, s213: 100, s214: 200, s215: 300, s216: 250, s217: 550, s218: 500, s219: 450, s220: 400, s221: 600, s222: 650, s223: 900, s224: 700, s225: 950, s226: 750, s227: 850, s228: 800, s229: 1050, s230: 1000 },
    },
  };

  function sprite(unitId) {
    for (const [kind, def] of Object.entries(SPRITES)) {
      if (unitId in def.x) return { kind, path: def.path, x: def.x[unitId] };
    }
    return null;
  }

  // BBCode export: the converter's tags removed, the text inside kept. Only known
  // tags, so alliance tags such as [ABC] in player names survive.
  const BB_TAG = /\[\/?(?:spoiler|align|b|i|u|s|font|size|color|center|quote|code|url|img)(?:=[^\]]*)?\]/gi;

  function stripBBCode(text) {
    return text.replace(BB_TAG, '');
  }

  const number = (text) => {
    const digits = String(text || '').replace(/[^\d]/g, '');
    return digits ? Number(digits) : 0;
  };

  function cell(text) {
    const t = text.trim();
    if (!t || EMPTY_CELL.test(t)) return null;
    const unit = UNIT_CELL.exec(t);
    if (unit) return { name: unit[1].replace(/\.+$/, '').trim(), count: number(unit[2]), lost: number(unit[3]) };
    const value = VALUE_CELL.exec(t);
    if (value) return { name: value[1].replace(/\.+$/, '').trim(), value: value[2].trim() };
    return null;
  }

  // "left - right": the separator is the " - " between the two dotted columns
  function splitRow(line) {
    const m = /^(.*?\S)\s+-\s+(\S.*)$/.exec(line);
    if (!m) return null;
    // Rows have dots on both sides; text with a dash inside a sentence does not
    if (!/\.{2,}/.test(m[1]) && !/\.{2,}/.test(m[2])) return null;
    return [cell(m[1]), cell(m[2])];
  }

  // Returns { title, date, attacker, defender, units: [{name, attacker, defender}],
  // stats: [{attacker, defender}], outcome: [string] } or null when the text is
  // not a battle report
  function parse(raw) {
    const text = stripBBCode(String(raw || '').slice(0, MAX_TEXT)).replace(/\r/g, '');
    const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));
    const separators = lines.map((l, i) => (SEPARATOR.test(l.trim()) ? i : -1)).filter((i) => i >= 0);
    if (separators.length < 2) return null;

    const head = lines.slice(0, separators[0]).map((l) => l.trim()).filter(Boolean);
    const vs = head.findIndex((l, i) => i > 0 && i < head.length - 1 && !/[.\d]/.test(l) && l.length <= 4);
    const dateLine = head.find((l) => /^\(.*\d.*\)$/.test(l));
    const report = {
      title: head[0] || '',
      date: dateLine ? dateLine.slice(1, -1) : '',
      attacker: vs > 0 ? head[vs - 1] : '',
      defender: vs > 0 ? head[vs + 1] : '',
      units: [],
      stats: [],
      outcome: [],
    };

    // Between separators: unit rows first, then the statistics block
    for (let s = 0; s < separators.length - 1; s += 1) {
      for (const line of lines.slice(separators[s] + 1, separators[s + 1])) {
        const row = splitRow(line);
        if (!row || (!row[0] && !row[1])) continue;
        const isUnit = (row[0] && 'count' in row[0]) || (row[1] && 'count' in row[1]);
        if (isUnit) {
          report.units.push({
            name: row[0]?.name || row[1]?.name || '',
            attacker: row[0] && 'count' in row[0] ? { count: row[0].count, lost: row[0].lost } : null,
            defender: row[1] && 'count' in row[1] ? { count: row[1].count, lost: row[1].lost } : null,
          });
        } else {
          report.stats.push({ attacker: row[0], defender: row[1] });
        }
      }
    }
    report.outcome = lines
      .slice(separators[separators.length - 1] + 1)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 30);
    return report.units.length || report.stats.length ? report : null;
  }

  IkaDios.battleReport = { parse, sprite, stripBBCode, SPRITES };
})(typeof self !== 'undefined' ? self : window);

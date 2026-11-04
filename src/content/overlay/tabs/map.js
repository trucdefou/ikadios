// Map tab: 100x100 world grid (modeled on ika-map.com) with one cell per island.
// World data comes from the ika-map.com API through the worker (cached 6 h);
// islands visited in the game add fresher city lists and names. Colors show your
// cities, your alliance, up to five searches, inactive and vacation players.
// Fleet movements are drawn where they are (src/shared/fleet-track.js), also at a
// later moment with the time slider. Persistent tab: the
// overlay keeps its DOM and only hands it new snapshots.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { el } = IkaDios.util;

  const GRID = 100;
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 12;
  const SEARCH_SLOTS = 5;
  const SEARCH_COLORS = ['#1f6fd1', '#c2185b', '#7b1fa2', '#00897b', '#ef6c00'];
  const COLORS = {
    background: '#f5e7c8',
    grid: '#e6d3ab',
    axis: '#8a6a45',
    empty: '#d3cbbb',
    occupied: '#a9cdf0',
    own: '#e0a020',
    alliance: '#4caf50',
    multi: '#e0312b',
    inactive: '#6d6d6d',
    vacation: '#2aa198',
    hover: '#542c0f',
    center: '#000000',
    moveOwn: '#1f6fd1',
    moveHostile: '#e0312b',
    moveOther: '#ef6c00',
    moveOwnTrade: '#1f6fd1',
    moveOwnTroops: '#6a1b9a',
    moveOwnAttack: '#c2185b',
    moveAllyTrade: '#00897b',
    moveAllyTroops: '#7cb342',
  };
  // Movement categories: legend order, color and line style (dash pattern)
  const MOVE_KINDS = [
    { key: 'hostile', color: 'moveHostile', dash: [], label: 'mapMoveHostile' },
    { key: 'ownAttack', color: 'moveOwnAttack', dash: [8, 3], label: 'mapMoveOwnAttack' },
    { key: 'ownTroops', color: 'moveOwnTroops', dash: [8, 3], label: 'mapMoveOwnTroops' },
    { key: 'ownTrade', color: 'moveOwnTrade', dash: [4, 3], label: 'mapMoveOwnTrade' },
    { key: 'allyTroops', color: 'moveAllyTroops', dash: [8, 3], label: 'mapMoveAllyTroops' },
    { key: 'allyTrade', color: 'moveAllyTrade', dash: [4, 3], label: 'mapMoveAllyTrade' },
    { key: 'other', color: 'moveOther', dash: [2, 3], label: 'mapMoveOther' },
  ];
  const MOVE_KIND = Object.fromEntries(MOVE_KINDS.map((k) => [k.key, k]));
  const TRADE_MISSION = /transport|trade|market/i;
  const ATTACK_MISSION = /plunder|occupy|blockade|attack|pillage/i;

  function moveKind(m) {
    if (m.hostile) return 'hostile';
    const trade = TRADE_MISSION.test(m.mission || '');
    if (m.own) return trade ? 'ownTrade' : ATTACK_MISSION.test(m.mission || '') ? 'ownAttack' : 'ownTroops';
    if (m.sameAlliance) return trade ? 'allyTrade' : 'allyTroops';
    return 'other';
  }
  const TRADEGOOD_KEY = { 1: 'wine', 2: 'marble', 3: 'glass', 4: 'sulfur' };

  // Module state survives re-renders of the tab
  const state = {
    world: null,
    loading: false,
    error: null,
    islands: [], // [{x, y, free, wonder, wood, tradegood, tradegoodLevel, cities: [...]}]
    byCoord: new Map(),
    names: {},
    fetchedAt: 0,
    zoom: 1,
    offset: { x: 0, y: 0 },
    hover: null,
    searches: Array.from({ length: SEARCH_SLOTS }, () => ({ kind: 'player', text: '' })),
    filters: { inactive: false, vacation: false, freeOnly: false, center: true },
    snapshot: null,
    paint: { on: false, color: '#e0312b', label: '', hours: 24 },
    // Time slider: minutes ahead of now that the movements are drawn at
    timeOffsetMin: 0,
    shipHits: [],
  };
  const layers = IkaDios.mapLayers;

  let refs = {};
  let helpers = null;

  // ---------- Data ----------

  async function loadWorld(force = false) {
    const world = state.snapshot?.account?.world;
    if (!world || state.loading) return;
    state.loading = true;
    state.error = null;
    draw();
    try {
      const data = await IkaDios.worldData.load(world, { force });
      state.world = world;
      state.islands = data.islands;
      state.byCoord = data.byCoord;
      state.names = data.names;
      state.fetchedAt = data.fetchedAt;
      fillSuggestions();
      refreshResults();
    } catch (err) {
      state.error = String(err.message || err);
    } finally {
      state.loading = false;
      updateStatus();
      draw();
    }
  }

  // Own player and alliance, from the snapshot plus the world data
  function identity() {
    const snap = state.snapshot;
    // ika-map may store names in another case ("dios" vs "Dios")
    const name = snap?.account?.playerName ? snap.account.playerName.toLowerCase() : null;
    const ownCoords = new Set(IkaDios.facets.ownCities(snap).filter((c) => c.coords).map((c) => `${c.coords.x}:${c.coords.y}`));
    let ally = null;
    if (name) {
      outer: for (const island of state.islands) {
        for (const c of island.cities) {
          if ((c.player || '').toLowerCase() === name) {
            ally = c.ally || null;
            break outer;
          }
        }
      }
    }
    return { name, ally, ownCoords };
  }

  function activeSearches() {
    return state.searches
      .map((s, i) => ({ ...s, text: s.text.trim().toLowerCase(), color: SEARCH_COLORS[i], index: i }))
      .filter((s) => s.text);
  }

  function matches(search, city) {
    return search.kind === 'alliance' ? (city.ally || '').toLowerCase() === search.text : (city.player || '').toLowerCase() === search.text;
  }

  // Fresher city list for an island visited in the game, if any
  function gameIsland(island) {
    const islands = state.snapshot?.islands || {};
    return Object.values(islands).find((i) => i.x === island.x && i.y === island.y) || null;
  }

  function isOwnIsland(island, me) {
    return me.ownCoords.has(`${island.x}:${island.y}`) || (me.name && island.cities.some((c) => (c.player || '').toLowerCase() === me.name));
  }

  // Members of your alliance (other than you) with a city on the island
  function alliedPlayers(island, me) {
    if (!me.ally) return [];
    const names = island.cities
      .filter((c) => c.ally === me.ally && (c.player || '').toLowerCase() !== me.name)
      .map((c) => c.player);
    return [...new Set(names)].sort();
  }

  function islandColor(island, me, searches) {
    const hits = searches.filter((s) => island.cities.some((c) => matches(s, c)));
    if (hits.length > 1) return COLORS.multi;
    if (hits.length === 1) return hits[0].color;
    if (isOwnIsland(island, me)) return COLORS.own;
    if (me.ally && island.cities.some((c) => c.ally === me.ally)) return COLORS.alliance;
    return island.cities.length ? COLORS.occupied : COLORS.empty;
  }

  function visible(island) {
    if (state.filters.freeOnly && !(island.free > 0)) return false;
    return true;
  }

  // Island coordinates by game island id (own cities, visited islands, world map names)
  function coordsOfIslandId(id) {
    if (!id) return null;
    const snap = state.snapshot;
    for (const c of IkaDios.facets.ownCities(snap)) if (String(c.islandId) === String(id) && c.coords) return c.coords;
    const visited = snap?.islands?.[id];
    if (visited?.x != null) return { x: visited.x, y: visited.y };
    for (const [coord, info] of Object.entries(state.names)) {
      if (String(info.id) === String(id)) {
        const [x, y] = coord.split(':').map(Number);
        return { x, y };
      }
    }
    return null;
  }

  // Coordinates of a movement end. The game's islandId there is not reliable (for
  // own transports the origin carries the destination's island), so the city id
  // is looked up first: own cities, then cities of islands visited in the game.
  function endpointCoords(p) {
    if (!p) return null;
    if (p.cityId) {
      const own = state.snapshot?.cities?.[p.cityId];
      if (own?.coords) return own.coords;
      for (const island of Object.values(state.snapshot?.islands || {})) {
        if (island.x != null && (island.cities || []).some((c) => String(c.id) === String(p.cityId))) return { x: island.x, y: island.y };
      }
    }
    return coordsOfIslandId(p.islandId);
  }

  // ---------- Drawing ----------

  function geometry() {
    const canvas = refs.canvas;
    const size = Math.min(canvas.width, canvas.height);
    const margin = 22;
    const cell = ((size - margin * 2) / GRID) * state.zoom;
    return { margin, cell, ox: margin + state.offset.x, oy: margin + state.offset.y };
  }

  function toScreen(g, x, y) {
    return { sx: g.ox + (x - 0.5) * g.cell, sy: g.oy + (y - 0.5) * g.cell };
  }

  function draw() {
    const canvas = refs.canvas;
    if (!canvas?.isConnected) return;
    const ctx = canvas.getContext('2d');
    const g = geometry();
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!state.islands.length) {
      ctx.fillStyle = COLORS.axis;
      ctx.font = '14px Arial';
      ctx.fillText(helpers.i18n.t(state.loading ? 'mapLoading' : state.error ? 'mapError' : 'mapEmpty'), 30, 40);
      return;
    }

    // Grid and axes every 10
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.font = '10px Arial';
    ctx.fillStyle = COLORS.axis;
    for (let v = 0; v <= GRID; v += 10) {
      const { sx } = toScreen(g, v + 0.5, 0);
      const { sy } = toScreen(g, 0, v + 0.5);
      ctx.beginPath();
      ctx.moveTo(sx, g.oy - g.cell / 2);
      ctx.lineTo(sx, g.oy + (GRID + 0.5) * g.cell);
      ctx.moveTo(g.ox - g.cell / 2, sy);
      ctx.lineTo(g.ox + (GRID + 0.5) * g.cell, sy);
      ctx.stroke();
      ctx.fillText(String(v), sx - 6, 12);
      ctx.fillText(String(v), 2, sy + 4);
    }

    const me = identity();
    const searches = activeSearches();
    const pad = g.cell > 4 ? 1 : 0;
    for (const island of state.islands) {
      if (!visible(island)) continue;
      const { sx, sy } = toScreen(g, island.x, island.y);
      if (sx < -g.cell || sy < -g.cell || sx > canvas.width || sy > canvas.height) continue;
      ctx.fillStyle = islandColor(island, me, searches);
      ctx.fillRect(sx + pad, sy + pad, g.cell - pad * 2, g.cell - pad * 2);
      // Own islands keep a gold frame even when a search colors them
      if (isOwnIsland(island, me)) {
        ctx.strokeStyle = COLORS.own;
        ctx.lineWidth = Math.max(1, g.cell / 6);
        ctx.strokeRect(sx + pad, sy + pad, g.cell - pad * 2, g.cell - pad * 2);
      }
      // Small markers for inactive / vacation players when those filters are on
      if (g.cell >= 6) {
        const mark = (color, dx) => {
          ctx.fillStyle = color;
          ctx.fillRect(sx + dx, sy + g.cell - 4, 3, 3);
        };
        if (state.filters.inactive && island.cities.some((c) => c.state.startsWith('inactive'))) mark(COLORS.inactive, 1);
        if (state.filters.vacation && island.cities.some((c) => c.state === 'vacation')) mark(COLORS.vacation, 5);
      }
    }

    drawMarks(ctx, g, me);
    updateLayerLegend();
    drawMovements(ctx, g);

    if (state.hover) {
      const { sx, sy } = toScreen(g, state.hover.x, state.hover.y);
      ctx.strokeStyle = COLORS.hover;
      ctx.lineWidth = 2;
      ctx.strokeRect(sx, sy, g.cell, g.cell);
    }

    if (state.filters.center) drawCenterCross(ctx, canvas, g);
  }

  // Small cross at the middle of the view (centerOn() puts the opened location
  // there) with the coordinates of the cell under it as an ordered pair
  function drawCenterCross(ctx, canvas, g) {
    const cx = Math.round(canvas.width / 2) + 0.5;
    const cy = Math.round(canvas.height / 2) + 0.5;
    const arm = 7;
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(cx - arm, cy);
      ctx.lineTo(cx + arm, cy);
      ctx.moveTo(cx, cy - arm);
      ctx.lineTo(cx, cy + arm);
    };
    ctx.setLineDash([]);
    // Light halo first so the cross stays visible over dark marks and routes
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 4;
    path();
    ctx.stroke();
    ctx.strokeStyle = COLORS.center;
    ctx.lineWidth = 2;
    path();
    ctx.stroke();

    // Same cell lookup as islandAt(); nothing is shown outside the world
    const x = Math.floor((cx - g.ox) / g.cell + 0.5);
    const y = Math.floor((cy - g.oy) / g.cell + 0.5);
    if (x < 0 || y < 0 || x > GRID || y > GRID) return;
    const text = `(${x}, ${y})`;
    ctx.font = 'bold 11px Arial';
    const w = ctx.measureText(text).width + 6;
    const left = cx + arm + 4;
    const top = cy - arm - 13;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillRect(left, top, w, 14);
    ctx.fillStyle = COLORS.center;
    ctx.fillText(text, left + 3, top + 11);
  }

  // Painted marks: translucent fill, solid frame, label when the cell is large
  // enough. Several marks (or owners) on one island split the cell into stripes,
  // one per color, and the label shows how many.
  function drawMarks(ctx, g, me) {
    const canvas = refs.canvas;
    const cells = new Map();
    for (const layer of layers.data.layers) {
      if (!layer.visible) continue;
      for (const [coord, mark] of Object.entries(layer.marks)) {
        if (mark.expiresAt && mark.expiresAt <= Date.now()) continue;
        const cell = cells.get(coord) || { colors: [], labels: [] };
        if (mark.parts?.length) {
          for (const part of mark.parts) {
            cell.colors.push(part.color);
            cell.labels.push(part.label);
          }
        } else {
          cell.colors.push(mark.color);
          if (mark.label) cell.labels.push(mark.label);
        }
        cells.set(coord, cell);
      }
    }
    for (const [coord, cell] of cells) {
      const [x, y] = coord.split(':').map(Number);
      const { sx, sy } = toScreen(g, x, y);
      if (sx < -g.cell || sy < -g.cell || sx > canvas.width || sy > canvas.height) continue;
      const n = cell.colors.length;
      const stripe = g.cell / n;
      ctx.globalAlpha = 0.6;
      cell.colors.forEach((color, i) => {
        ctx.fillStyle = color;
        ctx.fillRect(sx + stripe * i, sy, i === n - 1 ? g.cell - stripe * i : stripe, g.cell);
      });
      ctx.globalAlpha = 1;
      ctx.strokeStyle = n > 1 ? '#2a1505' : cell.colors[0];
      ctx.lineWidth = Math.max(1.5, g.cell / 6);
      ctx.strokeRect(sx, sy, g.cell, g.cell);
      // Corner flags: green = allies of yours live here, gold = you do
      const island = state.byCoord.get(coord);
      if (island && g.cell >= 6) {
        const flag = (color, right) => {
          const f = Math.max(4, g.cell / 3);
          ctx.fillStyle = color;
          ctx.strokeStyle = '#2a1505';
          ctx.lineWidth = 1;
          ctx.beginPath();
          if (right) {
            ctx.moveTo(sx + g.cell - f, sy);
            ctx.lineTo(sx + g.cell, sy);
            ctx.lineTo(sx + g.cell, sy + f);
          } else {
            ctx.moveTo(sx, sy);
            ctx.lineTo(sx + f, sy);
            ctx.lineTo(sx, sy + f);
          }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        };
        if (alliedPlayers(island, me).length) flag(COLORS.alliance, true);
        if (isOwnIsland(island, me)) flag(COLORS.own, false);
      }
      if (g.cell >= 18 && (cell.labels.length || n > 1)) {
        const text = n > 1 ? (cell.labels.length === n ? `${n}: ${cell.labels.join(', ')}` : `x${n}`) : cell.labels[0];
        ctx.fillStyle = '#2a1505';
        ctx.font = `bold ${Math.min(12, g.cell / 2.5)}px Arial`;
        ctx.fillText(text.slice(0, Math.floor(g.cell / 6)), sx + 2, sy + g.cell - 3);
      }
    }
  }

  // Marks for the cities of a player or of an alliance (one criterion, one color).
  // Islands where other layers coincide are striped by drawMarks().
  function marksFromWorld(kind, text, color) {
    const wanted = String(text || '').trim().toLowerCase();
    const marks = {};
    if (!wanted) return marks;
    for (const island of state.islands) {
      const hits = island.cities.filter((c) => (kind === 'alliance' ? c.ally : c.player) && (kind === 'alliance' ? c.ally : c.player).toLowerCase() === wanted);
      if (!hits.length) continue;
      marks[`${island.x}:${island.y}`] = { color, label: String(kind === 'alliance' ? hits[0].ally : hits[0].player).slice(0, 30), expiresAt: null };
    }
    return marks;
  }

  // Moment the map shows: now, or later with the time slider
  const viewTime = () => Date.now() + state.timeOffsetMin * 60000;

  function shortLeft(ms) {
    return helpers.i18n.formatDuration(Math.max(0, Math.round(ms / 1000)));
  }

  // Fleets and armies: dashed route, a marker at the current position (exact when
  // the departure was seen, estimated otherwise) and, when zoomed in, a label with
  // the time left. Attacks against you get a solid red route and a pulsing ring
  // on the target with the countdown.
  function drawMovements(ctx, g) {
    const now = Date.now();
    const at = viewTime();
    const pulse = 0.5 + 0.5 * Math.sin(now / 250);
    state.shipHits = [];
    const counts = {};
    const listed = [];
    for (const m of state.snapshot?.military?.movements || []) {
      const origin = endpointCoords(m.origin);
      const target = endpointCoords(m.target);
      if (!origin || !target) continue;
      const pos = IkaDios.fleetTrack.position(m, origin, target, at);
      const [from, to] = pos.leg === 'back' ? [target, origin] : [origin, target];
      const a = toScreen(g, from.x + 0.5, from.y + 0.5);
      const b = toScreen(g, to.x + 0.5, to.y + 0.5);
      const kind = MOVE_KIND[moveKind(m)];
      const color = COLORS[kind.color];
      const sameIsland = from.x === to.x && from.y === to.y;
      // Already arrived at the moment shown: nothing left to draw
      if (pos.phase === 'arrived') continue;
      counts[kind.key] = (counts[kind.key] || 0) + 1;
      listed.push({ m, pos, kind });

      if (!sameIsland) {
        ctx.strokeStyle = color;
        ctx.setLineDash(kind.dash);
        ctx.lineWidth = m.hostile ? 2.5 : 1.5;
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (m.hostile) {
        ctx.strokeStyle = COLORS.moveHostile;
        ctx.globalAlpha = 0.35 + 0.65 * pulse;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(b.sx, b.sy, Math.max(7, g.cell * 0.9) + pulse * 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        if (pos.end) label(ctx, b.sx, b.sy - Math.max(10, g.cell), helpers.i18n.t('mapAttackIn', { time: shortLeft(pos.end - at) }), COLORS.moveHostile, true);
      }

      const px = a.sx + (b.sx - a.sx) * pos.t;
      const py = a.sy + (b.sy - a.sy) * pos.t;
      const r = Math.max(3, Math.min(6, g.cell / 2));
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      // Hollow marker: estimated position
      ctx.strokeStyle = pos.exact ? '#2a1505' : '#ffffff';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (g.cell >= 8 && pos.end && !m.hostile) {
        const text = pos.phase === 'loading' ? helpers.i18n.t('mapShipLoadingShort') : shortLeft(pos.end - at);
        label(ctx, px + r + 3, py - r - 2, text, color, false);
      }
      state.shipHits.push({ x: px, y: py, r: r + 4, m, pos });
    }
    updateMoveCounts(counts);
    updateMoveList(listed, at);
  }

  // Number of movements drawn per category, shown in the side legend
  function updateMoveCounts(counts) {
    state.moveCounts = counts;
    for (const k of MOVE_KINDS) {
      const node = refs.moveCounts?.[k.key];
      const text = String(counts[k.key] || 0);
      if (node && node.textContent !== text) node.textContent = text;
    }
  }

  // Detail list of the movements drawn, soonest arrival first. Rebuilt only when
  // its text changes (the countdowns change every second).
  function updateMoveList(listed, at) {
    if (!refs.moveList) return;
    const { t, formatNumber } = helpers.i18n;
    const end = (p) => (p ? `${p.name}${p.player ? ` (${p.player})` : ''}` : '-');
    const rows = listed
      .slice()
      .sort((a, b) => (a.pos.end || Infinity) - (b.pos.end || Infinity))
      .map(({ m, pos, kind }) => {
        const forces = [m.ships ? t('militaryShipsN', { n: m.ships }) : null, m.units ? t('militaryUnitsN', { n: m.units }) : null].filter(Boolean).join(', ');
        const cargo = (m.cargo || []).map((c) => `${t(`resourceShort_${c.resource}`)} ${formatNumber(c.amount)}`).join(', ');
        const when = pos.phase === 'loading' ? t('mapShipLoadingShort') : pos.phase === 'atTarget' ? t('mapShipAtTarget') : pos.end ? shortLeft(pos.end - at) : '';
        return {
          id: m.id,
          color: COLORS[kind.color],
          title: m.text || m.mission || '-',
          route: t('mapShipRoute', { from: end(m.origin), to: end(m.target) }),
          detail: [forces, cargo].filter(Boolean).join(' | '),
          when,
          exact: pos.exact,
        };
      });
    state.moveRows = rows;
    const sig = JSON.stringify(rows);
    if (sig === refs.moveListSig) return;
    refs.moveListSig = sig;
    refs.moveList.replaceChildren(
      ...(rows.length
        ? rows.map((r) =>
            el('div', { class: 'map-move', style: { borderLeftColor: r.color } }, [
              el('div', { class: 'map-move-head' }, [el('strong', { text: r.title }), el('span', { class: 'map-move-when', text: r.when })]),
              el('div', { text: r.route }),
              r.detail ? el('div', { class: 'hint', text: r.detail }) : null,
            ].filter(Boolean))
          )
        : [el('span', { class: 'hint', text: t('mapMovesNone') })])
    );
  }

  // Visible layers with their color and number of islands
  function visibleLayerRows() {
    return layers.data.layers
      .filter((l) => Object.keys(l.marks).length)
      .map((l) => {
        const first = Object.values(l.marks)[0];
        return { id: l.id, name: l.name, visible: !!l.visible, color: l.source?.color || first.color, count: Object.keys(l.marks).length };
      });
  }

  function updateLayerLegend() {
    if (!refs.layerLegend) return;
    const { t } = helpers.i18n;
    const rows = visibleLayerRows();
    // Visibility changes redraw the legend with the new buttons
    const sig = JSON.stringify(rows);
    if (sig === refs.layerLegendSig) return;
    refs.layerLegendSig = sig;
    refs.layerLegend.replaceChildren(
      ...(rows.length
        ? rows.map((r) =>
            el('div', { class: 'map-side-row' }, [
              el('span', { class: 'swatch', style: { background: r.color, opacity: r.visible ? 1 : 0.3 } }),
              el('span', { class: `map-side-text ${r.visible ? '' : 'is-off'}`, text: r.name }),
              el('span', { class: 'map-side-count', text: String(r.count) }),
              IkaDios.icons.button(r.visible ? 'eye' : 'eyeOff', t(r.visible ? 'layerHide' : 'layerShow'), () => {
                const layer = layers.data.layers.find((l) => l.id === r.id);
                if (!layer) return;
                layer.visible = !layer.visible;
                layers.save().then(() => {
                  renderLayers();
                  draw();
                });
              }),
            ])
          )
        : [el('span', { class: 'hint', text: t('mapLayersNone') })])
    );
  }

  function moveLegend(t) {
    refs.moveCounts = {};
    refs.layerLegendSig = null;
    return el('aside', { class: 'map-side' }, [
      el('strong', { text: t('mapMovesTitle') }),
      ...MOVE_KINDS.map((k) =>
        el('div', { class: 'map-side-row' }, [
          el('span', { class: 'swatch', style: { background: COLORS[k.color] } }),
          el('span', { class: 'map-side-text' }, [el('span', { text: t(k.label) }), el('span', { class: 'hint', text: t(`${k.label}Hint`) })]),
          (refs.moveCounts[k.key] = el('span', { class: 'map-side-count', text: '0' })),
        ])
      ),
      el('span', { class: 'hint', text: t('mapMovesLines') }),
      el('strong', { text: t('mapLayersLegend') }),
      (refs.layerLegend = el('div', { class: 'map-moves' })),
    ]);
  }

  function movesPanel(t) {
    refs.moveListSig = null;
    return el('aside', { class: 'map-side' }, [el('strong', { text: t('mapMovesList') }), (refs.moveList = el('div', { class: 'map-moves' }))]);
  }

  function label(ctx, x, y, text, color, centered) {
    ctx.font = 'bold 11px Arial';
    const w = ctx.measureText(text).width + 6;
    const left = centered ? x - w / 2 : x;
    ctx.fillStyle = 'rgba(253, 247, 221, 0.9)';
    ctx.fillRect(left, y - 10, w, 14);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(left, y - 10, w, 14);
    ctx.fillStyle = color;
    ctx.fillText(text, left + 3, y + 1);
  }

  // Marker under the pointer (canvas pixels), if any
  function shipAt(clientX, clientY) {
    const rect = refs.canvas.getBoundingClientRect();
    const scale = refs.canvas.width / rect.width;
    const x = (clientX - rect.left) * scale;
    const y = (clientY - rect.top) * scale;
    return (state.shipHits || []).find((h) => Math.hypot(h.x - x, h.y - y) <= h.r) || null;
  }

  function shipTooltip({ m, pos }) {
    const { t, formatNumber, formatTime } = helpers.i18n;
    const at = viewTime();
    const forces = [m.ships ? t('militaryShipsN', { n: m.ships }) : null, m.units ? t('militaryUnitsN', { n: m.units }) : null].filter(Boolean).join(', ');
    const cargo = (m.cargo || []).map((c) => `${t(`resourceShort_${c.resource}`)} ${formatNumber(c.amount)}`).join(', ');
    const end = (p) => (p ? `${p.name}${p.player ? ` (${p.player})` : ''}` : '-');
    const timing =
      pos.phase === 'loading'
        ? t('mapShipLoading', { when: formatTime(pos.start) })
        : pos.phase === 'atTarget'
          ? t('mapShipAtTarget')
          : pos.end
            ? t('mapShipArrives', { when: formatTime(pos.end), left: shortLeft(pos.end - at) })
            : '';
    return [
      el('strong', { class: m.hostile ? 'warn' : '', text: m.text || m.mission || '-' }),
      el('div', { class: 'age', text: t(MOVE_KIND[moveKind(m)].label) }),
      el('div', { text: t('mapShipRoute', { from: end(m.origin), to: end(m.target) }) }),
      forces ? el('div', { text: forces }) : null,
      cargo ? el('div', { text: `${t('cargo')}: ${cargo}` }) : null,
      timing ? el('div', { text: timing }) : null,
      el('div', { class: 'age', text: t(pos.exact ? 'mapShipExact' : 'mapShipEstimated') }),
    ].filter(Boolean);
  }

  // ---------- Interaction ----------

  function islandAt(clientX, clientY) {
    const rect = refs.canvas.getBoundingClientRect();
    const scale = refs.canvas.width / rect.width;
    const g = geometry();
    const x = Math.floor(((clientX - rect.left) * scale - g.ox) / g.cell + 0.5);
    const y = Math.floor(((clientY - rect.top) * scale - g.oy) / g.cell + 0.5);
    return state.byCoord.get(`${x}:${y}`) || null;
  }

  function stateLabel(st) {
    if (!st) return '';
    return helpers.i18n.tOr(`playerState_${st}`, st);
  }

  function tooltip(island) {
    const { t, formatNumber } = helpers.i18n;
    const visited = gameIsland(island);
    const name = visited?.name || state.names[`${island.x}:${island.y}`]?.name || '';
    const wonderLevel = visited?.wonderLevel ?? state.names[`${island.x}:${island.y}`]?.wonderLevel ?? null;
    const cities = visited
      ? visited.cities.map((c) => ({ player: c.ownerName, name: c.name, level: c.level, state: c.state, ally: c.allyTag }))
      : island.cities;
    const tg = TRADEGOOD_KEY[visited?.tradegood ?? island.tradegood];
    const lines = [
      el('strong', { text: `${name ? `${name} ` : ''}[${island.x}:${island.y}]` }),
      el('div', {
        text: [
          `${t('resourceShort_wood')} ${visited?.woodLevel ?? island.wood ?? '-'}`,
          tg ? `${t(`resourceShort_${tg}`)} ${visited?.tradegoodLevel ?? island.tradegoodLevel ?? '-'}` : null,
          island.wonder ? `${t('mapWonder')} ${visited?.wonderName || t(`wonder_${island.wonder}`)}${wonderLevel ? ` ${wonderLevel}` : ''}` : null,
        ]
          .filter(Boolean)
          .join(' | '),
      }),
      el('div', { text: t('mapCities', { n: cities.length, free: island.free ?? '-' }) }),
    ];
    const me = identity();
    const allies = alliedPlayers({ cities }, me);
    if (allies.length) lines.push(el('div', { class: 'ally-line', text: t('mapAlliesHere', { names: allies.join(', ') }) }));
    if (cities.length) {
      const avg = cities.reduce((a, c) => a + (c.level || 0), 0) / cities.length;
      lines.push(el('div', { class: 'age', text: t('mapAvgLevel', { level: formatNumber(avg, { maximumFractionDigits: 1 }) }) }));
      const list = el(
        'table',
        { class: 'map-cities' },
        cities
          .slice()
          .sort((a, b) => (a.ally || '').localeCompare(b.ally || '') || (a.player || '').localeCompare(b.player || ''))
          .map((c) =>
            el('tr', { class: [c.state ? `st-${c.state}` : '', me.ally && c.ally === me.ally ? 'is-ally' : ''].join(' ').trim() }, [
              el('td', { text: c.name }),
              el('td', { text: c.player }),
              el('td', { text: c.ally ? `[${c.ally}]` : '' }),
              el('td', { class: 'num', text: String(c.level ?? '') }),
              el('td', { class: 'age', text: stateLabel(c.state) }),
            ])
          )
      );
      lines.push(list);
    }
    for (const { layer, mark } of layers.marksAt(`${island.x}:${island.y}`)) {
      lines.push(
        el('div', { class: 'map-mark' }, [
          el('span', { class: 'swatch', style: { background: mark.color } }),
          ` ${layer.name}${mark.label ? `: ${mark.label}` : ''}`,
          ...(mark.parts || []).map((p) => el('span', { class: 'map-mark' }, [el('span', { class: 'swatch', style: { background: p.color } }), ` ${p.label}`])),
          mark.expiresAt ? el('span', { class: 'age', text: ` (${t('layerExpires', { when: helpers.i18n.formatRelative(mark.expiresAt) })})` }) : null,
        ])
      );
    }
    if (visited) lines.push(el('div', { class: 'age', text: t('mapVisited', { when: helpers.i18n.formatRelative(visited.updatedAt) }) }));
    lines.push(el('div', { class: 'age', text: t('mapOpenHint') }));
    return lines;
  }

  function showTooltip(island, clientX, clientY) {
    if (!island) {
      refs.tip.hidden = true;
      return;
    }
    showTooltipContent(tooltip(island), clientX, clientY);
  }

  function showTooltipContent(nodes, clientX, clientY) {
    refs.tip.replaceChildren(...nodes);
    refs.tip.hidden = false;
    const wrap = refs.wrap.getBoundingClientRect();
    let left = clientX - wrap.left + 14;
    let top = clientY - wrap.top + 14;
    if (left + refs.tip.offsetWidth > wrap.width) left = Math.max(0, clientX - wrap.left - refs.tip.offsetWidth - 14);
    if (top + refs.tip.offsetHeight > wrap.height) top = Math.max(0, clientY - wrap.top - refs.tip.offsetHeight - 14);
    refs.tip.style.left = `${left}px`;
    refs.tip.style.top = `${top}px`;
  }

  function attachCanvasEvents(canvas) {
    let drag = null;
    let painting = null;
    const paintAt = (clientX, clientY) => {
      const island = islandAt(clientX, clientY);
      if (!island) return;
      const coord = `${island.x}:${island.y}`;
      if (painting.done.has(coord)) return;
      painting.done.add(coord);
      if (painting.erase) layers.clearMark(coord);
      else layers.setMark(coord, state.paint);
      draw();
    };
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      if (state.paint.on) {
        // The first island decides: erase if it is already marked in this layer
        const first = islandAt(e.clientX, e.clientY);
        painting = { done: new Set(), erase: !!first && layers.hasMark(`${first.x}:${first.y}`) };
        paintAt(e.clientX, e.clientY);
        return;
      }
      drag = { x: e.clientX, y: e.clientY, ox: state.offset.x, oy: state.offset.y, moved: false };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (painting) {
        paintAt(e.clientX, e.clientY);
        return;
      }
      if (drag) {
        const scale = canvas.width / canvas.getBoundingClientRect().width;
        const dx = (e.clientX - drag.x) * scale;
        const dy = (e.clientY - drag.y) * scale;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        state.offset = { x: drag.ox + dx, y: drag.oy + dy };
        refs.tip.hidden = true;
        draw();
        return;
      }
      const ship = shipAt(e.clientX, e.clientY);
      const island = ship ? null : islandAt(e.clientX, e.clientY);
      const changed = island?.x !== state.hover?.x || island?.y !== state.hover?.y;
      state.hover = island;
      if (changed) draw();
      if (ship) showTooltipContent(shipTooltip(ship), e.clientX, e.clientY);
      else showTooltip(island, e.clientX, e.clientY);
    });
    canvas.addEventListener('pointerup', (e) => {
      if (painting) {
        painting = null;
        layers.save().then(renderLayers);
        return;
      }
      drag = null;
    });
    // Double click opens the island in the game. Without a known island id the
    // page hook asks the game's world map for it (same request the map makes).
    canvas.addEventListener('dblclick', (e) => {
      if (state.paint.on) return;
      const island = islandAt(e.clientX, e.clientY);
      if (!island) return;
      const id = gameIsland(island)?.id || state.names[`${island.x}:${island.y}`]?.id;
      if (id) helpers.goToView('island', { islandId: id });
      else window.postMessage({ source: IkaDios.util.MESSAGE_SOURCE, direction: 'content', kind: 'openIslandAt', payload: { x: island.x, y: island.y } }, location.origin);
    });
    canvas.addEventListener('pointerleave', () => {
      state.hover = null;
      refs.tip.hidden = true;
      draw();
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        zoomAt(e.deltaY < 0 ? 1.25 : 0.8, e.clientX, e.clientY);
      },
      { passive: false }
    );
  }

  function zoomAt(factor, clientX, clientY) {
    const canvas = refs.canvas;
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / rect.width;
    const px = clientX != null ? (clientX - rect.left) * scale : canvas.width / 2;
    const py = clientY != null ? (clientY - rect.top) * scale : canvas.height / 2;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, state.zoom * factor));
    const ratio = next / state.zoom;
    // Keep the point under the cursor fixed
    state.offset = { x: px - 22 - (px - 22 - state.offset.x) * ratio, y: py - 22 - (py - 22 - state.offset.y) * ratio };
    state.zoom = next;
    if (state.zoom === MIN_ZOOM) state.offset = { x: 0, y: 0 };
    draw();
  }

  function centerOn(x, y) {
    const canvas = refs.canvas;
    state.zoom = Math.max(state.zoom, 4);
    const { cell } = geometry();
    // Middle of the island's cell (toScreen gives its top-left corner at x - 0.5)
    state.offset = { x: canvas.width / 2 - 22 - x * cell, y: canvas.height / 2 - 22 - y * cell };
    draw();
  }

  function resizeCanvas() {
    const canvas = refs.canvas;
    if (!canvas?.isConnected) return;
    const width = Math.max(300, Math.floor(refs.wrap.clientWidth));
    const height = Math.max(300, Math.floor(refs.wrap.clientHeight || width));
    const side = Math.min(width, height);
    if (canvas.width !== side) {
      canvas.width = side;
      canvas.height = side;
    }
    draw();
  }

  // ---------- Controls ----------

  function fillSuggestions() {
    if (!refs.players) return;
    const players = new Set();
    const allies = new Set();
    for (const island of state.islands) {
      for (const c of island.cities) {
        if (c.player) players.add(c.player);
        if (c.ally) allies.add(c.ally);
      }
    }
    refs.players.replaceChildren(...[...players].sort().map((p) => el('option', { value: p })));
    refs.allies.replaceChildren(...[...allies].sort().map((a) => el('option', { value: a })));
  }

  function updateStatus() {
    if (!refs.status) return;
    const { t, formatRelative } = helpers.i18n;
    refs.status.textContent = state.loading
      ? t('mapLoading')
      : state.error
        ? t('mapError')
        : state.fetchedAt
          ? t('mapSource', { when: formatRelative(state.fetchedAt), n: state.islands.length })
          : '';
  }

  function resultsTable() {
    const { t } = helpers.i18n;
    const searches = activeSearches();
    if (!searches.length) return el('p', { class: 'hint', text: t('mapSearchHint') });
    const rows = [];
    for (const island of state.islands) {
      for (const c of island.cities) {
        const s = searches.find((x) => matches(x, c));
        if (s) rows.push({ s, island, c });
      }
    }
    rows.sort((a, b) => a.s.index - b.s.index || a.c.player.localeCompare(b.c.player) || a.island.x - b.island.x || a.island.y - b.island.y);
    return el('table', { class: 'grid' }, [
      el('thead', {}, el('tr', {}, ['', t('mapPlayer'), t('city'), t('mapCoords'), t('mapLevel'), t('mapState')].map((h) => el('th', { text: h })))),
      el('tbody', {}, rows.map(({ s, island, c }) =>
        el('tr', {}, [
          el('td', {}, el('span', { class: 'swatch', style: { background: s.color } })),
          el('td', {}, el('button', { class: 'link', text: c.ally ? `${c.player} [${c.ally}]` : c.player, title: t('playerOpen'), onclick: () => helpers.openTab('players', { player: c.player }) })),
          el('td', { text: c.name }),
          el('td', {}, el('button', { class: 'link', text: `[${island.x}:${island.y}]`, onclick: () => centerOn(island.x, island.y) })),
          el('td', { class: 'num', text: String(c.level) }),
          el('td', { class: 'age', text: stateLabel(c.state) }),
        ])
      )),
    ]);
  }

  function refreshResults() {
    if (refs.results) refs.results.replaceChildren(resultsTable());
  }

  function render(container, snapshot, h) {
    helpers = h;
    state.snapshot = snapshot;
    const { t } = h.i18n;
    h.setExpanded(true);

    refs.players = el('datalist', { id: 'ikadios-players' });
    refs.allies = el('datalist', { id: 'ikadios-allies' });

    const searchRow = el(
      'div',
      { class: 'map-searches' },
      state.searches.map((s, i) => {
        const input = el('input', {
          type: 'text',
          value: s.text,
          placeholder: t('mapSearchPlaceholder'),
          list: s.kind === 'alliance' ? 'ikadios-allies' : 'ikadios-players',
          style: { borderColor: SEARCH_COLORS[i] },
          onchange: (e) => {
            s.text = e.target.value;
            draw();
            refreshResults();
          },
        });
        const kind = el(
          'select',
          {
            onchange: (e) => {
              s.kind = e.target.value;
              input.setAttribute('list', s.kind === 'alliance' ? 'ikadios-allies' : 'ikadios-players');
              draw();
              refreshResults();
            },
          },
          [el('option', { value: 'player', text: t('mapPlayer') }), el('option', { value: 'alliance', text: t('mapAlliance') })]
        );
        kind.value = s.kind;
        return el('span', { class: 'map-search' }, [el('span', { class: 'swatch', style: { background: SEARCH_COLORS[i] } }), kind, input]);
      })
    );

    const filter = (key) =>
      el('label', { class: 'check chip' }, [
        el('input', {
          type: 'checkbox',
          checked: state.filters[key] ? true : null,
          onchange: (e) => {
            state.filters[key] = e.target.checked;
            draw();
          },
        }),
        el('span', { text: t(`mapFilter_${key}`) }),
      ]);

    const goto = el('input', {
      type: 'text',
      placeholder: '48:17',
      size: '7',
      onchange: (e) => {
        const c = IkaDios.util.parseCoords(e.target.value);
        if (c) centerOn(c.x, c.y);
      },
    });

    refs.status = el('span', { class: 'age' });
    refs.canvas = el('canvas', { class: 'map-canvas', width: '700', height: '700' });
    refs.tip = el('div', { class: 'map-tip', hidden: true });
    refs.wrap = el('div', { class: 'map-wrap' }, [refs.canvas, refs.tip]);
    refs.mapMain = el('div', { class: 'map-main' }, [el('div', { class: 'map-grid' }, [moveLegend(t), refs.wrap, movesPanel(t)])]);
    refs.results = el('div', { class: 'map-results' });

    const legend = el('div', { class: 'map-legend' }, [
      ['own', 'mapLegendOwn'],
      ['alliance', 'mapLegendAlliance'],
      ['occupied', 'mapLegendOccupied'],
      ['empty', 'mapLegendEmpty'],
      ['multi', 'mapLegendMulti'],
    ].map(([k, label]) => el('span', {}, [el('span', { class: 'swatch', style: { background: COLORS[k] } }), t(label)])).concat(
      el('span', { class: 'hint', text: t('mapLegendFlags') }),
      el('span', { class: 'hint', text: t('mapLegendShipMarker') })
    ));

    container.append(
      refs.players,
      refs.allies,
      importPrompt(t) || '',
      searchRow,
      el('div', { class: 'map-toolbar main-tools' }, [
        el('span', { class: 'chip-group' }, [filter('inactive'), filter('vacation'), filter('freeOnly'), filter('center')]),
        el('span', { class: 'tool-sep' }),
        el('label', { class: 'check' }, [t('mapGoTo'), ' ', goto]),
        el('span', { class: 'btn-group' }, [
          el('button', { class: 'refresh', text: '-', title: t('mapZoomOut'), 'aria-label': t('mapZoomOut'), onclick: () => zoomAt(1 / 1.5) }),
          el('button', { class: 'refresh', text: '+', title: t('mapZoomIn'), 'aria-label': t('mapZoomIn'), onclick: () => zoomAt(1.5) }),
        ]),
        el('span', { class: 'tool-sep' }),
        (refs.paintBtn = el('button', {
          class: `refresh ${state.paint.on ? 'is-running' : ''}`,
          text: t('layerPaint'),
          title: t('layerPaintHint'),
          onclick: () => {
            state.paint.on = !state.paint.on;
            refs.paintBtn.classList.toggle('is-running', state.paint.on);
            refs.paintBar.hidden = !state.paint.on;
            refs.canvas.style.cursor = state.paint.on ? 'cell' : 'crosshair';
          },
        })),
        el('button', {
          class: 'refresh',
          text: t('mapShare'),
          onclick: () => {
            const open = refs.shareSlot.firstChild;
            refs.shareSlot.replaceChildren(open ? '' : sharePanel(t));
          },
        }),
        el('span', { class: 'status-text' }, [
          refs.status,
          el('button', { class: 'btn-soft', text: t('mapReload'), title: t('mapReloadHint'), onclick: () => loadWorld(true) }),
        ]),
      ]),
      (refs.timeBar = timeBar(t)),
      (refs.shareSlot = el('div')),
      (refs.paintBar = paintBar(t)),
      refs.mapMain,
      legend,
      (refs.layers = el('div', { class: 'map-layers' })),
      refs.results
    );
    // Layers imported in the background (alliance bot) are drawn when they arrive
    if (!refs.layersWatch) {
      refs.layersWatch = true;
      layers.onChange(() => {
        if (!refs.canvas?.isConnected) return;
        renderLayers();
        draw();
      });
    }
    layers.load(snapshot?.account?.world).then(() => {
      renderLayers();
      draw();
    });

    attachCanvasEvents(refs.canvas);
    new ResizeObserver(() => resizeCanvas()).observe(refs.wrap);
    requestAnimationFrame(resizeCanvas);

    // Fleet positions, countdowns and the attack pulse move; redraw while shown
    // Every second, or four times a second while an attack pulses
    clearInterval(refs.ticker);
    let tick = 0;
    refs.ticker = setInterval(() => {
      if (!refs.canvas?.isConnected) {
        clearInterval(refs.ticker);
        return;
      }
      const moves = state.snapshot?.military?.movements || [];
      tick += 1;
      if (moves.some((m) => m.hostile) || (moves.length && tick % 4 === 0)) draw();
      if (tick % 4 === 0) updateTimeBar();
    }, 250);

    const pending = IkaDios.tabs.pendingOptions;
    if (pending?.id === 'map' && pending.center) {
      IkaDios.tabs.pendingOptions = null;
      requestAnimationFrame(() => requestAnimationFrame(() => centerOn(pending.center.x, pending.center.y)));
    }
    if (state.world !== snapshot?.account?.world || !state.islands.length) loadWorld(false);
    else fillSuggestions();
    updateStatus();
    refreshResults();
  }

  // ---------- Time slider ----------

  // "Movements at": now up to the last known arrival, in 5 minute steps
  function timeBar(t) {
    refs.timeRange = el('input', {
      type: 'range',
      min: '0',
      max: '60',
      step: '5',
      value: String(state.timeOffsetMin),
      style: { flex: '1', minWidth: '160px' },
      oninput: (e) => {
        state.timeOffsetMin = Number(e.target.value);
        updateTimeBar();
        draw();
      },
    });
    refs.timeText = el('span', { class: 'hint' });
    const bar = el('div', { class: 'map-toolbar map-timebar' }, [
      el('strong', { text: t('mapTimeLabel') }),
      refs.timeRange,
      refs.timeText,
      el('button', {
        class: 'btn-soft',
        text: t('mapTimeNow'),
        onclick: () => {
          state.timeOffsetMin = 0;
          refs.timeRange.value = '0';
          updateTimeBar();
          draw();
        },
      }),
    ]);
    requestAnimationFrame(updateTimeBar);
    return bar;
  }

  function updateTimeBar() {
    if (!refs.timeBar?.isConnected) return;
    const { t, formatTime } = helpers.i18n;
    const last = IkaDios.fleetTrack.lastArrival(state.snapshot?.military?.movements, endpointCoords);
    const maxMin = last ? Math.min(48 * 60, Math.ceil((last - Date.now()) / 300000) * 5) : 0;
    refs.timeBar.hidden = maxMin <= 0;
    refs.timeRange.max = String(Math.max(5, maxMin));
    if (state.timeOffsetMin > maxMin) {
      state.timeOffsetMin = Math.max(0, maxMin);
      refs.timeRange.value = String(state.timeOffsetMin);
    }
    refs.timeText.textContent = state.timeOffsetMin
      ? t('mapTimeAhead', { time: shortLeft(state.timeOffsetMin * 60000), when: formatTime(viewTime()) })
      : t('mapTimeNowLabel');
  }

  // ---------- Share the map ----------

  // PNG for sharing and download: the map between the color legend (left) and
  // the list of active movements (right), like the tab shows them
  function canvasBlob() {
    const { t } = helpers.i18n;
    const map = refs.canvas;
    const L = 230;
    const R = 300;
    const PAD = 10;
    const font = (bold) => `${bold ? 'bold ' : ''}12px Arial`;
    const measureCtx = document.createElement('canvas').getContext('2d');
    // Wrapped lines of a text for a given width
    const wrap = (ctx, text, width, bold) => {
      ctx.font = font(bold);
      const lines = [];
      let line = '';
      for (const word of String(text).split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (line && ctx.measureText(next).width > width) {
          lines.push(line);
          line = word;
        } else line = next;
      }
      if (line) lines.push(line);
      return lines;
    };
    // One pass lays the blocks out; with a context it also paints them
    const layout = (ctx, x0, items) => {
      const m = ctx || measureCtx;
      let y = PAD;
      const text = (str, bold, color, xOff = 0, width = 0) => {
        for (const ln of wrap(m, str, (width || (items.width - xOff)) - PAD, bold)) {
          y += 15;
          if (ctx) {
            ctx.font = font(bold);
            ctx.fillStyle = color;
            ctx.fillText(ln, x0 + PAD + xOff, y);
          }
        }
      };
      for (const it of items.list) {
        if (it.title) text(it.title, true, '#2a1505');
        if (it.color) {
          const start = y;
          if (ctx && !items.bar) {
            ctx.fillStyle = it.color;
            ctx.fillRect(x0 + PAD, start + 4, 12, 12);
          }
          text(it.head, true, '#2a1505', items.bar ? 10 : 18);
          if (it.sub) text(it.sub, false, '#5a4630', items.bar ? 10 : 18);
          if (it.sub2) text(it.sub2, false, '#5a4630', items.bar ? 10 : 18);
          if (ctx && items.bar) {
            ctx.fillStyle = it.color;
            ctx.fillRect(x0 + PAD, start + 3, 4, y - start - 1);
          }
          y += items.bar ? 6 : 4;
        }
        if (it.note) text(it.note, false, '#5a4630');
      }
      return y + PAD;
    };
    const left = {
      width: L,
      list: [
        { title: t('mapMovesTitle') },
        ...MOVE_KINDS.map((k) => ({ color: COLORS[k.color], head: `${t(k.label)} (${state.moveCounts?.[k.key] || 0})`, sub: t(`${k.label}Hint`) })),
        { note: t('mapMovesLines') },
        { title: t('mapLayersLegend') },
        ...(visibleLayerRows().some((r) => r.visible)
          ? visibleLayerRows().filter((r) => r.visible).map((r) => ({ color: r.color, head: `${r.name} (${r.count})` }))
          : [{ note: t('mapLayersNone') }]),
      ],
    };
    const rows = state.moveRows || [];
    const right = {
      width: R,
      bar: true,
      list: [
        { title: t('mapMovesList') },
        ...(rows.length
          ? rows.map((r) => ({ color: r.color, head: r.when ? `${r.title}  -  ${r.when}` : r.title, sub: r.route, sub2: r.detail }))
          : [{ note: t('mapMovesNone') }]),
      ],
    };
    const height = Math.max(map.height, layout(null, 0, left), layout(null, 0, right));
    const out = document.createElement('canvas');
    out.width = L + map.width + R;
    out.height = height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(map, L, 0);
    ctx.strokeStyle = COLORS.axis;
    ctx.strokeRect(L - 0.5, 0.5, 0, height);
    layout(ctx, 0, left);
    layout(ctx, L + map.width, right);
    return new Promise((resolve) => out.toBlob(resolve, 'image/png'));
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function visibleLayers() {
    return layers.data.layers.filter((l) => l.visible && Object.keys(l.marks).length);
  }

  function sharePanel(t) {
    const status = el('span', { class: 'hint' });
    const world = state.snapshot?.account?.world;
    const player = state.snapshot?.account?.playerName || t('discordUnknownPlayer');
    const shared = visibleLayers();
    const summary = shared.map((l) => ({ name: l.name, count: Object.keys(l.marks).length }));
    const linkFor = () => (shared.length && world ? IkaDios.mapShare.buildLink(world, shared, player) : Promise.resolve(null));
    const busy = async (fn) => {
      status.textContent = '...';
      try {
        status.textContent = await fn();
      } catch (err) {
        status.textContent = t('discordFailedReason', { reason: String(err?.message || err) });
      }
    };

    const discord = el('button', {
      class: 'refresh discord',
      text: t('sendToDiscord'),
      onclick: () =>
        busy(async () => {
          const [blob, link] = await Promise.all([canvasBlob(), linkFor()]);
          const layersFile = shared.length ? { format: 'ikadios-map-layer', version: 1, world, name: shared.map((l) => l.name).join(' + '), marks: Object.assign({}, ...shared.map((l) => l.marks)) } : null;
          const res = await chrome.runtime.sendMessage({
            type: 'ikadios:discordMapShare',
            share: { imageDataUrl: await blobToDataUrl(blob), link, layers: summary, layersFile },
          });
          return IkaDios.discordResultText(res, helpers.i18n, 'layerNoWebhook');
        }),
    });
    const whatsapp = el('button', {
      class: 'refresh whatsapp',
      text: t('shareWhatsApp'),
      onclick: () =>
        busy(async () => {
          const link = await linkFor();
          const lines = [
            `*${t('mapShareTitle', { player })}*`,
            ...summary.map((l) => `- ${l.name}: ${t('layerMarks', { n: l.count })}`),
            link ? `${t('mapShareImportLink')}: ${link}` : null,
          ].filter(Boolean);
          window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(lines.join('\n'))}`, '_blank', 'noopener');
          return t('mapShareWhatsAppOpened');
        }),
    });
    const copy = el('button', {
      class: 'refresh',
      text: t('mapShareCopyImage'),
      onclick: () =>
        busy(async () => {
          const blob = await canvasBlob();
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          return t('mapShareCopied');
        }),
    });
    const save = el('button', {
      class: 'refresh',
      text: t('mapShareDownload'),
      onclick: () =>
        busy(async () => {
          const url = URL.createObjectURL(await canvasBlob());
          el('a', { href: url, download: `ikadios-map-${world || 'world'}.png` }).click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          return '';
        }),
    });

    IkaDios.icons.brand(discord, 'discord');
    IkaDios.icons.brand(whatsapp, 'whatsapp');
    return el('div', { class: 'map-toolbar share-bar' }, [
      el('strong', { text: t('mapShare') }),
      el('span', {
        class: 'age',
        text: shared.length ? t('mapShareWhat', { n: shared.length, islands: summary.reduce((a, l) => a + l.count, 0) }) : t('mapShareNoLayers'),
      }),
      discord,
      whatsapp,
      copy,
      save,
      status,
    ]);
  }

  // Layers received through a shared map link: ask before importing
  function importPrompt(t) {
    const pending = IkaDios.mapImport;
    if (!pending) return null;
    const box = el('div', { class: 'trade-form delivery map-import' }, [
      el('strong', { text: t('mapImportTitle', { player: pending.from || '?', n: pending.layers.length, islands: pending.marks }) }),
      el('div', { class: 'age', text: pending.layers.map((l) => `${l.name} (${Object.keys(l.marks).length})`).join(', ') }),
      el('div', { class: 'trade-row' }, [
        el('button', {
          class: 'refresh',
          text: t('mapImport'),
          onclick: async () => {
            for (const layer of pending.layers) {
              await layers.importLayer({ format: 'ikadios-map-layer', version: 1, name: layer.name, marks: layer.marks });
            }
            IkaDios.mapImport = null;
            box.remove();
            renderLayers();
            draw();
          },
        }),
        el('button', {
          class: 'btn-soft danger',
          text: t('deliveryDiscard'),
          onclick: () => {
            IkaDios.mapImport = null;
            box.remove();
          },
        }),
      ]),
      el('p', { class: 'age', text: t('mapImportHint') }),
    ]);
    return box;
  }

  // ---------- Paint and layers ----------

  function paintBar(t) {
    const label = el('input', {
      type: 'text',
      maxlength: '30',
      value: state.paint.label,
      placeholder: t('layerLabelPlaceholder'),
      oninput: (e) => {
        state.paint.label = e.target.value;
      },
    });
    const hours = el(
      'select',
      { onchange: (e) => (state.paint.hours = Number(e.target.value)) },
      layers.EXPIRY_HOURS.map((h) => el('option', { value: String(h), text: h ? t('layerExpiresIn', { n: h }) : t('layerNoExpiry') }))
    );
    hours.value = String(state.paint.hours);
    const swatches = layers.COLORS.map((color) => {
      const b = el('button', {
        class: `swatch-btn ${state.paint.color === color ? 'is-active' : ''}`,
        style: { background: color },
        title: color,
        onclick: () => {
          state.paint.color = color;
          for (const s of swatches) s.classList.toggle('is-active', s === b);
        },
      });
      return b;
    });
    const bar = el('div', { class: 'map-toolbar paint-bar', hidden: !state.paint.on }, [
      el('strong', { text: t('layerBrush') }),
      ...swatches,
      label,
      hours,
      el('span', { class: 'age', text: t('layerPaintHelp') }),
    ]);
    return bar;
  }

  function download(name, json) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }));
    const a = el('a', { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderLayers() {
    if (!refs.layers?.isConnected) return;
    const { t } = helpers.i18n;
    const data = layers.data;
    const newName = el('input', { type: 'text', maxlength: '40', placeholder: t('layerNewPlaceholder') });
    const importInput = el('input', {
      type: 'file',
      accept: '.json,application/json',
      hidden: true,
      onchange: async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          await layers.importLayer(JSON.parse(await file.text()));
          renderLayers();
          draw();
        } catch {
          refs.layerMsg.textContent = t('layerImportFailed');
        }
      },
    });
    refs.layerMsg = el('span', { class: 'age' });
    refs.layers.replaceChildren(
      el('h3', { class: 'section-title', text: t('layerTitle') }),
      el('table', { class: 'grid narrow' }, el('tbody', {}, data.layers.map((layer) => {
        const count = Object.keys(layer.marks).length;
        const active = layer.id === data.activeLayerId;
        return el('tr', { class: active ? 'is-current' : '' }, [
          el('td', {}, el('label', { class: 'check' }, [
            el('input', {
              type: 'checkbox',
              checked: layer.visible ? true : null,
              title: t('layerVisible'),
              onchange: (e) => {
                layer.visible = e.target.checked;
                layers.save().then(draw);
              },
            }),
            el('strong', { text: layer.name }),
          ])),
          el('td', { class: 'age', text: t('layerMarks', { n: count }) }),
          el('td', { class: 'nowrap' }, [
            active
              ? el('span', { class: 'age', text: t('layerActive') })
              : IkaDios.icons.button('edit', t('layerUse'), () => {
                  data.activeLayerId = layer.id;
                  layers.save().then(renderLayers);
                }),
            layer.source
              ? IkaDios.icons.button('retry', t('layerRebuild'), async () => {
                  const n = await layers.replaceMarks(layer, marksFromWorld(layer.source.kind, layer.source.text, layer.source.color));
                  renderLayers();
                  draw();
                  refs.layerMsg.textContent = t('layerFromTextCreated', { n });
                })
              : null,
            IkaDios.icons.button('download', t('optExport'), () => download(`ikadios-layer-${layer.name.replace(/[^\w.-]+/g, '_')}.json`, layers.exportLayer(layer))),
            IkaDios.icons.button(
              'discord',
              t('sendToDiscord'),
              async () => {
                const res = await chrome.runtime.sendMessage({ type: 'ikadios:discordMapLayer', layer: layers.exportLayer(layer) }).catch(() => null);
                refs.layerMsg.textContent = IkaDios.discordResultText(res, helpers.i18n, 'layerNoWebhook');
              },
              { disabled: !count }
            ),
            IkaDios.icons.button('erase', t('layerClear'), () => {
              layer.marks = {};
              layers.save().then(() => {
                renderLayers();
                draw();
              });
            }),
            IkaDios.icons.button('trash', t('delete'), () => layers.removeLayer(layer.id).then(() => {
              renderLayers();
              draw();
            })),
          ]),
        ]);
      }))),
      el('div', { class: 'map-toolbar' }, [
        newName,
        el('button', { class: 'refresh', text: t('layerAdd'), onclick: () => { if (newName.value.trim()) layers.addLayer(newName.value.trim()).then(renderLayers); } }),
        el('button', { class: 'refresh', text: t('layerFromText'), onclick: () => { refs.textBox.hidden = !refs.textBox.hidden; } }),
        el('button', { class: 'refresh', text: t('layerFromWorld'), onclick: () => { refs.worldBox.hidden = !refs.worldBox.hidden; } }),
        el('button', { class: 'refresh', text: t('layerImport'), onclick: () => importInput.click() }),
        importInput,
        refs.layerMsg,
      ]),
      (refs.textBox = layerFromTextBox(t)),
      (refs.worldBox = layerFromWorldBox(t))
    );
  }

  // New layer with the cities of a player or an alliance
  function layerFromWorldBox(t) {
    let color = layers.COLORS[1];
    const kind = el('select', {}, [el('option', { value: 'player', text: t('mapPlayer') }), el('option', { value: 'alliance', text: t('mapAlliance') })]);
    const who = el('input', { type: 'text', maxlength: '40', placeholder: t('layerWorldPlaceholder'), list: 'ikadios-players' });
    kind.onchange = () => who.setAttribute('list', kind.value === 'alliance' ? 'ikadios-allies' : 'ikadios-players');
    const swatches = layers.COLORS.map((c) => {
      const b = el('button', {
        class: `swatch-btn ${c === color ? 'is-active' : ''}`,
        style: { background: c },
        onclick: () => {
          color = c;
          for (const s of swatches) s.classList.toggle('is-active', s === b);
        },
      });
      return b;
    });
    const preview = el('span', { class: 'age' });
    who.oninput = () => {
      preview.textContent = t('layerFromTextFound', { n: Object.keys(marksFromWorld(kind.value, who.value, color)).length });
    };
    const create = el('button', {
      class: 'refresh',
      text: t('layerFromTextCreate'),
      onclick: async () => {
        const marks = marksFromWorld(kind.value, who.value, color);
        if (!Object.keys(marks).length) {
          preview.textContent = t('layerFromTextFound', { n: 0 });
          return;
        }
        const name = kind.value === 'alliance' ? `[${who.value.trim()}]` : who.value.trim();
        const n = await layers.addLayerFromMarks(name, marks, { kind: kind.value, text: who.value.trim(), color });
        renderLayers();
        draw();
        refs.layerMsg.textContent = t('layerFromTextCreated', { n });
      },
    });
    return el('div', { class: 'trade-form layer-text', hidden: true }, [
      el('strong', { text: t('layerFromWorld') }),
      el('div', { class: 'trade-row' }, [kind, who, ...swatches]),
      el('div', { class: 'trade-row' }, [create, preview]),
      el('p', { class: 'age', text: t('layerFromWorldHint') }),
    ]);
  }

  // Paste coordinates (e.g. a layer message from Discord / WhatsApp) into a new layer
  function layerFromTextBox(t) {
    const name = el('input', { type: 'text', maxlength: '40', placeholder: t('layerNewPlaceholder') });
    const preview = el('span', { class: 'age' });
    let color = state.paint.color;
    const text = el('textarea', {
      rows: '5',
      placeholder: t('layerFromTextPlaceholder'),
      oninput: () => {
        const { count } = layers.marksFromText(text.value);
        preview.textContent = t('layerFromTextFound', { n: count });
      },
    });
    const swatches = layers.COLORS.map((c) => {
      const b = el('button', {
        class: `swatch-btn ${c === color ? 'is-active' : ''}`,
        style: { background: c },
        onclick: () => {
          color = c;
          for (const s of swatches) s.classList.toggle('is-active', s === b);
        },
      });
      return b;
    });
    const create = el('button', {
      class: 'refresh',
      text: t('layerFromTextCreate'),
      onclick: async () => {
        const count = await layers.addLayerFromText(name.value.trim() || t('layerDefaultName'), text.value, { color, label: state.paint.label, hours: state.paint.hours });
        if (!count) {
          preview.textContent = t('layerFromTextFound', { n: 0 });
          return;
        }
        renderLayers();
        draw();
        refs.layerMsg.textContent = t('layerFromTextCreated', { n: count });
      },
    });
    return el('div', { class: 'trade-form layer-text', hidden: true }, [
      el('strong', { text: t('layerFromText') }),
      el('div', { class: 'trade-row' }, [name, ...swatches]),
      text,
      el('div', { class: 'trade-row' }, [create, preview]),
      el('p', { class: 'age', text: t('layerFromTextHint') }),
    ]);
  }

  function update(container, snapshot) {
    state.snapshot = snapshot;
    draw();
    updateTimeBar();
  }

  IkaDios.tabs.register({ id: 'map', labelKey: 'tab_map', order: 100, persistent: true, render, update });
  IkaDios.mapTab = { state };
})(typeof self !== 'undefined' ? self : window);

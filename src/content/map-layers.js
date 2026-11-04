// Temporary map paint: named layers of island marks ({color, label, expiresAt}),
// per world in chrome.storage.local (small data). Expired marks are dropped on
// load and save. Layers can be exported/imported as JSON and sent to Discord.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;

  const FORMAT = 'ikadios-map-layer';
  const COLORS = ['#e0312b', '#ef6c00', '#f2c200', '#2e9e44', '#1f6fd1', '#7b1fa2'];
  const EXPIRY_HOURS = [1, 6, 24, 72, 0];
  const MAX_LABEL = 30;

  let world = null;
  let data = { layers: [], activeLayerId: null };
  const listeners = new Set();

  const key = () => `mapLayers:${world}`;
  const now = () => Date.now();

  function newLayer(name) {
    return { id: `layer_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name, visible: true, marks: {} };
  }

  function purge() {
    for (const layer of data.layers) {
      for (const [coord, mark] of Object.entries(layer.marks)) if (mark.expiresAt && mark.expiresAt <= now()) delete layer.marks[coord];
    }
  }

  function notify() {
    for (const fn of listeners) fn(data);
  }

  async function load(w) {
    world = w;
    const stored = (await chrome.storage.local.get(key()))[key()];
    data = stored && Array.isArray(stored.layers) ? stored : { layers: [], activeLayerId: null };
    if (!data.layers.length) {
      const layer = newLayer(IkaDios.i18n.t('layerDefaultName'));
      data.layers.push(layer);
      data.activeLayerId = layer.id;
    }
    purge();
    notify();
    return data;
  }

  async function save() {
    purge();
    await chrome.storage.local.set({ [key()]: data });
    notify();
  }

  function activeLayer() {
    return data.layers.find((l) => l.id === data.activeLayerId) || data.layers[0];
  }

  // Marks on an island from visible layers: [{layer, mark}]
  function marksAt(coord) {
    const t = now();
    const out = [];
    for (const layer of data.layers) {
      if (!layer.visible) continue;
      const mark = layer.marks[coord];
      if (mark && (!mark.expiresAt || mark.expiresAt > t)) out.push({ layer, mark });
    }
    return out;
  }

  function setMark(coord, brush) {
    const layer = activeLayer();
    layer.marks[coord] = {
      color: brush.color,
      label: String(brush.label || '').slice(0, MAX_LABEL),
      expiresAt: brush.hours ? now() + brush.hours * 3600 * 1000 : null,
    };
  }

  function clearMark(coord) {
    delete activeLayer().marks[coord];
  }

  function hasMark(coord) {
    return !!activeLayer().marks[coord];
  }

  function addLayer(name) {
    const layer = newLayer(name);
    data.layers.push(layer);
    data.activeLayerId = layer.id;
    return save();
  }

  function removeLayer(id) {
    data.layers = data.layers.filter((l) => l.id !== id);
    if (!data.layers.length) data.layers.push(newLayer(IkaDios.i18n.t('layerDefaultName')));
    if (!data.layers.some((l) => l.id === data.activeLayerId)) data.activeLayerId = data.layers[0].id;
    return save();
  }

  function exportLayer(layer) {
    return { format: FORMAT, version: 1, world, name: layer.name, exportedAt: now(), marks: layer.marks };
  }

  // Optional sub-colors of a mark (several owners on one island)
  function validParts(parts) {
    if (!Array.isArray(parts)) return [];
    return parts
      .slice(0, 8)
      .filter((p) => p && /^#[0-9a-f]{6}$/i.test(p.color))
      .map((p) => ({ color: p.color, label: String(p.label || '').slice(0, MAX_LABEL) }));
  }

  // Imported marks are validated and the layer is added as a new one
  function importLayer(json) {
    if (!json || json.format !== FORMAT || typeof json.marks !== 'object') throw new Error('format');
    const layer = newLayer(String(json.name || 'import').slice(0, 40));
    for (const [coord, mark] of Object.entries(json.marks)) {
      if (!/^\d{1,3}:\d{1,3}$/.test(coord) || !mark || typeof mark !== 'object') continue;
      const color = /^#[0-9a-f]{6}$/i.test(mark.color) ? mark.color : COLORS[0];
      const expiresAt = Number(mark.expiresAt) || null;
      if (expiresAt && expiresAt <= now()) continue;
      layer.marks[coord] = { color, label: String(mark.label || '').slice(0, MAX_LABEL), expiresAt };
      const parts = validParts(mark.parts);
      if (parts.length) layer.marks[coord].parts = parts;
    }
    data.layers.push(layer);
    data.activeLayerId = layer.id;
    return save();
  }

  // Pasted text (e.g. a Discord / WhatsApp layer message) into marks. Each line may
  // start with a label ("target: [47:20], [48:17]"); coordinates are x:y with or
  // without brackets. Returns { marks: {coord: {color, label, expiresAt}}, count }.
  const COORD_IN_TEXT = /\[?\s*(\d{1,3})\s*:\s*(\d{1,3})\s*\]?/g;
  const LINE_LABEL = /^\s*[-*]?\s*([^\d\[\]:][^\[\]:]{0,40}?)\s*:\s*(?=.*\d{1,3}\s*:\s*\d{1,3})/;

  function marksFromText(text, { color = COLORS[0], label = '', hours = 0 } = {}) {
    const marks = {};
    const expiresAt = hours ? now() + hours * 3600 * 1000 : null;
    for (const line of String(text || '').split(/\r?\n/)) {
      const lineLabel = LINE_LABEL.exec(line)?.[1]?.trim();
      for (const m of line.matchAll(COORD_IN_TEXT)) {
        const x = Number(m[1]);
        const y = Number(m[2]);
        if (x > 100 || y > 100) continue;
        marks[`${x}:${y}`] = { color, label: String(lineLabel || label || '').slice(0, MAX_LABEL), expiresAt };
      }
    }
    return { marks, count: Object.keys(marks).length };
  }

  async function addLayerFromText(name, text, brush) {
    const { marks, count } = marksFromText(text, brush);
    if (!count) return 0;
    const layer = newLayer(String(name || IkaDios.i18n.t('layerDefaultName')).slice(0, 40));
    layer.marks = marks;
    data.layers.push(layer);
    data.activeLayerId = layer.id;
    await save();
    return count;
  }

  // Layer filled from world data (a player or an alliance). `source` is kept so the
  // layer can be rebuilt later: { kind: 'player'|'alliance', text }
  async function addLayerFromMarks(name, marks, source) {
    const layer = newLayer(String(name || IkaDios.i18n.t('layerDefaultName')).slice(0, 40));
    layer.marks = marks;
    layer.source = source || null;
    data.layers.push(layer);
    data.activeLayerId = layer.id;
    await save();
    return Object.keys(marks).length;
  }

  async function replaceMarks(layer, marks) {
    layer.marks = marks;
    await save();
    return Object.keys(marks).length;
  }

  // Layers written by another context (the alliance bot in the worker) replace the
  // in-memory copy; our own writes come back identical and are ignored
  if (IkaDios.util.extensionAlive()) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !world || !changes[key()]) return;
      const next = changes[key()].newValue;
      if (!next || !Array.isArray(next.layers) || JSON.stringify(next) === JSON.stringify(data)) return;
      data = next;
      if (!data.layers.some((l) => l.id === data.activeLayerId)) data.activeLayerId = data.layers[0]?.id || null;
      notify();
    });
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  IkaDios.mapLayers = {
    COLORS,
    EXPIRY_HOURS,
    load,
    save,
    get data() {
      return data;
    },
    activeLayer,
    marksAt,
    setMark,
    clearMark,
    hasMark,
    addLayer,
    removeLayer,
    exportLayer,
    importLayer,
    marksFromText,
    addLayerFromText,
    addLayerFromMarks,
    replaceMarks,
    onChange,
  };
})(typeof self !== 'undefined' ? self : window);

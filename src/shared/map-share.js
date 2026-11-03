// Shared map links: the visible paint layers travel in the URL fragment
// (#ikadios-map=...), deflate-compressed and base64url-encoded, so a link fits in
// a Discord message. Opening the link with IkaDios asks before importing.
// Links are untrusted input: decode() keeps only well-formed, bounded values.
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});

  const HASH_KEY = 'ikadios-map';
  const MAX_LAYERS = 10;
  const MAX_MARKS = 2000;
  const MAX_TEXT = 40;
  const COLOR = /^#[0-9a-f]{6}$/i;
  const COORD = /^\d{1,3}:\d{1,3}$/;

  function bytesToBase64Url(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlToBytes(text) {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  async function deflate(text) {
    const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  }

  // Marks with the same color, label and expiry are grouped to keep links short:
  // {v, from, layers: [{n: name, g: [{c: color, l: label, e: expiresAt, p: ["x:y", ...]}]}]}
  function pack(layers, from) {
    const now = Date.now();
    return {
      v: 1,
      from,
      layers: layers.map((layer) => {
        const groups = new Map();
        for (const [coord, mark] of Object.entries(layer.marks || {})) {
          if (mark.expiresAt && mark.expiresAt <= now) continue;
          const key = `${mark.color}|${mark.label || ''}|${mark.expiresAt || 0}`;
          if (!groups.has(key)) groups.set(key, { c: mark.color, l: mark.label || '', e: mark.expiresAt || 0, p: [] });
          groups.get(key).p.push(coord);
        }
        return { n: layer.name, g: [...groups.values()] };
      }),
    };
  }

  async function buildLink(world, layers, from) {
    const data = await deflate(JSON.stringify(pack(layers, from)));
    return `https://${world}.ikariam.gameforge.com/index.php#${HASH_KEY}=${bytesToBase64Url(data)}`;
  }

  const text = (v) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, MAX_TEXT);

  // Returns { from, layers: [{name, marks: {coord: {color, label, expiresAt}}}] } or null
  async function decode(hash) {
    const m = new RegExp(`${HASH_KEY}=([A-Za-z0-9_-]{1,20000})`).exec(String(hash || ''));
    if (!m) return null;
    let raw;
    try {
      raw = JSON.parse(await inflate(base64UrlToBytes(m[1])));
    } catch {
      return null;
    }
    if (!raw || raw.v !== 1 || !Array.isArray(raw.layers)) return null;
    const now = Date.now();
    let total = 0;
    const layers = [];
    for (const layer of raw.layers.slice(0, MAX_LAYERS)) {
      const marks = {};
      for (const group of Array.isArray(layer?.g) ? layer.g : []) {
        const color = COLOR.test(group?.c) ? group.c : null;
        const expiresAt = Number(group?.e) || null;
        if (!color || (expiresAt && expiresAt <= now)) continue;
        for (const coord of Array.isArray(group.p) ? group.p : []) {
          if (!COORD.test(coord) || total >= MAX_MARKS) continue;
          const [x, y] = coord.split(':').map(Number);
          if (x > 100 || y > 100) continue;
          marks[coord] = { color, label: text(group.l), expiresAt };
          total += 1;
        }
      }
      if (Object.keys(marks).length) layers.push({ name: text(layer.n) || 'Shared', marks });
    }
    return layers.length ? { from: text(raw.from), layers, marks: total } : null;
  }

  // Shared with other link kinds (src/shared/intel-link.js)
  async function encodeObject(obj) {
    return bytesToBase64Url(await deflate(JSON.stringify(obj)));
  }

  async function decodeObject(text) {
    return JSON.parse(await inflate(base64UrlToBytes(text)));
  }

  IkaDios.mapShare = { HASH_KEY, buildLink, decode, pack, encodeObject, decodeObject };
})(typeof self !== 'undefined' ? self : window);

// Delivery links for alliance trade requests. The Discord message links to the
// game's transport window for the requester's city; the request itself travels in
// the URL fragment (#ikadios-trade=...), which browsers never send to the server.
// An ally with IkaDios gets a prefilled "pending delivery" panel; without it, the
// link still opens the game's transport window.
// Links are untrusted input: parse() accepts only well-formed, bounded values.
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});

  const HASH_KEY = 'ikadios-trade';
  const RESOURCES = ['wood', 'wine', 'marble', 'glass', 'sulfur'];
  const MAX_AMOUNT = 10000000;
  const MAX_TEXT = 120;

  function toBase64Url(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(text) {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  function build(world, request) {
    const payload = {
      v: 1,
      to: request.to,
      toName: request.toName,
      coords: request.coords ? [request.coords.x, request.coords.y] : null,
      player: request.player,
      items: request.items.map((i) => [i.resource, Math.round(i.amount)]),
      note: request.note || '',
    };
    return `https://${world}.ikariam.gameforge.com/index.php?view=transport&destinationCityId=${encodeURIComponent(request.to)}#${HASH_KEY}=${toBase64Url(JSON.stringify(payload))}`;
  }

  const text = (v) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, MAX_TEXT);

  // Returns a clean request or null
  function parse(hash) {
    const m = new RegExp(`${HASH_KEY}=([A-Za-z0-9_-]{1,4000})`).exec(String(hash || ''));
    if (!m) return null;
    let raw;
    try {
      raw = JSON.parse(fromBase64Url(m[1]));
    } catch {
      return null;
    }
    if (!raw || raw.v !== 1 || !/^\d{1,9}$/.test(String(raw.to))) return null;
    const items = (Array.isArray(raw.items) ? raw.items : [])
      .slice(0, 5)
      .map(([resource, amount]) => ({ resource, amount: Math.floor(Number(amount)) }))
      .filter((i) => RESOURCES.includes(i.resource) && Number.isFinite(i.amount) && i.amount > 0 && i.amount <= MAX_AMOUNT);
    if (!items.length) return null;
    const coords = Array.isArray(raw.coords) && raw.coords.every((n) => Number.isInteger(n) && n >= 0 && n <= 100) ? { x: raw.coords[0], y: raw.coords[1] } : null;
    return { to: String(raw.to), toName: text(raw.toName), coords, player: text(raw.player), items, note: text(raw.note) };
  }

  IkaDios.tradeLink = { HASH_KEY, build, parse };
})(typeof self !== 'undefined' ? self : window);

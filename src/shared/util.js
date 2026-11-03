// Shared helpers. Loaded first in every context (content script, options, popup, tests)
// and exposes everything under the global IkaDios namespace, since content scripts
// cannot use ES modules.
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});

  const LOG_PREFIX = '[IkaDios]';
  const MESSAGE_SOURCE = 'ikadios';

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function toNumber(value, fallback = 0) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
    // The game sometimes sends numbers as strings with thousand separators,
    // which are "," or "." depending on the server language
    const text = String(value).trim();
    if (/^-?\d{1,3}([.,\s]\d{3})+$/.test(text)) return Number(text.replace(/[.,\s]/g, ''));
    const cleaned = text.replace(/[^\d.\-]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : fallback;
  }

  // Parses "[50:42]" or "50:42" into {x, y}
  function parseCoords(text) {
    const m = /(\d+)\s*:\s*(\d+)/.exec(String(text || ''));
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  }

  // Deep merge for plain objects. Arrays and primitives from `patch` replace those in `target`.
  function deepMerge(target, patch) {
    if (!isPlainObject(patch)) return patch;
    const out = isPlainObject(target) ? { ...target } : {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      out[key] = isPlainObject(value) ? deepMerge(out[key], value) : value;
    }
    return out;
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  // Host like "s12-es.ikariam.gameforge.com" gives {world: "s12-es", server: 12, lang: "es"}
  function parseGameHost(hostname) {
    const world = String(hostname || '').split('.')[0];
    const m = /^s(\d+)-([a-z]{2,3})$/i.exec(world);
    return { world, server: m ? Number(m[1]) : null, lang: m ? m[2].toLowerCase() : null };
  }

  // False once the extension was reloaded or removed while this page kept running
  // the old content script; every chrome.* call would then throw
  function extensionAlive() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  // Discord webhook URL as created in Channel settings > Integrations > Webhooks
  const DISCORD_WEBHOOK_PATTERN = /^https:\/\/(?:ptb\.|canary\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;

  function isDiscordWebhook(url) {
    return DISCORD_WEBHOOK_PATTERN.test(String(url || '').trim());
  }

  function nowSec() {
    return Math.floor(Date.now() / 1000);
  }

  IkaDios.util = {
    LOG_PREFIX,
    MESSAGE_SOURCE,
    log,
    warn,
    toNumber,
    parseCoords,
    deepMerge,
    isPlainObject,
    debounce,
    el,
    parseGameHost,
    nowSec,
    extensionAlive,
    isDiscordWebhook,
  };
})(typeof self !== 'undefined' ? self : window);

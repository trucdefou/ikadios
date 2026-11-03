// Runtime i18n. chrome.i18n only follows the browser language, so the catalogs in
// _locales/<lang>/messages.json are fetched directly to allow a user override and
// "auto" mode (game server language). Messages use {param} placeholders; plural
// variants are stored as <key>_one / <key>_other / ... per Intl.PluralRules.
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});

  const SUPPORTED = ['es', 'en'];
  const FALLBACK = 'en';
  const SETTINGS_KEY = 'settings';

  // Native names are shown as-is in the language selector
  const LANGUAGE_NAMES = { es: 'Español', en: 'English' };

  let locale = FALLBACK;
  let catalog = {};
  let fallbackCatalog = {};
  const listeners = new Set();

  async function fetchCatalog(lang) {
    try {
      const res = await fetch(chrome.runtime.getURL(`_locales/${lang}/messages.json`));
      if (!res.ok) return {};
      const raw = await res.json();
      const out = {};
      for (const [key, entry] of Object.entries(raw)) out[key] = entry.message;
      return out;
    } catch (err) {
      IkaDios.util?.warn('i18n: cannot load catalog', lang, err);
      return {};
    }
  }

  function resolveLanguage(preference, gameLang) {
    const candidates = [];
    if (preference && preference !== 'auto') candidates.push(preference);
    if (gameLang) candidates.push(gameLang);
    candidates.push(...(navigator.languages || [navigator.language]).map((l) => String(l).slice(0, 2)));
    candidates.push(FALLBACK);
    return candidates.find((c) => SUPPORTED.includes(c)) || FALLBACK;
  }

  async function init({ gameLang = null } = {}) {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const preference = stored[SETTINGS_KEY]?.language || 'auto';
    await setLocale(resolveLanguage(preference, gameLang));

    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area !== 'local' || !changes[SETTINGS_KEY]) return;
      const next = resolveLanguage(changes[SETTINGS_KEY].newValue?.language || 'auto', gameLang);
      if (next !== locale) await setLocale(next);
    });
  }

  async function setLocale(lang) {
    if (!fallbackCatalog || !Object.keys(fallbackCatalog).length) fallbackCatalog = await fetchCatalog(FALLBACK);
    catalog = lang === FALLBACK ? fallbackCatalog : await fetchCatalog(lang);
    locale = lang;
    for (const fn of listeners) {
      try {
        fn(locale);
      } catch (err) {
        IkaDios.util?.warn('i18n listener failed', err);
      }
    }
  }

  function lookup(key) {
    if (key in catalog) return catalog[key];
    if (key in fallbackCatalog) return fallbackCatalog[key];
    return null;
  }

  function t(key, params = {}) {
    let message = null;
    if (typeof params.n === 'number') {
      const category = new Intl.PluralRules(locale).select(params.n);
      message = lookup(`${key}_${category}`) ?? lookup(`${key}_other`);
    }
    if (message === null) message = lookup(key);
    if (message === null) return key;
    return message.replace(/\{(\w+)\}/g, (match, name) => {
      if (!(name in params)) return match;
      const value = params[name];
      return typeof value === 'number' ? formatNumber(value) : String(value);
    });
  }

  // Translation with a fallback for open-ended ids (buildings, units) not yet in the catalog
  function tOr(key, fallback, params) {
    return lookup(key) === null ? fallback : t(key, params);
  }

  // Names the game itself uses (captured from building views), for types missing here
  let gameBuildingNames = {};
  function setGameBuildingNames(names) {
    gameBuildingNames = names || {};
  }

  function buildingName(type) {
    return tOr(`building_${type}`, gameBuildingNames[type] || type);
  }

  function formatNumber(n, options = {}) {
    if (n === null || n === undefined || Number.isNaN(n)) return '-';
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 0, ...options }).format(n);
  }

  function formatSigned(n) {
    return formatNumber(n, { signDisplay: 'exceptZero' });
  }

  // Seconds to "2d 4h", "3h 12m", "4m 05s"
  function formatDuration(totalSeconds) {
    if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) return '-';
    let s = Math.max(0, Math.floor(totalSeconds));
    const d = Math.floor(s / 86400);
    s -= d * 86400;
    const h = Math.floor(s / 3600);
    s -= h * 3600;
    const m = Math.floor(s / 60);
    s -= m * 60;
    const pad = (v) => String(v).padStart(2, '0');
    if (d > 0) return t('durationDH', { d, h });
    if (h > 0) return t('durationHM', { h, m: pad(m) });
    return t('durationMS', { m, s: pad(s) });
  }

  function formatRelative(timestampMs) {
    if (!timestampMs) return t('never');
    const diffSec = Math.round((timestampMs - Date.now()) / 1000);
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    const abs = Math.abs(diffSec);
    if (abs < 60) return rtf.format(diffSec, 'second');
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour');
    return rtf.format(Math.round(diffSec / 86400), 'day');
  }

  function formatTime(timestampMs) {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(timestampMs);
  }

  // Fills elements marked with data-i18n (text), data-i18n-title and data-i18n-placeholder
  function applyDom(rootNode = document) {
    for (const node of rootNode.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
    for (const node of rootNode.querySelectorAll('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle);
    for (const node of rootNode.querySelectorAll('[data-i18n-placeholder]')) {
      node.placeholder = t(node.dataset.i18nPlaceholder);
    }
    if (rootNode === document) document.documentElement.lang = locale;
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  IkaDios.i18n = {
    SUPPORTED,
    LANGUAGE_NAMES,
    init,
    setLocale,
    t,
    tOr,
    buildingName,
    setGameBuildingNames,
    formatNumber,
    formatSigned,
    formatDuration,
    formatRelative,
    formatTime,
    applyDom,
    onChange,
    get locale() {
      return locale;
    },
  };
  IkaDios.t = t;
})(typeof self !== 'undefined' ? self : window);

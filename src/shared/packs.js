// Advisor image packs: format, validation and storage. Shared by the content
// script (applies the active pack), the options page (editor) and the popup.
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});

  const FORMAT = 'ikadios-advisor-pack';
  const FORMAT_VERSION = 1;
  const ADVISORS = ['cities', 'military', 'research', 'diplomacy'];
  // alert / premiumAlert: military advisor under attack (falls back to active)
  const STATES = ['normal', 'active', 'alert', 'premium', 'premiumActive', 'premiumAlert'];
  // contain: keep the image ratio inside the 90x108 advisor slot; fill: stretch to it
  const FITS = ['contain', 'fill'];
  // Optional city view skins, one image per building type (the class the game puts
  // on #locations > .building next to the position, e.g. "building townHall")
  const BUILDINGS = [
    'townHall', 'academy', 'warehouse', 'tavern', 'palace', 'palaceColony', 'museum', 'port', 'shipyard', 'barracks',
    'wall', 'embassy', 'branchOffice', 'workshop', 'safehouse', 'forester', 'glassblowing', 'alchemist', 'winegrower',
    'stonemason', 'carpentering', 'optician', 'fireworker', 'vineyard', 'architect', 'temple', 'dump', 'pirateFortress',
    'blackMarket', 'marineChartArchive',
  ];
  const ORIGINAL_ID = 'original';

  const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  const MAX_IMAGE_CHARS = 1.5 * 1024 * 1024;
  const MAX_PACK_CHARS = 8 * 1024 * 1024;

  // Packs shipped with the extension (read-only; they can be duplicated to edit)
  const BUILTIN_FILES = ['packs/greek-portraits.json', 'packs/egyptian-court.json', 'packs/action-heroes.json', 'packs/fantasy-war.json'];

  const KEY_PACKS = 'advisorPacks';
  const KEY_ACTIVE = 'activeAdvisorPackId';

  function originalPack() {
    return {
      format: FORMAT,
      version: FORMAT_VERSION,
      id: ORIGINAL_ID,
      name: { es: 'Original', en: 'Original' },
      author: 'Gameforge',
      description: '',
      advisors: {},
      builtin: true,
    };
  }

  function newPack(name) {
    return {
      format: FORMAT,
      version: FORMAT_VERSION,
      id: `pack_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      name,
      author: '',
      description: '',
      advisors: {},
    };
  }

  // Text fields may be a plain string or a {lang: text} map
  function localized(value, locale) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    return value[locale] || value.en || Object.values(value)[0] || '';
  }

  function dataUrlMime(dataUrl) {
    const m = /^data:([\w/+.-]+);base64,/.exec(dataUrl || '');
    return m ? m[1] : null;
  }

  function validatePack(pack) {
    const errors = [];
    if (!pack || typeof pack !== 'object') return { ok: false, errors: ['packErrNotObject'] };
    if (pack.format !== FORMAT) errors.push('packErrFormat');
    if (typeof pack.version !== 'number' || pack.version > FORMAT_VERSION) errors.push('packErrVersion');
    if (!pack.name) errors.push('packErrName');
    if (!pack.advisors || typeof pack.advisors !== 'object') errors.push('packErrAdvisors');

    let total = 0;
    for (const [advisor, entry] of Object.entries(pack.advisors || {})) {
      if (!ADVISORS.includes(advisor)) {
        errors.push('packErrUnknownAdvisor');
        continue;
      }
      for (const state of STATES) {
        const img = entry?.[state];
        if (!img) continue;
        if (typeof img !== 'string' || !ALLOWED_MIME.includes(dataUrlMime(img))) errors.push('packErrImageType');
        else if (img.length > MAX_IMAGE_CHARS) errors.push('packErrImageSize');
        total += img.length;
      }
    }
    if (pack.buildings != null && typeof pack.buildings !== 'object') errors.push('packErrBuildings');
    for (const [building, img] of Object.entries(pack.buildings || {})) {
      if (!BUILDINGS.includes(building)) {
        errors.push('packErrUnknownBuilding');
        continue;
      }
      if (typeof img !== 'string' || !ALLOWED_MIME.includes(dataUrlMime(img))) errors.push('packErrImageType');
      else if (img.length > MAX_IMAGE_CHARS) errors.push('packErrImageSize');
      else total += img.length;
    }
    if (total > MAX_PACK_CHARS) errors.push('packErrPackSize');
    return { ok: errors.length === 0, errors: [...new Set(errors)] };
  }

  // Strips anything unknown so imported JSON cannot smuggle extra fields into storage
  function sanitizePack(pack) {
    const clean = newPack(pack.name);
    if (pack.id && pack.id !== ORIGINAL_ID) clean.id = String(pack.id);
    clean.author = typeof pack.author === 'string' ? pack.author : '';
    clean.description = pack.description || '';
    if (pack.pixelated === true) clean.pixelated = true;
    if (FITS.includes(pack.fit)) clean.fit = pack.fit;
    for (const advisor of ADVISORS) {
      const entry = pack.advisors?.[advisor];
      if (!entry) continue;
      const out = {};
      for (const state of STATES) if (typeof entry[state] === 'string') out[state] = entry[state];
      if (entry.label) out.label = entry.label;
      if (Object.keys(out).length) clean.advisors[advisor] = out;
    }
    const buildings = {};
    for (const building of BUILDINGS) {
      if (typeof pack.buildings?.[building] === 'string') buildings[building] = pack.buildings[building];
    }
    if (Object.keys(buildings).length) clean.buildings = buildings;
    return clean;
  }

  let builtinCache = null;

  async function getBuiltinPacks() {
    if (builtinCache) return builtinCache;
    const loaded = {};
    for (const file of BUILTIN_FILES) {
      try {
        const pack = await (await fetch(chrome.runtime.getURL(file))).json();
        if (validatePack(pack).ok) loaded[pack.id] = { ...sanitizePack(pack), id: pack.id, builtin: true };
      } catch (err) {
        IkaDios.util?.warn('cannot load built-in pack', file, err);
      }
    }
    builtinCache = loaded;
    return loaded;
  }

  async function getPacks() {
    const [stored, builtin] = await Promise.all([chrome.storage.local.get(KEY_PACKS), getBuiltinPacks()]);
    return { [ORIGINAL_ID]: originalPack(), ...builtin, ...(stored[KEY_PACKS] || {}) };
  }

  async function savePack(pack) {
    const stored = await chrome.storage.local.get(KEY_PACKS);
    const packs = stored[KEY_PACKS] || {};
    packs[pack.id] = pack;
    await chrome.storage.local.set({ [KEY_PACKS]: packs });
  }

  async function deletePack(id) {
    if (id === ORIGINAL_ID) return;
    const stored = await chrome.storage.local.get([KEY_PACKS, KEY_ACTIVE]);
    const packs = stored[KEY_PACKS] || {};
    delete packs[id];
    const update = { [KEY_PACKS]: packs };
    if (stored[KEY_ACTIVE] === id) update[KEY_ACTIVE] = ORIGINAL_ID;
    await chrome.storage.local.set(update);
  }

  async function getActivePackId() {
    const stored = await chrome.storage.local.get(KEY_ACTIVE);
    return stored[KEY_ACTIVE] || ORIGINAL_ID;
  }

  async function setActivePackId(id) {
    await chrome.storage.local.set({ [KEY_ACTIVE]: id });
  }

  async function getActivePack() {
    const [packs, id] = await Promise.all([getPacks(), getActivePackId()]);
    return packs[id] || packs[ORIGINAL_ID];
  }

  IkaDios.packs = {
    FORMAT,
    FORMAT_VERSION,
    ADVISORS,
    STATES,
    BUILDINGS,
    FITS,
    ORIGINAL_ID,
    ALLOWED_MIME,
    KEY_PACKS,
    KEY_ACTIVE,
    originalPack,
    newPack,
    localized,
    validatePack,
    sanitizePack,
    getPacks,
    savePack,
    deletePack,
    getActivePackId,
    setActivePackId,
    getActivePack,
  };
})(typeof self !== 'undefined' ? self : window);

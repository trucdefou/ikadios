// Alliance bot from the game tab: whether it is configured (for the "Send to the
// alliance" share button) and automatic publishing of what the user chose in the
// options: new own spy reports, attack plans when created, player notes when saved.
// Spy reports already known when automatic publishing is switched on are not
// posted; only later ones (ids kept in alliancePublished:<world>, last 300).
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const KEY = 'allianceBot';
  const MAX_IDS = 300;
  const listeners = new Set();
  let config = {};

  const ready = () => !!(config.enabled && config.token && config.channelId);

  async function load() {
    if (!IkaDios.util.extensionAlive()) return;
    config = (await chrome.storage.local.get(KEY))[KEY] || {};
    for (const fn of listeners) fn(ready());
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  async function send(share) {
    if (!IkaDios.util.extensionAlive()) return { ok: false, error: 'context' };
    return chrome.runtime.sendMessage({ type: 'ikadios:allianceShare', share }).catch((err) => ({ ok: false, error: String(err) }));
  }

  // `kind`: 'autoPlans' | 'autoNotes'; `build` makes the share content
  async function maybe(kind, build) {
    if (!ready() || !config[kind]) return null;
    return send(await build());
  }

  // ---------- New spy reports ----------

  let publishing = false;

  async function publishNewSpyReports(snapshot) {
    if (!ready() || !config.autoSpy || publishing) return;
    const world = snapshot?.account?.world;
    if (!world) return;
    const own = Object.values(snapshot.espionage?.reports || {}).filter((r) => !r.sharedBy);
    if (!own.length) return;
    publishing = true;
    try {
      const key = `alliancePublished:${world}`;
      const stored = (await chrome.storage.local.get(key))[key];
      // First run: everything known so far counts as already published
      if (!stored) {
        await chrome.storage.local.set({ [key]: own.map((r) => r.id).slice(-MAX_IDS) });
        return;
      }
      const done = new Set(stored);
      const fresh = own.filter((r) => !done.has(r.id)).slice(0, 5);
      if (!fresh.length) return;
      const { t } = IkaDios.i18n;
      const player = snapshot.account?.playerName || '';
      const links = [];
      for (const r of fresh) {
        const url = await IkaDios.intelLink.build(world, 'spy', { report: r }, player).catch(() => null);
        if (url) links.push({ label: t('intelOpenSpy', { subject: r.subject || r.city }), url });
      }
      const fields = fresh.map((r) => ({
        name: `${r.subject || '-'}: ${r.city}${r.x != null ? ` [${r.x}:${r.y}]` : ''}`.slice(0, 256),
        value: [`${t('spyOwner')}: ${r.owner || '-'}`, `${t('spyResult')}: ${r.result || '-'}`, ...(r.lines || []).slice(0, 12)].join('\n').slice(0, 1024),
      }));
      const res = await send({ title: t('spyShareTitle', { player }), fields, links });
      if (res?.ok) {
        for (const r of fresh) done.add(r.id);
        await chrome.storage.local.set({ [key]: [...done].slice(-MAX_IDS) });
      }
    } finally {
      publishing = false;
    }
  }

  function init() {
    load();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEY]) load();
    });
    IkaDios.store.subscribe((snapshot) => publishNewSpyReports(snapshot).catch(() => {}));
  }

  IkaDios.allianceAuto = { init, ready, onChange, send, maybe };
})(typeof self !== 'undefined' ? self : window);

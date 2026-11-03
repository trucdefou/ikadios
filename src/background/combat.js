// Battle reports for sharing: the game's own report converter
// (view=militaryReportExport) returns the finished text in
// viewScriptParams.exportText, so the worker asks for it on request (a share
// click) and hands the plain text back. Texts are cached per combat for a few
// minutes, since a battle in progress changes with every round.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;

  const CACHE_MS = 5 * 60000;
  const MAX_TEXT = 6000;
  const cache = new Map();

  function exportText(actions) {
    const change = actions.find((a) => a[0] === 'changeView');
    for (const extra of change?.[1]?.slice?.(2) || []) {
      const text = extra?.viewScriptParams?.exportText;
      if (typeof text === 'string') return text;
    }
    return null;
  }

  async function combatExport(combatId) {
    if (!/^\d{1,12}$/.test(String(combatId))) return { ok: false, error: 'invalid' };
    const hit = cache.get(combatId);
    if (hit && Date.now() - hit.at < CACHE_MS) return { ok: true, text: hit.text };
    const engine = IkaDios.refreshEngine;
    const account = await engine.getAccount();
    if (!account?.world) return { ok: false, error: 'no-account' };
    const snapshot = await engine.loadSnapshot(account);
    const params = { view: 'militaryReportExport', combatId, templateView: 'militaryAdvisorCombatList', currentTab: 'tab_militaryAdvisorCombatList' };
    const current = snapshot.global?.selectedCityId;
    if (current) Object.assign(params, { backgroundView: 'city', currentCityId: current });
    const res = await engine.requestAndStore(account, params);
    if (!res.ok) return { ok: false, error: res.error };
    const text = exportText(res.actions);
    if (!text) return { ok: false, error: 'no-text' };
    const clean = text.replace(/\r/g, '').trim().slice(0, MAX_TEXT);
    cache.set(combatId, { text: clean, at: Date.now() });
    return { ok: true, text: clean };
  }

  // ---------- Rounds: the detailed report, one view per round ----------

  // view=militaryAdvisorDetailedReportView&combatRound=N: the worker has no DOM,
  // so it hands the report element of each page to the tab, which parses it
  // (src/shared/battle-rounds.js). Read only, with short pauses like a player
  // paging through the report.
  const MAX_ROUNDS = 40;
  const ROUND_PAUSE_MS = [700, 1500];
  const roundCache = new Map();

  function detailHtml(actions) {
    const change = actions.find((a) => a[0] === 'changeView');
    const html = typeof change?.[1]?.[1] === 'string' ? change[1][1] : '';
    const start = html.indexOf('<div id="militaryAdvisorDetailedReportView"');
    if (start < 0) return null;
    return html.slice(start).replace(/<script[\s\S]*?<\/script>/gi, '');
  }

  // Highest round the page links to (the arrows to the last round)
  const lastRound = (html) => Math.max(1, ...[...html.matchAll(/combatRound=(\d+)/g)].map((m) => Number(m[1])));

  async function combatRounds(combatId) {
    if (!/^\d{1,12}$/.test(String(combatId))) return { ok: false, error: 'invalid' };
    const hit = roundCache.get(combatId);
    if (hit && Date.now() - hit.at < CACHE_MS) return { ok: true, pages: hit.pages, total: hit.total };
    const engine = IkaDios.refreshEngine;
    const account = await engine.getAccount();
    if (!account?.world) return { ok: false, error: 'no-account' };
    const snapshot = await engine.loadSnapshot(account);
    const current = snapshot.global?.selectedCityId;
    const pages = [];
    let total = 1;
    for (let round = 1; round <= Math.min(total, MAX_ROUNDS); round += 1) {
      if (round > 1) await new Promise((r) => setTimeout(r, ROUND_PAUSE_MS[0] + Math.random() * (ROUND_PAUSE_MS[1] - ROUND_PAUSE_MS[0])));
      const params = { view: 'militaryAdvisorDetailedReportView', combatRound: round, detailedCombatId: combatId, activeTab: 'combatReports', templateView: 'militaryAdvisorReportView' };
      if (current) Object.assign(params, { backgroundView: 'city', currentCityId: current });
      const res = await engine.fetchView(account, params);
      if (!res.ok) {
        if (!pages.length) return { ok: false, error: res.error };
        break;
      }
      const html = detailHtml(res.actions);
      if (!html) {
        if (!pages.length) return { ok: false, error: 'no-rounds' };
        break;
      }
      if (round === 1) total = lastRound(html);
      pages.push(html);
    }
    roundCache.set(combatId, { pages, total, at: Date.now() });
    return { ok: true, pages, total };
  }

  const HANDLERS = { 'ikadios:combatExport': combatExport, 'ikadios:combatRounds': combatRounds };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const handler = HANDLERS[msg?.type];
    if (!handler || sender.id !== chrome.runtime.id) return undefined;
    handler(String(msg.combatId))
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  });

  IkaDios.combat = { combatExport, combatRounds, exportText, detailHtml, lastRound };
})(self);

// Applies a decoded shared item (src/shared/intel-link.js) to this player's data.
// Used by the game tab (a link opened by hand, after confirming) and by the
// worker (alliance bot channel). What another player shares never overwrites the
// user's own data: shared player notes are kept apart from the own note, shared
// spy reports and battles are marked with who sent them.
// ctx: { world, updateSnapshot(fn) } where fn(snapshot) returns the next snapshot.
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});

  const MAX_BATTLES = 10;
  const MAX_PLANS = 20;
  const MAX_SHARED_NOTES = 10;
  const PLAN_KEEP_MS = 24 * 3600000;

  // Short stable id from a text (dedupe of the same item received twice)
  function hashId(value) {
    let h = 2166136261;
    for (const ch of String(value)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    return h.toString(36);
  }

  const lower = (s) => String(s || '').toLowerCase();

  async function getList(key) {
    return (await chrome.storage.local.get(key))[key];
  }

  // Rounds by number, a newer copy of a round replacing the older one
  function mergeRounds(current, incoming) {
    const byNumber = new Map((current || []).map((r) => [r.n, r]));
    for (const r of incoming || []) byNumber.set(r.n, r);
    return [...byNumber.values()].sort((a, b) => a.n - b.n);
  }

  async function applyBattle(item, ctx) {
    const key = `battleImports:${ctx.world}`;
    const list = (await getList(key)) || [];
    const id = `sh_${hashId(item.data.text)}`;
    const rounds = item.data.rounds || [];
    // Long battles arrive in several links with the same text: their rounds are
    // merged into the entry the first one created
    const existing = list.find((x) => x.id === id);
    if (existing) {
      const merged = mergeRounds(existing.rounds, rounds);
      if (merged.length === (existing.rounds || []).length) return { added: false };
      existing.rounds = merged;
      await chrome.storage.local.set({ [key]: list });
      return { added: true };
    }
    const report = IkaDios.battleReport.parse(item.data.text);
    if (!report) return { added: false };
    const entry = { id, title: report.title, date: report.date, text: item.data.text, importedAt: Date.now(), from: item.from };
    if (rounds.length) entry.rounds = mergeRounds([], rounds);
    list.unshift(entry);
    await chrome.storage.local.set({ [key]: list.slice(0, MAX_BATTLES) });
    return { added: true };
  }

  async function applySpy(item, ctx) {
    const r = item.data.report;
    const id = `sh_${hashId(`${r.owner}|${r.subject}|${r.date || r.dateText}|${r.x}:${r.y}`)}`;
    let added = false;
    await ctx.updateSnapshot((snapshot) => {
      const reports = { ...(snapshot.espionage?.reports || {}) };
      if (reports[id]) return snapshot;
      added = true;
      reports[id] = { ...r, id, sharedBy: item.from, seenAt: Date.now() };
      return { ...snapshot, espionage: { ...(snapshot.espionage || {}), reports } };
    });
    return { added };
  }

  async function applyPlayer(item, ctx) {
    const key = `playerNotes:${ctx.world}`;
    const notes = (await getList(key)) || {};
    const name = item.data.name;
    const entry = notes[lower(name)] || { name };
    const shared = (entry.shared || []).filter((s) => lower(s.from) !== lower(item.from));
    shared.unshift({ from: item.from, tag: item.data.tag, note: item.data.note, at: item.at || Date.now() });
    notes[lower(name)] = { ...entry, name: entry.name || name, shared: shared.slice(0, MAX_SHARED_NOTES) };
    await chrome.storage.local.set({ [key]: notes });
    return { added: true };
  }

  async function applyPlan(item, ctx) {
    const key = `attackPlans:${ctx.world}`;
    const now = Date.now();
    const all = (await getList(key)) || [];
    const previous = all.find((p) => p.id === item.data.id);
    const plans = all.filter((p) => p.arriveAt + PLAN_KEEP_MS > now && p.id !== item.data.id);
    // A plan received again (edited) keeps the confirmations already known
    plans.unshift({ ...item.data, from: item.from, importedAt: now, confirmations: previous?.confirmations || {} });
    await chrome.storage.local.set({ [key]: plans.slice(0, MAX_PLANS) });
    return { added: true };
  }

  // ---------- Alliance coordination ----------

  const REQUEST_KEEP_MS = 3 * 24 * 3600000;
  const MAX_REQUESTS = 30;
  const requestsKey = (world) => `allianceRequests:${world}`;

  async function applyRequest(item, ctx) {
    const key = requestsKey(ctx.world);
    const now = Date.now();
    const list = ((await getList(key)) || []).filter((r) => (r.at || 0) + REQUEST_KEEP_MS > now);
    if (list.some((r) => r.id === item.data.id && lower(r.from) === lower(item.from))) return { added: false };
    list.unshift({ ...item.data, from: item.from, at: item.at || now, claims: {}, status: 'open' });
    await chrome.storage.local.set({ [key]: list.slice(0, MAX_REQUESTS) });
    return { added: true };
  }

  // claim / cancel by a helper; done by the requester closes the request
  async function applyClaim(item, ctx) {
    const key = requestsKey(ctx.world);
    const list = (await getList(key)) || [];
    const request = list.find((r) => r.id === item.data.requestId);
    if (!request) return { added: false };
    const who = item.from || '?';
    if (item.data.status === 'done') {
      if (lower(who) !== lower(request.from)) return { added: false };
      request.status = 'done';
    } else if (item.data.status === 'cancel') {
      delete request.claims[who];
    } else {
      request.claims = { ...(request.claims || {}), [who]: { at: item.at || Date.now() } };
    }
    await chrome.storage.local.set({ [key]: list });
    return { added: true };
  }

  async function applyConfirm(item, ctx) {
    const key = `attackPlans:${ctx.world}`;
    const plans = (await getList(key)) || [];
    const plan = plans.find((p) => p.id === item.data.planId);
    if (!plan) return { added: false };
    plan.confirmations = { ...(plan.confirmations || {}), [item.from || '?']: { status: item.data.status, city: item.data.city, leaveAt: item.data.leaveAt, at: item.at || Date.now() } };
    await chrome.storage.local.set({ [key]: plans });
    return { added: true };
  }

  async function applyStatus(item, ctx) {
    const key = `allianceMembers:${ctx.world}`;
    const members = (await getList(key)) || {};
    members[item.from || '?'] = { ...item.data, at: item.at || Date.now() };
    await chrome.storage.local.set({ [key]: members });
    return { added: true };
  }

  const APPLY = { battle: applyBattle, spy: applySpy, player: applyPlayer, plan: applyPlan, request: applyRequest, claim: applyClaim, confirm: applyConfirm, status: applyStatus };

  async function apply(item, ctx) {
    const fn = APPLY[item?.kind];
    return fn ? fn(item, ctx) : { added: false };
  }

  IkaDios.intelApply = { apply, hashId, PLAN_KEEP_MS, REQUEST_KEEP_MS };
})(typeof self !== 'undefined' ? self : window);

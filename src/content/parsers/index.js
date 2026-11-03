// Parser registry and dispatcher. Parsers are pure functions:
//   (payload, ctx) => patch | (snapshot => snapshot) | null
// ctx = { snapshot, view, avatarId }; ctx.snapshot is a getter that always
// returns the latest state, because each patch is applied as soon as it exists.
// They must never rely on visible text, only on ids, CSS classes, view names and
// JSON fields, so they work on every national server.
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});
  const { warn } = IkaDios.util;

  const actionParsers = new Map();
  const viewParsers = new Map();
  const modelParsers = [];

  function registerAction(name, fn) {
    if (!actionParsers.has(name)) actionParsers.set(name, []);
    actionParsers.get(name).push(fn);
  }

  function registerView(name, fn) {
    if (!viewParsers.has(name)) viewParsers.set(name, []);
    viewParsers.get(name).push(fn);
  }

  function registerModel(fn) {
    modelParsers.push(fn);
  }

  function safeRun(fn, payload, ctx, label) {
    try {
      return fn(payload, ctx);
    } catch (err) {
      warn(`parser failed: ${label}`, err);
      return null;
    }
  }

  // The view of an AJAX batch comes from its changeView action or the request params
  function requestParams(meta = {}) {
    const params = new URLSearchParams(`${meta.body || ''}&${(meta.url || '').split('?')[1] || ''}`);
    return Object.fromEntries([...params].filter(([k]) => k !== 'actionRequest'));
  }

  function detectView(actions, meta = {}) {
    const change = actions.find((a) => a[0] === 'changeView');
    if (change && Array.isArray(change[1]) && typeof change[1][0] === 'string') return change[1][0];
    return requestParams(meta).view || null;
  }

  // Runs every matching parser for an AJAX batch, handing each patch to `apply`
  function parseAjax(actions, ctx, apply, meta = {}) {
    const view = detectView(actions, meta);
    const localCtx = Object.create(ctx, { view: { value: view }, params: { value: requestParams(meta) } });
    let count = 0;
    const run = (fn, payload, label) => {
      const patch = safeRun(fn, payload, localCtx, label);
      if (patch) {
        apply(patch);
        count += 1;
      }
    };
    for (const [name, payload] of actions) {
      for (const fn of actionParsers.get(name) || []) run(fn, payload, name);
      if (name === 'changeView' && view) {
        const viewPayload = { html: payload?.[1], extra: payload?.slice(2), actions };
        for (const fn of viewParsers.get(view) || []) run(fn, viewPayload, `view:${view}`);
      }
    }
    return { view, count };
  }

  function parseModel(model, ctx, apply) {
    for (const fn of modelParsers) {
      const patch = safeRun(fn, model, ctx, 'model');
      if (patch) apply(patch);
    }
  }

  // Parses an HTML fragment without executing scripts or loading images
  function parseHtml(html) {
    return new DOMParser().parseFromString(String(html || ''), 'text/html');
  }

  IkaDios.parsers = { registerAction, registerView, registerModel, detectView, parseAjax, parseModel, parseHtml };
})(typeof self !== 'undefined' ? self : window);

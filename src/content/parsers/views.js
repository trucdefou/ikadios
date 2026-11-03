// Records when each refreshable view was last captured while the user browses,
// so "Refresh all" can start with what is missing or oldest.
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});
  const { registerAction } = IkaDios.parsers;

  registerAction('changeView', (payload, ctx) => {
    const key = IkaDios.refreshPlan?.keyForView(ctx.view, ctx.snapshot?.global?.selectedCityId);
    return key ? { viewsUpdatedAt: { [key]: Date.now() } } : null;
  });
})(typeof self !== 'undefined' ? self : window);

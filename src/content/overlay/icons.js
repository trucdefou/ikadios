// Small inline SVG icons for overlay buttons (16x16 paths drawn with the text
// color) and a helper for icon-only buttons, which carry their label as title
// and aria-label.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { el } = IkaDios.util;
  const NS = 'http://www.w3.org/2000/svg';

  const ICONS = {
    up: { stroke: 'M4 10 8 6 12 10' },
    down: { stroke: 'M4 6 8 10 12 6' },
    prev: { stroke: 'M10 4 6 8 10 12' },
    next: { stroke: 'M6 4 10 8 6 12' },
    pause: { fill: 'M4 3h3v10H4zM9 3h3v10H9z' },
    resume: { fill: 'M5 3l8 5-8 5z' },
    retry: { stroke: 'M13 8a5 5 0 1 1-1.5-3.5M12 1.5V5H8.5' },
    remove: { stroke: 'M4 4l8 8M12 4l-8 8' },
    runNow: { fill: 'M2 3l6 5-6 5zM8 3l6 5-6 5z' },
    edit: { stroke: 'M3 13l1-4 7-7 3 3-7 7zM9 4l3 3' },
    download: { stroke: 'M8 2v8M4 7l4 4 4-4M3 14h10' },
    send: { stroke: 'M2 8l12-6-4 12-2-5zM8 9l6-7' },
    erase: { stroke: 'M6 14h8M2 10l7-7 5 5-4 4H6z' },
    trash: { stroke: 'M3 4h10M6 4V2h4v2M4 4l1 10h6l1-10' },
  };

  function svg(name) {
    const def = ICONS[name];
    const node = document.createElementNS(NS, 'svg');
    node.setAttribute('viewBox', '0 0 16 16');
    node.setAttribute('width', '14');
    node.setAttribute('height', '14');
    node.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', def.fill || def.stroke);
    if (def.fill) path.setAttribute('fill', 'currentColor');
    else {
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
    }
    node.append(path);
    return node;
  }

  function button(name, label, onclick, { disabled = false } = {}) {
    return el('button', { class: 'icon act', title: label, 'aria-label': label, disabled: disabled ? true : null, onclick }, svg(name));
  }

  IkaDios.icons = { svg, button };
})(typeof self !== 'undefined' ? self : window);

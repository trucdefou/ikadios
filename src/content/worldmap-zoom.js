// Zoom out on the game's own world map (view=worldmap_iso), visual only.
// The game keeps a fixed pool of N x N isometric tiles (#worldmap > #map1 >
// div#tile_i_j, N = 23) around the view and repaints them while dragging, so the
// map is scaled with a CSS transform and the smallest scale is the one at which
// that tile diamond still covers the visible area. No request is sent.
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});

  const STEP = 0.1;
  // Extra room: the view drifts off the pool center while dragging until the
  // game repaints the tiles around the new position
  const COVER_MARGIN = 1.1;
  const CHECK_MS = 1000;
  const CONTROLS_ID = 'ikadios-worldmap-zoom';

  let scale = 1;
  let bound = null; // { map, observer, controls }

  const t = (key) => IkaDios.i18n?.t?.(key) || key;

  function viewport(map) {
    const parent = map.offsetParent || map.parentElement;
    return parent && parent.clientWidth ? parent : document.documentElement;
  }

  // Diamond of N x N tiles of w x h: N * w wide and N * h tall
  function minScale(map) {
    const tiles = map.querySelectorAll('[id^="tile_"]');
    const n = Math.round(Math.sqrt(tiles.length)) || 23;
    const w = tiles[0]?.offsetWidth || 240;
    const h = tiles[0]?.offsetHeight || 120;
    const vp = viewport(map);
    // A centered rectangle W x H fits in the diamond when W / width + H / height <= 1
    const needed = COVER_MARGIN * (vp.clientWidth / (n * w) + vp.clientHeight / (n * h));
    return Math.min(1, Math.max(0.2, needed));
  }

  function clamp(value, map) {
    return Math.min(1, Math.max(minScale(map), Math.round(value * 100) / 100));
  }

  function setStyle(el, prop, value) {
    if (el.style.getPropertyValue(prop) !== value) el.style.setProperty(prop, value);
  }

  // Scale around the middle of the viewport. The game moves the map through its
  // left / top, so the origin is recomputed in map coordinates after each move.
  function apply() {
    if (!bound) return;
    const { map } = bound;
    scale = clamp(scale, map);
    if (scale === 1) {
      setStyle(map, 'transform', '');
      setStyle(map, 'transform-origin', '');
    } else {
      const vp = viewport(map);
      const ox = vp.clientWidth / 2 - map.offsetLeft;
      const oy = vp.clientHeight / 2 - map.offsetTop;
      setStyle(map, 'transform-origin', `${Math.round(ox)}px ${Math.round(oy)}px`);
      setStyle(map, 'transform', `scale(${scale})`);
    }
    // Keeps the coordinate labels (hook.js) readable when zoomed out
    setStyle(map, '--ikadios-label-scale', String(Math.round((1 / scale) * 100) / 100));
    const value = bound.controls?.querySelector('[data-zoom="reset"]');
    if (value) value.textContent = `${Math.round(scale * 100)} %`;
  }

  function zoomBy(delta) {
    scale += delta;
    apply();
  }

  function button(kind, text, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.zoom = kind;
    b.textContent = text;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  function createControls() {
    const box = document.createElement('div');
    box.id = CONTROLS_ID;
    Object.assign(box.style, {
      position: 'fixed',
      left: '12px',
      bottom: '60px',
      zIndex: '100000',
      display: 'flex',
      gap: '2px',
      font: 'bold 12px Arial, sans-serif',
    });
    const reset = button('reset', '100 %', t('worldmapZoomReset'), () => {
      scale = 1;
      apply();
    });
    box.append(button('out', '-', t('worldmapZoomOut'), () => zoomBy(-STEP)), reset, button('in', '+', t('worldmapZoomIn'), () => zoomBy(STEP)));
    for (const b of box.children) {
      Object.assign(b.style, {
        minWidth: '28px',
        height: '24px',
        padding: '0 6px',
        border: '1px solid #542c0f',
        borderRadius: '3px',
        background: '#f5e7c8',
        color: '#542c0f',
        cursor: 'pointer',
        font: 'inherit',
      });
    }
    document.body.appendChild(box);
    return box;
  }

  function onWheel(e) {
    if (!bound || !bound.map.isConnected) return;
    // Only over the map itself, never over the overlay or game windows
    if (!e.composedPath().includes(bound.map)) return;
    e.preventDefault();
    e.stopPropagation();
    zoomBy(e.deltaY > 0 ? -STEP : STEP);
  }

  function bind(map) {
    const observer = new MutationObserver(apply);
    observer.observe(map, { attributes: true, attributeFilter: ['style'] });
    const vp = viewport(map);
    vp.addEventListener('wheel', onWheel, { passive: false, capture: true });
    bound = { map, observer, vp, controls: createControls() };
    apply();
  }

  function unbind() {
    if (!bound) return;
    bound.observer.disconnect();
    bound.vp.removeEventListener('wheel', onWheel, { capture: true });
    bound.controls?.remove();
    bound = null;
  }

  // The world map can come and go through the game's AJAX navigation
  function check() {
    const map = document.getElementById('worldmap');
    if (bound && bound.map !== map) unbind();
    if (map && !bound && document.body) bind(map);
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    setInterval(check, CHECK_MS);
    window.addEventListener('resize', apply);
  }

  IkaDios.worldmapZoom = { minScale, apply };
})(typeof self !== 'undefined' ? self : window);

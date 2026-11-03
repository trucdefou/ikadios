// Copies the look of the game's own windows into the overlay. A hidden probe
// with the game's window markup is added inside the game container, its computed
// styles are read (backgrounds, images, fonts, colors, sizes) and turned into CSS
// for the overlay's Shadow DOM. Asset URLs come out absolute, so they load as-is.
// If the probe finds no styled header (markup changed), the overlay keeps its own CSS.
// The markup guesses are confirmed with the probe report saved to debug captures.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;

  const PROBE_HTML = `
    <div class="mainHeader"><h3 class="header"><span data-probe="title">IkaDios</span><div class="close" data-probe="close"></div></h3></div>
    <div class="mainContent" data-probe="content">
      <div class="buildingDescription"><h1 data-probe="h1">IkaDios</h1></div>
      <table class="table01 border left" data-probe="table">
        <tr><th data-probe="th">x</th></tr>
        <tr><td data-probe="td">x</td></tr>
        <tr class="alt"><td data-probe="tdAlt">x</td></tr>
      </table>
      <a class="button" href="#" data-probe="button">x</a>
    </div>
    <div class="footer" data-probe="footer"></div>`;

  const BOX_PROPS = [
    'background-color',
    'background-image',
    'background-repeat',
    'background-position',
    'background-size',
    'color',
    'font-family',
    'font-size',
    'font-weight',
    'line-height',
    'text-align',
    'text-shadow',
    'height',
    'min-height',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'border-top',
    'border-right',
    'border-bottom',
    'border-left',
    'border-radius',
  ];

  // Fixed-width window art (header 728x26, footer 728x5) is drawn as a 3-slice
  // border-image so the rounded ends survive any panel width
  const CAP_PX = 8;
  // window_control_sprite.png: 18px cells, top row normal, bottom row hover
  const SPRITE_CELL = 18;
  const SPRITE_CLOSE_X = 0;
  const SPRITE_MIN_X = -144;

  // probe part, overlay selector, properties to copy (generic parts only)
  const MAPPINGS = [
    ['header', '.bar', ['color', 'font-family', 'font-size']],
    ['title', '.title', ['color', 'font-family', 'font-size', 'font-weight', 'text-shadow']],
    ['content', '.body', ['background-color', 'background-image', 'background-repeat', 'background-position', 'color', 'font-family', 'font-size']],
    ['h1', '.section-title', ['color', 'font-family', 'font-size', 'font-weight']],
    ['th', '.grid th', BOX_PROPS],
    ['td', '.grid td', ['color', 'font-family', 'font-size', 'border-top', 'border-right', 'border-bottom', 'border-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left']],
    ['td', '.grid tbody tr:nth-child(odd)', ['background-color', 'background-image']],
    ['tdAlt', '.grid tbody tr:nth-child(even)', ['background-color', 'background-image']],
    // The game sizes buttons with content-box; copy that so text is not clipped
    ['button', '.refresh', BOX_PROPS.filter((prop) => prop !== 'height' && prop !== 'min-height')],
  ];

  // Values that mean "nothing set" and must not override the overlay's defaults
  function isEmpty(prop, value) {
    if (!value) return true;
    if (prop === 'background-image') return value === 'none';
    if (prop === 'background-color') return value === 'rgba(0, 0, 0, 0)' || value === 'transparent';
    if (prop.startsWith('border-') && prop !== 'border-radius') return /^0px\b/.test(value) || / none\b/.test(value);
    if (prop === 'text-shadow' || prop === 'box-shadow') return value === 'none';
    if (prop === 'height' || prop === 'min-height' || prop === 'width') return value === 'auto' || value === '0px';
    return false;
  }

  function findHost() {
    return document.getElementById('container') || document.body;
  }

  function measure() {
    const host = findHost();
    if (!host) return null;
    const probe = document.createElement('div');
    probe.className = 'templateView mainContentBox contentBox01h';
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute!important;left:-10000px!important;top:0!important;width:720px!important;visibility:hidden!important;pointer-events:none!important;';
    probe.innerHTML = PROBE_HTML;
    host.append(probe);
    try {
      const parts = { box: probe, header: probe.querySelector('.mainHeader') };
      for (const node of probe.querySelectorAll('[data-probe]')) parts[node.dataset.probe] = node;
      const values = {};
      const frameParts = [
        ['header', ['background-image']],
        ['close', ['background-image']],
        ['box', ['background-image', 'box-shadow']],
        ['footer', ['background-image']],
      ];
      for (const [part, props] of frameParts) {
        const cs = getComputedStyle(parts[part]);
        values[part] = {};
        for (const prop of props) values[part][prop] = cs.getPropertyValue(prop);
      }
      for (const [part, , props] of MAPPINGS) {
        const node = parts[part];
        if (!node) continue;
        const cs = getComputedStyle(node);
        values[part] = values[part] || {};
        for (const prop of props) values[part][prop] = cs.getPropertyValue(prop);
      }
      return values;
    } finally {
      probe.remove();
    }
  }

  function urlOf(cssValue) {
    return !cssValue || cssValue === 'none' ? null : cssValue;
  }

  // Window frame, title bar, buttons and footer from the measured image URLs
  function frameCss(values) {
    const rules = [];
    const header = urlOf(values.header?.['background-image']);
    const side = urlOf(values.box?.['background-image']);
    const footer = urlOf(values.footer?.['background-image']);
    const sprite = urlOf(values.close?.['background-image']);
    const content = urlOf(values.content?.['background-image']);
    const shadow = values.box?.['box-shadow'];

    rules.push(`.panel {
  border: 0 !important;
  outline: 0 !important;
  border-radius: 0 !important;
  padding: 0 6px !important;
  background: ${[side && `${side} left top repeat-y`, side && `${side} right top repeat-y`, content || null, 'var(--parchment)'].filter(Boolean).join(', ')} !important;
  ${shadow && shadow !== 'none' ? `box-shadow: ${shadow} !important;` : ''}
}`);
    if (header) {
      rules.push(`.bar {
  margin: 0 -6px !important;
  height: 26px !important;
  padding: 0 ${CAP_PX + 4}px !important;
  background: none !important;
  border-style: solid !important;
  border-width: 0 ${CAP_PX}px !important;
  border-image: ${header} 0 ${CAP_PX} fill / 0 ${CAP_PX}px stretch !important;
  text-shadow: none !important;
}`);
      rules.push('.title { position: absolute; left: 0; right: 0; text-align: center; pointer-events: none; }');
      rules.push('.bar { position: relative; }');
      rules.push('.bar .account { position: relative; color: inherit !important; opacity: 0.75; font-size: 11px; }');
    }
    if (footer) {
      rules.push(`.foot {
  margin: 0 -6px !important;
  height: 5px !important;
  border-style: solid !important;
  border-width: 0 ${CAP_PX}px !important;
  border-image: ${footer} 0 ${CAP_PX} fill / 0 ${CAP_PX}px stretch !important;
}`);
    }
    if (sprite) {
      const button = (selector, x) => `${selector} {
  position: relative;
  width: ${SPRITE_CELL}px !important;
  height: ${SPRITE_CELL}px !important;
  padding: 0 !important;
  border: 0 !important;
  border-radius: 0 !important;
  background: ${sprite} ${x}px 0 no-repeat !important;
  color: transparent !important;
  font-size: 0 !important;
}
${selector}:hover, ${selector}:focus-visible { background-position: ${x}px -${SPRITE_CELL}px !important; }`;
      rules.push(button('.icon.close', SPRITE_CLOSE_X), button('.icon.min', SPRITE_MIN_X));
    }
    return rules.join('\n');
  }

  function toCss(values) {
    const rules = [frameCss(values)];
    for (const [part, selector, props] of MAPPINGS) {
      const decls = props
        .filter((prop) => !isEmpty(prop, values[part]?.[prop]))
        .map((prop) => `  ${prop}: ${values[part][prop]} !important;`);
      if (decls.length) rules.push(`${selector} {\n${decls.join('\n')}\n}`);
    }
    return rules.join('\n');
  }

  // Applied only when the probe proves the game's window CSS matched
  function looksStyled(values) {
    const header = values.header || {};
    return !isEmpty('background-image', header['background-image']) || !isEmpty('background-color', header['background-color']);
  }

  let cached = null;

  function build() {
    const values = measure();
    if (!values) return { applied: false, css: '', values: null };
    const applied = looksStyled(values);
    cached = { applied, css: applied ? toCss(values) : '', values };
    return cached;
  }

  // Report for calibrating the probe markup: what matched, plus the real window
  // header markup if a game window happens to be open
  function report() {
    const live = document.querySelector('.mainContentBox .mainHeader, .templateView .mainHeader');
    return {
      applied: cached?.applied ?? null,
      values: cached?.values ?? null,
      liveHeader: live ? live.outerHTML.slice(0, 2000) : null,
      liveWindow: live?.closest('.templateView, .mainContentBox')?.className || null,
      stylesheets: [...document.styleSheets].map((s) => s.href).filter(Boolean).slice(0, 20),
    };
  }

  IkaDios.gameSkin = { build, report };
})(typeof self !== 'undefined' ? self : window);

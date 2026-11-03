// Applies the active advisor pack by injecting a <style> into the game page.
// Each advisor <a> carries a state class (normal, normalactive, premium,
// premiumactive, plus *alert for the military advisor under attack).
// Confirm the class names with phase-0 captures.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const packs = IkaDios.packs;

  const STYLE_ID = 'ikadios-advisor-skin';

  const ADVISOR_DOM = {
    cities: 'advCities',
    military: 'advMilitary',
    research: 'advResearch',
    diplomacy: 'advDiplomacy',
  };

  // Selector suffixes per state, and the order in which missing images fall back.
  // Only the advisor link carries these state classes; the premium "+" button
  // (a.pluslink / a.plusteaser) in the same <li> keeps its original image.
  const STATE_SELECTORS = {
    normal: ['a.normal'],
    active: ['a.normalactive'],
    alert: ['a.normalalert'],
    premium: ['a.premium'],
    premiumActive: ['a.premiumactive'],
    premiumAlert: ['a.premiumalert'],
  };
  const FALLBACKS = {
    normal: ['normal'],
    active: ['active', 'normal'],
    alert: ['alert', 'active', 'normal'],
    premium: ['premium', 'normal'],
    premiumActive: ['premiumActive', 'active', 'premium', 'normal'],
    premiumAlert: ['premiumAlert', 'premiumActive', 'alert', 'active', 'premium', 'normal'],
  };

  function cssString(value) {
    return `"${String(value).replace(/["\\\n\r]/g, (c) => (c === '\n' || c === '\r' ? ' ' : `\\${c}`))}"`;
  }

  function buildCss(pack, locale) {
    const rules = [];
    for (const advisor of packs.ADVISORS) {
      const entry = pack?.advisors?.[advisor];
      if (!entry) continue;
      const domId = ADVISOR_DOM[advisor];
      for (const state of packs.STATES) {
        const source = FALLBACKS[state].map((s) => entry[s]).find(Boolean);
        if (!source) continue;
        const selectors = STATE_SELECTORS[state].map((s) => `#advisors #${domId} ${s}`).join(',\n');
        rules.push(`${selectors} {
  background-image: url(${cssString(source)}) !important;
  background-size: ${pack.fit === 'fill' ? '100% 100%' : 'contain'} !important;
  background-position: center !important;
  background-repeat: no-repeat !important;${pack.pixelated ? '\n  image-rendering: pixelated !important;' : ''}
}`);
      }
      const label = packs.localized(entry.label, locale);
      if (label) {
        rules.push(`#advisors #${domId} .textLabel { font-size: 0 !important; }
#advisors #${domId} .textLabel::after { content: ${cssString(label)}; font-size: 11px; }`);
      }
    }
    return rules.join('\n');
  }

  function ensureStyle() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      (document.head || document.documentElement).append(style);
    }
    return style;
  }

  async function apply() {
    const pack = await packs.getActivePack();
    const css = buildCss(pack, IkaDios.i18n.locale);
    if (!css) {
      document.getElementById(STYLE_ID)?.remove();
      return;
    }
    ensureStyle().textContent = css;
  }

  function init() {
    apply();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes[packs.KEY_PACKS] || changes[packs.KEY_ACTIVE])) apply();
    });
    IkaDios.i18n.onChange(apply);
    // Keep the style last in <head> if the game appends stylesheets later
    const observer = new MutationObserver(() => {
      const style = document.getElementById(STYLE_ID);
      if (style && style.nextElementSibling) style.parentNode.append(style);
    });
    if (document.head) observer.observe(document.head, { childList: true });
  }

  IkaDios.advisorsSkin = { init, apply, buildCss, ADVISOR_DOM };
})(typeof self !== 'undefined' ? self : window);

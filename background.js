// Background: keyboard command routing, the refresh engine and automations.
// Chrome and Brave run it as a service worker that loads its dependencies with
// importScripts; Firefox runs it as an event page and loads the same files from
// `background.scripts` in manifest.json (keep both lists in the same order).

if (typeof importScripts === 'function') importScripts(
  'src/shared/util.js',
  'src/shared/i18n.js',
  'src/shared/schema.js',
  'src/content/parsers/index.js',
  'src/content/parsers/global.js',
  'src/content/parsers/city.js',
  'src/content/parsers/upgrade.js',
  'src/content/parsers/views.js',
  'src/content/parsers/views-data.js',
  'src/content/parsers/world.js',
  'src/content/facets/index.js',
  'src/shared/refresh-plan.js',
  'src/shared/discord-events.js',
  'src/shared/capture-filter.js',
  'src/shared/trade-link.js',
  'src/shared/map-share.js',
  'src/shared/battle-report.js',
  'src/shared/battle-rounds.js',
  'src/shared/intel-link.js',
  'src/shared/intel-apply.js',
  'src/shared/automation-plan.js',
  'src/background/idb.js',
  'src/background/captures.js',
  'src/background/notify.js',
  'src/background/refresh-engine.js',
  'src/background/discord.js',
  'src/background/ikamap.js',
  'src/background/automation.js',
  'src/background/combat.js',
  'src/background/alliance.js'
);

const GAME_URL_PATTERN = 'https://*.ikariam.gameforge.com/*';

async function activeGameTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true, url: GAME_URL_PATTERN });
  return tab || null;
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-overlay') return;
  const tab = await activeGameTab();
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: 'ikadios:toggleOverlay' }).catch(() => {});
});

self.IkaDios.captures.migrateLegacy();
self.IkaDios.refreshEngine.init();
self.IkaDios.discord.init();
self.IkaDios.automation.init();
self.IkaDios.alliance.init();

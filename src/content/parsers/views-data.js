// Parsers for building and advisor views. Most data comes from the structured
// "updateTemplateData" action ({elementId: value | {text, class, ...}}); tables that
// are only rendered as HTML (troops, finances) are read with DOMParser, so these
// parsers run in the game tab and in the offscreen document, not in the worker.
// Field names were taken from real captures (s72-es, 2026-10-29).
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});
  const { toNumber } = IkaDios.util;
  const { registerAction, registerView, parseHtml } = IkaDios.parsers;

  // Value of a template entry: plain value or its .text
  function tv(tpl, key) {
    const v = tpl?.[key];
    if (v === null || v === undefined) return null;
    return typeof v === 'object' && !Array.isArray(v) ? (v.text ?? null) : v;
  }

  const tn = (tpl, key) => toNumber(tv(tpl, key), null);

  // City a city-scoped view belongs to: request params first, then the city the
  // header of the same response selected
  function cityOf(ctx) {
    return String(ctx.params?.cityId || ctx.params?.currentCityId || ctx.snapshot?.global?.selectedCityId || '') || null;
  }

  function cityPatch(cityId, data) {
    return cityId ? { cities: { [cityId]: { id: cityId, ...data } } } : null;
  }

  // ---------- Town hall: population, happiness, corruption, action points ----------

  function townHall(tpl, ctx) {
    if (!('js_TownHallOccupiedSpace' in tpl)) return null;
    const happinessClass = String(tpl.js_TownHallHappinessLarge?.class || '');
    const bonus = (key) => toNumber(tv(tpl, `js_TownHallSatisfactionOverview${key}Value`), 0);
    return cityPatch(cityOf(ctx), {
      townHall: {
        population: tn(tpl, 'js_TownHallOccupiedSpace'),
        maxInhabitants: tn(tpl, 'js_TownHallMaxInhabitants'),
        citizens: toNumber(tpl.CitizenCount, null),
        woodWorkers: toNumber(tpl.ResourceWorkerCount, null),
        luxuryWorkers: toNumber(tpl.SpecialWorkerCount, null),
        scientists: toNumber(tpl.ScientistCount, null),
        priests: toNumber(tpl.PriestCount, null),
        happiness: tn(tpl, 'js_TownHallHappinessLargeValue'),
        // happiness_euphoric | happiness_happy | happiness_neutral | happiness_sad | happiness_outraged
        happinessLevel: /happiness_(\w+)/.exec(happinessClass)?.[1] || null,
        growth: toNumber(String(tv(tpl, 'js_TownHallPopulationGrowthValue') ?? '').trim(), null),
        corruption: toNumber(String(tv(tpl, 'js_TownHallCorruption') ?? '').replace('%', ''), null),
        actionPoints: tn(tpl, 'js_TownHallActionPointsAvailable'),
        maxActionPoints: tn(tpl, 'js_TownHallMaxActionPointsAvailable'),
        goldPerHour: tn(tpl, 'js_TownHallIncomeGoldValue'),
        garrisonLand: tn(tpl, 'js_TownHallGarrisonLimitLand'),
        garrisonSea: tn(tpl, 'js_TownHallGarrisonLimitSea'),
        safeCapacity: tn(tpl, 'js_TownHallPlunderSafeCapacity'),
        satisfaction: {
          base: bonus('BaseBoniBaseBonus'),
          research: bonus('BaseBoniResearchBonus'),
          capital: tpl.js_TownHallSatisfactionOverviewBaseBoniCapitalBonus?.class?.includes('invisible') ? 0 : bonus('BaseBoniCapitalBonus'),
          tavern: bonus('WineBoniTavernBonus'),
          wine: bonus('WineBoniServeBonus'),
          museum: bonus('CultureBoniMuseumBonus'),
          treaties: bonus('CultureBoniTreatyBonus'),
          overpopulation: -bonus('OverpopulationMalus'),
          corruption: -bonus('CorruptionMalus'),
          government: -bonus('GovernmentMalus'),
        },
        updatedAt: Date.now(),
      },
    });
  }

  // ---------- Research advisor ----------

  const RESEARCH_BRANCHES = ['seafaring', 'economy', 'knowledge', 'military', 'mythology'];

  function researchAdvisor(tpl) {
    if (!('js_researchAdvisorPoints' in tpl)) return null;
    const branches = RESEARCH_BRANCHES.map((id, i) => {
      const bar = tpl[`js_researchAdvisorProgressbar${i}`]?.progressbar;
      const cost = tv(tpl, `js_researchAdvisorNextResearchCost${i}`);
      return {
        id,
        label: String(tv(tpl, `js_researchAdvisorChangeResearchTypeTxt${i}`) || ''),
        next: String(tv(tpl, `js_researchAdvisorNextResearchName${i}`) || '') || null,
        effect: String(tv(tpl, `js_researchAdvisorNextResearchTooltipShortDesc${i}`) || '') || null,
        cost: cost === '-' ? null : toNumber(cost, null),
        // A countdown means the points will be reached at that time
        availableAt: bar?.enddate ? bar.enddate * 1000 : null,
        active: String(tpl[`js_researchAdvisorTypeActiveClass${i}`]?.class || '').includes('active'),
        maxed: !tv(tpl, `js_researchAdvisorNextResearchName${i}`) && cost === '-',
      };
    });
    return {
      research: {
        points: tn(tpl, 'js_researchAdvisorPoints'),
        // "3,52": research points per hour shown by the game (localized decimal)
        pointsPerHour: toNumber(String(tv(tpl, 'js_researchAdvisorTime') ?? '').replace(',', '.'), null),
        scientists: tn(tpl, 'js_researchAdvisorScientists'),
        branches,
        updatedAt: Date.now(),
      },
    };
  }

  // ---------- Port: merchant ships ----------

  function port(tpl) {
    if (!('bonusShipTableTransporters' in tpl)) return null;
    return {
      global: {
        shipsOwned: {
          transporters: tn(tpl, 'bonusShipTableTransporters'),
          freighters: tn(tpl, 'bonusShipTableFreighters'),
          phoenicianTransporters: tn(tpl, 'bonusShipTablePhoenicianTransporters'),
        },
      },
    };
  }

  registerAction('updateTemplateData', (tpl, ctx) => {
    if (!tpl || typeof tpl !== 'object') return null;
    if (ctx.view === 'townHall') return townHall(tpl, ctx);
    if (ctx.view === 'researchAdvisor') return researchAdvisor(tpl);
    if (ctx.view === 'port') return port(tpl);
    return null;
  });

  // ---------- City military: troops and ships stationed in a city ----------

  // First "count" row of each table is the player's own units
  function readUnitTables(container, kind) {
    const out = {};
    const names = {};
    for (const table of container.querySelectorAll('table.militaryList')) {
      const heads = [...table.querySelectorAll('tr.title_img_row th')].slice(1);
      const row = table.querySelector('tr.count');
      if (!row) continue;
      const cells = [...row.querySelectorAll('td')].slice(1);
      heads.forEach((th, i) => {
        const icon = th.querySelector(`.${kind}`);
        const id = icon && [...icon.classList].find((c) => /^s\d+$/.test(c));
        if (!id) return;
        out[id] = toNumber(cells[i]?.textContent?.trim(), 0);
        // Display name in the game language, for labels only
        names[id] = th.querySelector('.tooltip')?.textContent?.trim() || id;
      });
    }
    return { counts: out, names };
  }

  registerView('cityMilitary', ({ html }, ctx) => {
    const doc = parseHtml(html);
    const unitsTab = doc.getElementById('tabUnits') || doc;
    const shipsTab = doc.getElementById('tabShips') || doc;
    const units = readUnitTables(unitsTab, 'army');
    const ships = readUnitTables(shipsTab, 'fleet');
    if (!Object.keys(units.counts).length && !Object.keys(ships.counts).length) return null;
    return {
      ...cityPatch(cityOf(ctx), { units: units.counts, ships: ships.counts, militaryUpdatedAt: Date.now() }),
      unitNames: { ...units.names, ...ships.names },
    };
  });

  // ---------- Finances: income per city ----------

  registerView('finances', ({ html }, ctx) => {
    const doc = parseHtml(html);
    const cityIdsByName = Object.fromEntries(
      Object.values(ctx.snapshot?.cities || {}).map((c) => [String(c.name || '').trim(), c.id])
    );
    const perCity = {};
    for (const row of doc.querySelectorAll('table.table01 tr')) {
      const nameCell = row.querySelector('td.city');
      if (!nameCell) continue;
      // Exact values are in the tooltips ("6 222,00"); the cell text is rounded
      const values = [...row.querySelectorAll('td.res')].map((td) => {
        const exact = td.querySelector('.tooltip')?.textContent?.trim();
        const text = exact || td.firstChild?.textContent?.trim() || '';
        return toNumber(text.replace(/,(\d{1,2})$/, '.$1').replace(/[\s  ]/g, ''), null);
      });
      const name = nameCell.textContent.trim();
      const id = cityIdsByName[name];
      if (id && values.length >= 3) perCity[id] = { income: values[0], scientists: values[1], result: values[2] };
    }
    if (!Object.keys(perCity).length) return null;
    return { finances: { perCity, updatedAt: Date.now() } };
  });

  // ---------- Academy: experiment (crystal glass into research points) ----------

  registerView('academy', ({ html }) => {
    const doc = parseHtml(html);
    const box = doc.getElementById('accelerateResearch');
    if (!box) return null;
    // Second span of each block holds the number ("Scientific yield: 150 000")
    const points = toNumber(box.querySelector('.research-achievement .achievement-content span:nth-of-type(2)')?.textContent?.trim(), null);
    const costSpans = box.querySelectorAll('.experiment:first-child .cost-info span');
    const glass = toNumber(costSpans[1]?.textContent?.trim(), null);
    if (!points || !glass) return null;
    // The cooldown is only stated in the description ("... 4h ..."), read as a hint
    const cooldownHours = toNumber(/(\d+)\s*h\b/.exec(box.querySelector('p')?.textContent || '')?.[1], null);
    return { research: { experiment: { points, glass, cooldownHours, updatedAt: Date.now() } } };
  });

  // ---------- Diplomacy advisor: counters and inbox metadata ----------

  // "Mensajes (3)" gives 3, read from the tab element by its class, not its text
  function tabCount(doc, cls) {
    const text = doc.querySelector(`b.${cls}`)?.textContent || '';
    const m = /\((\d+)\)/.exec(text);
    return m ? Number(m[1]) : 0;
  }

  const EXCERPT_CHARS = 160;
  const MAX_MESSAGES = 30;

  registerView('diplomacyAdvisor', ({ html }) => {
    const doc = parseHtml(html);
    const filterCounts = [...doc.querySelectorAll('.filter.diplomacy .filterEntry .name')].map((n) => toNumber(/\((\d+)\)/.exec(n.textContent)?.[1], 0));
    const messages = [...doc.querySelectorAll('tr[id^="message"]')].slice(0, MAX_MESSAGES).map((row) => {
      const id = row.id.replace('message', '');
      const cells = row.querySelectorAll('td');
      const cityLink = row.querySelector('a[href*="selectCity"]');
      const body = doc.getElementById(`tbl_mail${id}`)?.querySelector('.msgText')?.textContent || '';
      return {
        id,
        sender: row.querySelector('.avatarName')?.textContent?.trim() || cells[2]?.textContent?.trim() || '',
        subject: row.querySelector('td.subject')?.textContent?.trim() || '',
        city: cityLink?.textContent?.trim() || '',
        date: cells[cells.length - 1]?.textContent?.trim() || '',
        // Local only, never sent anywhere; first lines are enough to recognise it
        excerpt: body.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS),
      };
    });
    return {
      diplomacy: {
        unreadMessages: tabCount(doc, 'tab_diplomacyAdvisor'),
        agora: tabCount(doc, 'tab_diplomacyIslandBoard'),
        alliance: tabCount(doc, 'tab_diplomacyAlly'),
        inbox: filterCounts[0] ?? null,
        outbox: filterCounts[1] ?? null,
        messages,
        updatedAt: Date.now(),
      },
    };
  });

  // ---------- Hideout: spies of a city ----------

  registerView('safehouse', ({ html }, ctx) => {
    const doc = parseHtml(html);
    const stats = doc.querySelector('.spy_stats_content');
    if (!stats) return null;
    const cityId = doc.querySelector('#buildForm input[name="cityId"]')?.value || cityOf(ctx);
    // List order is fixed: waiting for training, defending the city, on missions
    const counts = [...stats.querySelectorAll('li')].map((li) => toNumber(/\d[\d.,\s\u00a0]*/.exec(li.textContent)?.[0]?.trim(), 0));
    const canTrain = toNumber(/\d[\d.,\s\u00a0]*/.exec(stats.querySelector('b')?.textContent || '')?.[0]?.trim(), null);
    return cityPatch(String(cityId), {
      spies: {
        training: counts[0] ?? 0,
        defending: counts[1] ?? 0,
        onMission: counts[2] ?? 0,
        canTrain,
        costGold: toNumber(doc.getElementById('js_spygold')?.textContent, null),
        costGlass: toNumber(doc.getElementById('js_spyglass')?.textContent, null),
        updatedAt: Date.now(),
      },
    });
  });

  // ---------- Hideout: spy reports (tabs "Reports" and "Archive") ----------

  const MAX_SPY_REPORTS = 100;
  const COORDS = /\[\s*(\d{1,3})\s*:\s*(\d{1,3})\s*\]/;

  // "15.10.2025 16:10:48" (the game's date format on every server)
  function gameDate(text) {
    const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(text || ''));
    return m ? new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)).getTime() : null;
  }

  // "0 /8": lost and sent
  function ratio(text) {
    const m = /(\d+)\s*\/\s*(\d+)/.exec(String(text || ''));
    return m ? { lost: +m[1], sent: +m[2] } : null;
  }

  const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim();

  function linkParam(a, name) {
    const href = (a?.getAttribute('href') || '').replace(/&amp;/g, '&');
    return new RegExp(`[?&]${name}=(\\d+)`).exec(href)?.[1] || null;
  }

  // Report body as plain lines (text, list items, table rows) plus the cities it
  // links to. Inline elements (links, bold) stay in their line; block elements
  // start a new one. No HTML is kept: the overlay shows text only.
  const BLOCK = new Set(['DIV', 'P', 'BR', 'UL', 'OL', 'TABLE', 'TBODY', 'H1', 'H2', 'H3', 'H4']);

  function reportBody(cell) {
    const lines = [];
    let current = '';
    const flush = () => {
      const t = clean(current);
      if (t) lines.push(t);
      current = '';
    };
    const cellText = (c) => clean(c.textContent) || clean(c.querySelector('img')?.getAttribute('alt') || c.querySelector('img')?.getAttribute('title'));
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) current += child.textContent;
        else if (child.nodeType !== 1 || child.tagName === 'SCRIPT' || child.tagName === 'STYLE') continue;
        else if (child.tagName === 'LI') {
          flush();
          current = `- ${clean(child.textContent)}`;
          flush();
        } else if (child.tagName === 'TR') {
          flush();
          current = [...child.cells].map(cellText).filter(Boolean).join(': ');
          flush();
        } else if (child.tagName === 'IMG') current += ` ${child.getAttribute('alt') || child.getAttribute('title') || ''} `;
        else if (BLOCK.has(child.tagName)) {
          flush();
          walk(child);
          flush();
        } else walk(child);
      }
    };
    if (cell) {
      walk(cell);
      flush();
    }
    const cities = [];
    const seen = new Set();
    for (const a of cell?.querySelectorAll('a') || []) {
      const m = COORDS.exec(a.textContent);
      if (!m) continue;
      const cityId = linkParam(a, 'selectCity') || linkParam(a, 'cityId');
      const key = cityId || `${m[1]}:${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cities.push({ name: clean(a.textContent.replace(COORDS, '')), x: +m[1], y: +m[2], cityId, islandId: linkParam(a, 'islandId') });
    }
    return { lines: lines.slice(0, 80), cities: cities.slice(0, 50) };
  }

  function parseSpyReports(doc) {
    const table = doc.getElementById('espionageReports');
    if (!table) return null;
    const reports = [];
    for (const row of table.querySelectorAll('tr.espionageReports[id^="message"]')) {
      const id = row.id.replace('message', '');
      if (!/^\d+$/.test(id)) continue;
      const cityCell = row.querySelector('td.targetCity');
      const coords = COORDS.exec(cityCell?.textContent || '');
      const link = cityCell?.querySelector('a');
      const detail = doc.getElementById(`tbl_mail${id}`);
      const status = detail?.querySelector('tr.status td:not(.job)');
      const img = row.querySelector('td.resultImage img');
      reports.push({
        id,
        owner: clean(row.querySelector('td.targetOwner')?.textContent),
        city: clean((cityCell?.textContent || '').replace(COORDS, '')),
        x: coords ? +coords[1] : null,
        y: coords ? +coords[2] : null,
        cityId: linkParam(link, 'selectCity') || linkParam(link, 'cityId'),
        subject: clean(row.querySelector('td.subject')?.textContent),
        result: clean(status?.textContent || img?.getAttribute('title') || img?.getAttribute('alt')),
        agents: ratio(row.querySelector('td.lostAgents')?.textContent),
        decoys: ratio(row.querySelector('td.lostDecoys')?.textContent),
        date: gameDate(row.querySelector('td.date')?.textContent),
        dateText: clean(row.querySelector('td.date')?.textContent),
        ...reportBody(detail?.querySelector('td.report')),
      });
    }
    return reports;
  }

  registerView('safehouse', ({ html }) => {
    const reports = parseSpyReports(parseHtml(html));
    if (!reports) return null;
    // Reports are merged by id (the inbox and the archive show different ones)
    return (snapshot) => {
      const byId = { ...(snapshot.espionage?.reports || {}) };
      for (const r of reports) byId[r.id] = { ...r, seenAt: byId[r.id]?.seenAt || Date.now() };
      const kept = Object.values(byId)
        .sort((a, b) => (b.date || 0) - (a.date || 0))
        .slice(0, MAX_SPY_REPORTS);
      return {
        ...snapshot,
        espionage: { ...(snapshot.espionage || {}), reports: Object.fromEntries(kept.map((r) => [r.id, r])), reportsUpdatedAt: Date.now() },
      };
    };
  });

  // ---------- Military advisor: war reports list ----------

  const MAX_COMBATS = 50;

  // Rows of #combatList: id from the combatId[N] checkbox, won / lost from the row
  // colour (green / red), place and coordinates from the island link
  function parseCombatList(doc) {
    const table = doc.getElementById('combatList');
    if (!table) return null;
    const combats = [];
    for (const row of table.querySelectorAll('tbody tr')) {
      const id = /combatId\[(\d+)\]/.exec(row.querySelector('input[name^="combatId"]')?.getAttribute('name') || '')?.[1];
      if (!id) continue;
      const cells = [...row.cells];
      const placeLink = row.querySelector('td a:not(.watchBattle)');
      const placeText = clean(placeLink?.textContent);
      const coords = COORDS.exec(placeText);
      const placeCell = placeLink?.closest('td');
      const ownerCell = placeCell ? cells[cells.indexOf(placeCell) + 1] : null;
      const img = row.querySelector('img');
      combats.push({
        id,
        kind: clean(img?.getAttribute('title') || img?.getAttribute('alt')),
        date: gameDate(row.querySelector('td.date')?.textContent),
        dateText: clean(row.querySelector('td.date')?.textContent),
        rounds: toNumber(row.querySelector('td.right')?.textContent, null),
        place: clean(placeText.replace(COORDS, '')),
        x: coords ? +coords[1] : null,
        y: coords ? +coords[2] : null,
        islandId: linkParam(placeLink, 'islandId'),
        owner: clean(ownerCell?.textContent),
        result: row.classList.contains('green') ? 'won' : row.classList.contains('red') ? 'lost' : null,
      });
    }
    return combats;
  }

  registerView('militaryAdvisorCombatList', ({ html }) => {
    const combats = parseCombatList(parseHtml(html));
    if (!combats) return null;
    return (snapshot) => {
      const byId = { ...(snapshot.military?.combats || {}) };
      for (const c of combats) byId[c.id] = { ...byId[c.id], ...c };
      const kept = Object.values(byId)
        .sort((a, b) => (b.date || 0) - (a.date || 0))
        .slice(0, MAX_COMBATS);
      return {
        ...snapshot,
        military: { ...(snapshot.military || {}), combats: Object.fromEntries(kept.map((c) => [c.id, c])), combatsUpdatedAt: Date.now() },
      };
    };
  });

  // ---------- Battle report views: unit names (for drawing imported reports) ----------

  // Every unit icon in a report carries its id class (s303) and the name in the
  // game language; the names let pasted report texts find their icons
  function unitNamesFrom(doc) {
    const names = {};
    for (const icon of doc.querySelectorAll('.army, .fleet')) {
      const id = [...icon.classList].find((c) => /^s\d+$/.test(c));
      const name = clean(icon.querySelector('.tooltip')?.textContent);
      if (id && name) names[id] = name;
    }
    return names;
  }

  for (const view of ['militaryAdvisorReportView', 'militaryAdvisorDetailedReportView']) {
    registerView(view, ({ html }) => {
      const names = unitNamesFrom(parseHtml(html));
      return Object.keys(names).length ? { unitNames: names } : null;
    });
  }

  // ---------- Trading post: market offers around the city ----------

  // Resource of an offer from its trade link (resource=resource|1|2|3|4)
  const MARKET_RESOURCE = { resource: 'wood', 1: 'wine', 2: 'marble', 3: 'glass', 4: 'sulfur' };

  registerView('branchOffice', ({ html }, ctx) => {
    const doc = parseHtml(html);
    const offers = [];
    let kind = null;
    for (const row of doc.querySelectorAll('table.table01 tr')) {
      const link = row.querySelector('a[href*="view=takeOffer"]');
      if (!link) continue;
      const q = new URLSearchParams(link.getAttribute('href').split('?')[1] || '');
      const cells = row.querySelectorAll('td');
      const resource = MARKET_RESOURCE[q.get('resource')];
      if (!resource || cells.length < 6) continue;
      // type 444: the listed cities sell to us (we buy); 333: they buy from us (we sell)
      kind = q.get('type') === '333' ? 'sell' : 'buy';
      const owner = cells[0].innerHTML.split('<br')[0].replace(/<[^>]+>/g, '').trim();
      const player = /\(([^)]+)\)/.exec(cells[0].textContent)?.[1] || '';
      offers.push({
        resource,
        city: owner,
        player,
        cityId: q.get('destinationCityId'),
        perMinute: toNumber(cells[1].textContent.trim(), null),
        amount: toNumber(cells[2].querySelector('.tooltip')?.textContent?.trim() || cells[2].firstChild?.textContent?.trim(), null),
        price: toNumber(/\d+/.exec(cells[4].textContent)?.[0], null),
        distance: toNumber(cells[5].textContent.trim(), null),
      });
    }
    if (!offers.length) return null;
    const resource = offers[0].resource;
    const fromCityId = cityOf(ctx);
    // Function patch: the list for this resource/kind is replaced, not merged
    return (snapshot) => {
      const market = { ...(snapshot.market || {}) };
      market[`${kind}:${resource}`] = { kind, resource, fromCityId, offers, updatedAt: Date.now() };
      return { ...snapshot, market };
    };
  });

  IkaDios.parsers.viewsData = { tv, townHall, researchAdvisor, readUnitTables, RESEARCH_BRANCHES, parseSpyReports, parseCombatList, gameDate };
})(typeof self !== 'undefined' ? self : window);

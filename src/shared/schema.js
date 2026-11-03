// Snapshot shape, versioning and migrations. Every section carries its own
// updatedAt (ms) so the UI can show how old each piece of data is.
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});

  const SCHEMA_VERSION = 1;

  const RESOURCES = ['wood', 'wine', 'marble', 'glass', 'sulfur'];

  function emptySnapshot(account = {}) {
    return {
      schemaVersion: SCHEMA_VERSION,
      account: { world: null, avatarId: null, playerName: null, allyTag: null, ...account },
      global: { updatedAt: 0 },
      cities: {},
      military: { movements: [], updatedAt: 0 },
      research: { updatedAt: 0 },
      diplomacy: { updatedAt: 0 },
      espionage: { updatedAt: 0 },
      trade: { updatedAt: 0 },
      finances: { updatedAt: 0 },
      islands: {},
      advisorState: { updatedAt: 0 },
      // view key (see refresh-plan.js) to last capture time in ms
      viewsUpdatedAt: {},
    };
  }

  // Each entry upgrades a snapshot from version (index + 1) to (index + 2)
  const MIGRATIONS = [];

  function migrate(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    let current = snapshot;
    let version = current.schemaVersion || 1;
    while (version < SCHEMA_VERSION) {
      current = MIGRATIONS[version - 1](current);
      version += 1;
      current.schemaVersion = version;
    }
    // Fill sections added after the snapshot was created
    return IkaDios.util.deepMerge(emptySnapshot(), current);
  }

  IkaDios.schema = { SCHEMA_VERSION, RESOURCES, emptySnapshot, migrate };
})(typeof self !== 'undefined' ? self : window);

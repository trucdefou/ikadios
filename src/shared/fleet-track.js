// Where a fleet or army is at a given moment, for the map. The game sends the
// arrival time (eventTime) and the mission state, not the departure. Departure is
// exact when IkaDios saw the movement while it was loading (state 1: eventTime is
// then the end of loading); otherwise it is estimated from the island distance
// with the game's standard travel time, and never later than the moment the
// movement was first seen under way.
(function (root) {
  'use strict';

  const IkaDios = (root.IkaDios = root.IkaDios || {});

  // Standard travel time (merchant ships, no upgrades): 20 min per distance unit
  // between islands, 10 min on the same island. Only used when the departure was
  // not seen, so the error only shifts an estimate.
  const MS_PER_UNIT = 20 * 60000;
  const SAME_ISLAND_MS = 10 * 60000;

  const STATE_LOADING = 1;
  const STATE_UNDERWAY = 2;

  function travelMs(from, to) {
    if (!from || !to) return null;
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    return d === 0 ? SAME_ISLAND_MS : d * MS_PER_UNIT;
  }

  // { phase: 'loading' | 'underway' | 'arrived' | 'atTarget', t (0..1 along the
  //   leg), start, end, exact, leg: 'out' | 'back' }
  // The leg goes origin to target, or target to origin when returning.
  function position(m, from, to, at = Date.now()) {
    const leg = m.returning ? 'back' : 'out';
    const duration = travelMs(from, to);
    // Stationed or fighting at the target (state 3 and later)
    if (m.state != null && m.state > STATE_UNDERWAY && !m.returning) return { phase: 'atTarget', t: 1, leg, exact: true, start: null, end: m.arrivesAt };

    if (m.state === STATE_LOADING) {
      const loadEnd = m.arrivesAt;
      if (!loadEnd || at < loadEnd) return { phase: 'loading', t: 0, leg, exact: true, start: loadEnd, end: loadEnd && duration ? loadEnd + duration : null };
      // Loading finished since the last capture: under way with an estimated arrival
      const end = duration ? loadEnd + duration : loadEnd;
      return progress(loadEnd, end, at, leg, true);
    }

    const end = m.arrivesAt;
    if (!end) return { phase: 'underway', t: 0, leg, exact: false, start: null, end: null };
    if (m.departAt && m.departAt < end) return progress(m.departAt, end, at, leg, true);
    const seen = m.legSeenAt || m.firstSeenAt || at;
    const estimated = duration ? end - duration : seen;
    return progress(Math.min(estimated, seen), end, at, leg, false);
  }

  function progress(start, end, at, leg, exact) {
    if (at >= end) return { phase: 'arrived', t: 1, leg, exact, start, end };
    const t = end > start ? Math.min(1, Math.max(0, (at - start) / (end - start))) : 0;
    return { phase: 'underway', t, leg, exact, start, end };
  }

  // Latest moment worth showing on the time slider (last arrival), or null.
  // `coordsOf(endpoint)` gives the coordinates of a movement's origin or target.
  function lastArrival(movements, coordsOf, now = Date.now()) {
    let last = null;
    for (const m of movements || []) {
      const from = coordsOf(m.origin);
      const to = coordsOf(m.target);
      const p = position(m, from, to, now);
      const end = p.end || m.arrivesAt;
      if (end && end > now && (!last || end > last)) last = end;
    }
    return last;
  }

  IkaDios.fleetTrack = { position, travelMs, lastArrival, STATE_LOADING, STATE_UNDERWAY };
})(typeof self !== 'undefined' ? self : window);

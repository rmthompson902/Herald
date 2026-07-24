'use strict';

// Thin admin-view helpers for the Zones page's GET/POST/PUT/DELETE endpoints - core.zones
// only stores patchToZone (patch id -> zone name) and config (zone name -> duck/unduck), so
// every one of those endpoints needs the same "rebuild the current zones object back out of
// those two Maps" step; centralized here rather than repeated inline in each flows.json
// function node.

/** @returns {Array<{zoneName: string, messagingPatchId: string, duckCueNumber: string, unduckCueNumber: string}>} */
function getZonesSnapshot(core) {
  const patchByZone = new Map();
  for (const [patchId, zoneName] of core.zones.patchToZone) patchByZone.set(zoneName, patchId);

  return Array.from(core.zones.config.entries()).map(([zoneName, cfg]) => ({
    zoneName,
    messagingPatchId: patchByZone.get(zoneName),
    duckCueNumber: cfg.duckCueNumber,
    unduckCueNumber: cfg.unduckCueNumber
  }));
}

/**
 * Rebuilds the plain `zones` object shape core.zones.save()/saveAudioPatchMap expect,
 * straight from the live in-memory config - the starting point for a create/update/delete,
 * which each add/replace/remove exactly one entry before calling core.zones.save().
 * @returns {object}
 */
function buildZonesObject(core) {
  const zones = {};
  for (const snapshot of getZonesSnapshot(core)) {
    zones[snapshot.zoneName] = {
      messagingPatchId: snapshot.messagingPatchId,
      duckCueNumber: snapshot.duckCueNumber,
      unduckCueNumber: snapshot.unduckCueNumber
    };
  }
  return zones;
}

module.exports = { getZonesSnapshot, buildZonesObject };

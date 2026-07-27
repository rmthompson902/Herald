'use strict';

// Zones admin endpoint handlers. Zones have no SQLite row - config/audio-patch-map.json is
// the source of truth, edited via core.zones.save() which validates + writes + hot-reloads
// the in-memory maps (no Node-RED restart). Each write rebuilds the whole zones object from
// the live config (zonesAdmin.buildZonesObject), changes exactly one entry, and saves.

function createZoneHandlers({ core, zonesAdmin, deriveZoneSuggestion }) {
  // A live patch lookup can fail for reasons unrelated to the convention-based suggestion
  // (cue doesn't exist yet, it's a Group with no /patch, QLab briefly unreachable) - none of
  // that should block the naming-convention autofill, which needs nothing from QLab. patchId
  // just comes back null then; this endpoint only 4xxs on its own malformed input.
  function zoneDiscover(msg, _node) {
    const cueNumber = msg.req.query.cueNumber;

    if (!cueNumber) {
      msg.statusCode = 400;
      msg.payload = { status: 'error', message: 'cueNumber query parameter is required' };
      return msg;
    }

    return (async () => {
      let patchId = null;
      try {
        const rawPatchId = await core.osc.protocol.getCuePatch(cueNumber);
        patchId = rawPatchId === null || rawPatchId === undefined ? null : String(rawPatchId);
      } catch {
        patchId = null;
      }

      const suggestion = { patchId, ...(deriveZoneSuggestion(cueNumber) || {}) };

      msg.statusCode = 200;
      msg.payload = { status: 'success', ...suggestion };
      return msg;
    })();
  }

  function createZone(msg, _node) {
    const p = msg.payload || {};

    if (!p.zoneName || typeof p.zoneName !== 'string' || !p.zoneName.trim()) {
      msg.statusCode = 400;
      msg.payload = { status: 'error', message: 'zoneName is required' };
      return msg;
    }

    if (core.zones.config.has(p.zoneName)) {
      msg.statusCode = 409;
      msg.payload = { status: 'error', message: `Zone "${p.zoneName}" already exists` };
      return msg;
    }

    const zones = zonesAdmin.buildZonesObject(core);
    zones[p.zoneName] = {
      messagingPatchId: p.messagingPatchId,
      duckCueNumber: p.duckCueNumber,
      unduckCueNumber: p.unduckCueNumber
    };

    try {
      core.zones.save(zones);
    } catch (err) {
      msg.statusCode = 400;
      msg.payload = { status: 'error', message: err.message };
      return msg;
    }

    msg.statusCode = 201;
    msg.payload = { status: 'success', zoneName: p.zoneName };
    return msg;
  }

  function updateZone(msg, _node) {
    const zoneName = msg.req.params.zoneName;
    const p = msg.payload || {};

    if (!core.zones.config.has(zoneName)) {
      msg.statusCode = 404;
      msg.payload = { status: 'error', message: `Zone "${zoneName}" not found` };
      return msg;
    }

    const zones = zonesAdmin.buildZonesObject(core);
    zones[zoneName] = {
      messagingPatchId: p.messagingPatchId,
      duckCueNumber: p.duckCueNumber,
      unduckCueNumber: p.unduckCueNumber
    };

    try {
      core.zones.save(zones);
    } catch (err) {
      msg.statusCode = 400;
      msg.payload = { status: 'error', message: err.message };
      return msg;
    }

    msg.statusCode = 200;
    msg.payload = { status: 'success', zoneName };
    return msg;
  }

  function deleteZone(msg, _node) {
    const zoneName = msg.req.params.zoneName;

    if (!core.zones.config.has(zoneName)) {
      msg.statusCode = 404;
      msg.payload = { status: 'error', message: `Zone "${zoneName}" not found` };
      return msg;
    }

    const zones = zonesAdmin.buildZonesObject(core);
    delete zones[zoneName];

    try {
      core.zones.save(zones);
    } catch (err) {
      msg.statusCode = 400;
      msg.payload = { status: 'error', message: err.message };
      return msg;
    }

    msg.statusCode = 200;
    msg.payload = { status: 'success', zoneName };
    return msg;
  }

  return { zoneDiscover, createZone, updateZone, deleteZone };
}

module.exports = { createZoneHandlers };

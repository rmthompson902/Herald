'use strict';

const fs = require('fs');

/**
 * Validates a raw `zones` object (config/audio-patch-map.json's "zones" key, already
 * JSON-parsed) and builds the two lookup Maps the rest of the system uses. Shared by the
 * startup loader (loadAudioPatchMap) and the Zones admin UI's save path (saveAudioPatchMap)
 * so both reject an invalid zone identically - a change that passes the UI's own check but
 * would leave a broken config for the next Node-RED restart to choke on can't happen.
 *
 * @param {object} zones
 * @returns {{
 *   patchToZone: Map<string,string>,
 *   zoneConfig: Map<string,{duckCueNumber: string, unduckCueNumber: string}>
 * }}
 */
function validateAndBuildMaps(zones) {
  if (!zones || typeof zones !== 'object' || Array.isArray(zones) || Object.keys(zones).length === 0) {
    throw new Error('audio-patch-map.json: no zones found');
  }

  const patchToZone = new Map();
  const zoneConfig = new Map();

  for (const [zoneName, entry] of Object.entries(zones)) {
    if (typeof zoneName !== 'string' || zoneName.trim() === '') {
      throw new Error(`audio-patch-map.json: invalid zone name "${zoneName}"`);
    }

    const messagingPatchId = entry ? entry.messagingPatchId : undefined;
    const duckCueNumber = entry ? entry.duckCueNumber : undefined;
    const unduckCueNumber = entry ? entry.unduckCueNumber : undefined;

    if (messagingPatchId === undefined || messagingPatchId === null || String(messagingPatchId).trim() === '') {
      throw new Error(`audio-patch-map.json: zone "${zoneName}" missing messagingPatchId`);
    }
    if (!duckCueNumber || String(duckCueNumber).trim() === '') {
      throw new Error(`audio-patch-map.json: zone "${zoneName}" missing duckCueNumber`);
    }
    if (!unduckCueNumber || String(unduckCueNumber).trim() === '') {
      throw new Error(`audio-patch-map.json: zone "${zoneName}" missing unduckCueNumber`);
    }

    const patchKey = String(messagingPatchId);
    if (patchToZone.has(patchKey)) {
      throw new Error(
        `audio-patch-map.json: patch id "${patchKey}" is claimed by more than one zone ` +
        `(already used by "${patchToZone.get(patchKey)}")`
      );
    }

    patchToZone.set(patchKey, zoneName);
    zoneConfig.set(zoneName, {
      duckCueNumber: String(duckCueNumber),
      unduckCueNumber: String(unduckCueNumber)
    });
  }

  return { patchToZone, zoneConfig };
}

/**
 * Loads and validates config/audio-patch-map.json: per-zone Messaging Audio Patch id plus
 * duck/unduck cue numbers. This is the ONLY manual zone configuration in the system now that
 * zones are derived from Audio Patch assignment rather than a crosspoint-matrix channel map
 * (see zone-map.json's predecessor, and the patch-based spike in
 * test/fixtures/qlab-osc-findings.md).
 *
 * @returns {{
 *   patchToZone: Map<string,string>,
 *   zoneConfig: Map<string,{duckCueNumber: string, unduckCueNumber: string}>
 * }}
 */
function loadAudioPatchMap(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return validateAndBuildMaps(parsed.zones);
}

/**
 * Validates and writes a complete new `zones` object back to config/audio-patch-map.json -
 * the Zones admin UI's save path (see the POST/PUT/DELETE /api/zones endpoints). Preserves
 * the file's existing `_comment` field and 2-space indent rather than reformatting the whole
 * file. Throws (and writes nothing) if the new zones object would be rejected by
 * validateAndBuildMaps - the file on disk must never end up worse than what
 * loadAudioPatchMap would accept on the next startup.
 *
 * @param {string} filePath
 * @param {object} zones - the complete new zones object (not a partial patch)
 */
function saveAudioPatchMap(filePath, zones) {
  validateAndBuildMaps(zones); // throws on anything loadAudioPatchMap would also reject

  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  parsed.zones = zones;

  fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
}

module.exports = { loadAudioPatchMap, saveAudioPatchMap, validateAndBuildMaps };

'use strict';

const fs = require('fs');

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

  const zones = parsed.zones;
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

module.exports = { loadAudioPatchMap };

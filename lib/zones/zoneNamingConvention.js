'use strict';

// Convention: "{zone}1{id}" - e.g. 3101 -> Zone 3's messaging cue 01, duck 3198, unduck 3199
// (see config/audio-patch-map.json's own _comment). Used by the Zones admin UI's discover
// endpoint to autofill a new zone's name/duck/unduck cue numbers from one real reference cue
// number, when it happens to follow this convention - never required, always overridable.
const CONVENTION_PATTERN = /^([1-9])1\d\d$/;

/**
 * @param {string} cueNumber
 * @returns {{ zoneName: string, duckCueNumber: string, unduckCueNumber: string } | null}
 *   null if cueNumber doesn't match the convention - callers should treat that as "no
 *   suggestion available", never an error.
 */
function deriveZoneSuggestion(cueNumber) {
  const match = CONVENTION_PATTERN.exec(String(cueNumber));
  if (!match) return null;

  const zoneNum = match[1];
  return {
    zoneName: `Zone ${zoneNum}`,
    duckCueNumber: `${zoneNum}198`,
    unduckCueNumber: `${zoneNum}199`
  };
}

module.exports = { deriveZoneSuggestion };

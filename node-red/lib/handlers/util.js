'use strict';

// Shared by the create/update/refresh handlers: log a warning for each leaf cue whose QLab
// Audio Patch is assigned but isn't mapped to any zone in config/audio-patch-map.json (almost
// always a config gap - see lib/zones/zoneResolver.js's unmappedLeafCues). Best-effort
// diagnostics only; never throws.
function warnUnmappedLeafCues(node, result, viaCueNumber) {
  if (!result || !Array.isArray(result.unmappedLeafCues)) return;
  for (const { cueNumber, patchId } of result.unmappedLeafCues) {
    node.warn(
      `cue ${cueNumber} (referenced via ${viaCueNumber}) is on patch ${patchId}, ` +
        `which isn't mapped to any zone in config/audio-patch-map.json`
    );
  }
}

module.exports = { warnUnmappedLeafCues };

'use strict';

// Cue-cache refresh handlers: the periodic background sweep (fires no HTTP response) and the
// manual "Refresh Cue Data" endpoint. Both re-resolve every referenced cue's
// duration/zones/name live from QLab into cue_cache; both are best-effort per cue.

const { warnUnmappedLeafCues } = require('./util');

function createCueHandlers({ core, refreshCueCache, refreshAllReferencedCues }) {
  function periodicCueRefresh(_msg, node) {
    return (async () => {
      const results = await refreshAllReferencedCues(core, refreshCueCache);
      const failures = Object.entries(results).filter(([, r]) => r && r.error);
      if (failures.length > 0) {
        node.warn(`Periodic cue_cache refresh: ${failures.length} cue(s) failed`);
      }
      for (const [cueNumber, result] of Object.entries(results)) {
        warnUnmappedLeafCues(node, result, cueNumber);
      }
      return null;
    })();
  }

  function refreshAllCues(msg, node) {
    return (async () => {
      const results = await refreshAllReferencedCues(core, refreshCueCache);
      const failed = Object.entries(results)
        .filter(([, r]) => r && r.error)
        .map(([cueNumber]) => cueNumber);

      for (const [cueNumber, result] of Object.entries(results)) {
        warnUnmappedLeafCues(node, result, cueNumber);
      }

      msg.statusCode = 200;
      msg.payload = {
        status: 'success',
        refreshedCount: Object.keys(results).length - failed.length,
        failed
      };
      return msg;
    })();
  }

  return { periodicCueRefresh, refreshAllCues };
}

module.exports = { createCueHandlers };

'use strict';

// Turns lib/scheduling/cronSync.js's plain directive objects into the actual Node-RED
// messages cron-plus's control input expects (confirmed against its real source - see
// test/fixtures/qlab-osc-findings.md's sibling cron-plus notes and node_modules/node-red-
// contrib-cron-plus/README.md). Single shared place for this translation so the startup
// rebuild path and every write endpoint use identical logic, not near-duplicate copies.
function toCronPlusMessages(directives) {
  return directives
    .map((d) => {
      if (d.toRemoveAllDynamic) return { topic: 'remove-all-dynamic' };
      if (d.toAdd) return { payload: d.toAdd };
      if (d.toRemove) return { payload: d.toRemove };
      return null;
    })
    .filter(Boolean);
}

module.exports = { toCronPlusMessages };

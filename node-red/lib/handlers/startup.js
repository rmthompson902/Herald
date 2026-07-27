'use strict';

const { warnUnmappedLeafCues } = require('./util');

// Node-RED startup: open the OSC connection, arm health monitoring, rebuild every enabled
// schedule's cron-plus job from SQLite (the source of truth), warm the cue cache, and loudly
// flag any zone that resolves from a real cue but has no duck/unduck config.
function createStartupHandler({
  core,
  cronSyncMessages,
  refreshCueCache,
  refreshAllReferencedCues
}) {
  function startup(_msg, node) {
    return (async () => {
      // Deliberately fails fast/aborts startup here (no in-process retry) - launchd's
      // KeepAlive (see deploy/launchd/) is the actual recovery mechanism; this just makes
      // the cause unmistakable when it restarts, instead of a raw uncaught rejection with
      // scheduling left silently disarmed forever.
      try {
        await core.osc.client.open();
        await core.health.start();
      } catch (err) {
        node.error(
          `Startup FAILED - could not open the OSC connection / arm health monitoring, ` +
            `scheduling will NOT run until this is fixed: ${err.message}`
        );
        return null;
      }

      const directives = core.scheduling.cronSync.rebuildAll(core.db.connection);
      const msgs = cronSyncMessages.toCronPlusMessages(directives);

      node.log(`Startup: rebuilding ${msgs.length} cron-plus directive(s)`);

      // Best-effort cue_cache warm-up so the webapp has zone/duration data even before any
      // schedule is created/edited post-boot.
      const results = await refreshAllReferencedCues(core, refreshCueCache);
      for (const [cueNumber, result] of Object.entries(results)) {
        if (result && result.error) {
          node.warn(`cue_cache warm-up failed for ${cueNumber}: ${result.error}`);
        }
        warnUnmappedLeafCues(node, result, cueNumber);
      }

      // Every zone a REAL schedule/VOG cue resolves to must have a duck/unduck entry in
      // config/audio-patch-map.json - otherwise onZoneTransition silently no-ops for that
      // zone (see lib/index.js) and music never ducks there, with nothing in the log to
      // explain why. Surfaced loudly (node.error) rather than aborting startup - a config
      // gap for one zone shouldn't disarm every OTHER correctly-configured zone's schedules.
      const resolvedZones = new Set();
      for (const result of Object.values(results)) {
        if (result && Array.isArray(result.zones)) {
          for (const zone of result.zones) resolvedZones.add(zone);
        }
      }
      const missingZones = Array.from(resolvedZones).filter((zone) => !core.zones.config.has(zone));
      if (missingZones.length > 0) {
        node.error(
          `Startup: zone(s) missing duck/unduck config in config/audio-patch-map.json - ` +
            `music will silently never duck there: ${missingZones.join(', ')}`
        );
      }

      return [msgs];
    })();
  }

  return { startup };
}

module.exports = { createStartupHandler };

'use strict';

// Assembles every extracted Node-RED flow/endpoint handler into one bundle, each closing
// over the same shared deps (core + the flow helpers). settings.js builds this once and
// exposes it via functionGlobalContext.handlers, so each flows.json function node is a thin
// wrapper: `return global.get('handlers').<name>(msg, node);`. Keeping the logic here (plain
// functions of injected deps) is what makes it unit-testable without a running Node-RED.
//
// Trivial one-liner nodes (health, queue-state/events, list-zones, list-cues, zone-patches,
// queue-upcoming, next-occurrences) are deliberately left inline in flows.json - there's no
// branching there worth extracting or testing.

const { createStartupHandler } = require('./startup');
const { createScheduleHandlers } = require('./schedules');
const { createVogHandlers } = require('./vog');
const { createCueHandlers } = require('./cues');
const { createZoneHandlers } = require('./zones');

/**
 * @param {object} deps
 * @param {object} deps.core - the composition root (see lib/index.js)
 * @param {object} deps.cronSyncMessages - node-red/lib/applyCronSyncDirectives.js
 * @param {Function} deps.refreshCueCache - node-red/lib/refreshCueCache.js
 * @param {Function} deps.refreshAllReferencedCues - node-red/lib/refreshCueCache.js
 * @param {object} deps.zonesAdmin - node-red/lib/zonesAdmin.js
 * @param {Function} deps.deriveZoneSuggestion - lib/zones/zoneNamingConvention.js
 */
function createHandlers(deps) {
  return {
    ...createStartupHandler(deps),
    ...createScheduleHandlers(deps),
    ...createVogHandlers(deps),
    ...createCueHandlers(deps),
    ...createZoneHandlers(deps)
  };
}

module.exports = { createHandlers };

'use strict';

const { openDatabase } = require('./db/database');
const schedulesRepo = require('./db/repositories/schedulesRepo');
const vogMessagesRepo = require('./db/repositories/vogMessagesRepo');
const cueCacheRepo = require('./db/repositories/cueCacheRepo');

const { OscClient } = require('./osc/oscClient');
const { QlabProtocol } = require('./osc/qlabProtocol');

const { loadZoneMap } = require('./zones/zoneMap');
const zoneResolver = require('./zones/zoneResolver');

const { validateSchedule } = require('./scheduling/scheduleModel');
const occurrenceCalculator = require('./scheduling/occurrenceCalculator');
const cronSync = require('./scheduling/cronSync');

const { HealthMonitor } = require('./health/healthMonitor');

/**
 * Composition root - the one place all the plain lib/ modules get wired together with
 * real config. Node-RED's settings.js constructs this once and exposes it via
 * functionGlobalContext.core, so Function nodes do `global.get('core')` rather than each
 * flow re-wiring dependencies by hand.
 *
 * This does NOT auto-open the OSC connection or start the health monitor - callers
 * (typically a Node-RED startup flow) explicitly call core.osc.client.open() and
 * core.health.start() once QLab connectivity is actually wanted, so this module stays
 * side-effect-free at construction time (easy to require in tests without a real socket).
 */
function createCore(config) {
  const db = openDatabase(config.dbPath);
  const zoneMap = loadZoneMap(config.zoneMapPath);

  const oscClient = new OscClient({
    localPort: config.localOscPort,
    remoteAddress: config.qlabOscHost,
    remotePort: config.qlabOscPort
  });
  const qlabProtocol = new QlabProtocol(oscClient);
  const healthMonitor = new HealthMonitor(qlabProtocol, oscClient);

  return {
    db: {
      connection: db,
      schedules: schedulesRepo,
      vogMessages: vogMessagesRepo,
      cueCache: cueCacheRepo
    },
    osc: {
      client: oscClient,
      protocol: qlabProtocol
    },
    zones: {
      map: zoneMap,
      resolveZonesForCue: (cueNumber) => zoneResolver.resolveZonesForCue(qlabProtocol, zoneMap, cueNumber),
      parseLevelsMatrix: zoneResolver.parseLevelsMatrix
    },
    scheduling: {
      validateSchedule,
      occurrenceCalculator,
      cronSync
    },
    health: healthMonitor
  };
}

module.exports = { createCore };

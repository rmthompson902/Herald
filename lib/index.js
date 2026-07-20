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
const { ZoneQueueEngine } = require('./queue/zoneQueueEngine');
const { triggerVog } = require('./vog/vogInterruptHandler');

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
  const queueEngine = new ZoneQueueEngine(qlabProtocol, { onEvent: config.onQueueEvent });

  // /update/.../cue_id/{uniqueId} pushes carry no payload (see qlab-osc-findings.md) - on
  // each one, ask the queue engine to check whether it's a uniqueId currently occupying a
  // zone, and if so confirm via a live isRunning query whether that zone just freed early.
  const updateAddressPattern = /^\/update\/workspace\/[^/]+\/cue_id\/([^/]+)$/;
  oscClient.on('message', (msg) => {
    const match = updateAddressPattern.exec(msg.address);
    if (match) queueEngine.handleQlabUpdate(match[1]);
  });

  const resolveZonesForCue = (cueNumber) => zoneResolver.resolveZonesForCue(qlabProtocol, zoneMap, cueNumber);

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
      resolveZonesForCue,
      parseLevelsMatrix: zoneResolver.parseLevelsMatrix
    },
    scheduling: {
      validateSchedule,
      occurrenceCalculator,
      cronSync
    },
    health: healthMonitor,
    queue: queueEngine,
    vog: {
      trigger: (vogMessage) =>
        triggerVog({ qlabProtocol, resolveZonesForCue, queueEngine }, vogMessage)
    }
  };
}

module.exports = { createCore };

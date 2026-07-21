'use strict';

const { openDatabase } = require('./db/database');
const schedulesRepo = require('./db/repositories/schedulesRepo');
const vogMessagesRepo = require('./db/repositories/vogMessagesRepo');
const cueCacheRepo = require('./db/repositories/cueCacheRepo');

const { OscClient } = require('./osc/oscClient');
const { QlabProtocol } = require('./osc/qlabProtocol');

const { loadAudioPatchMap } = require('./zones/audioPatchMap');
const zoneResolver = require('./zones/zoneResolver');
const { playCueAndWaitForDuration } = require('./zones/duckDuration');

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
  const { patchToZone, zoneConfig } = loadAudioPatchMap(config.audioPatchMapPath);

  const oscClient = new OscClient({
    localPort: config.localOscPort,
    remoteAddress: config.qlabOscHost,
    remotePort: config.qlabOscPort
  });
  const qlabProtocol = new QlabProtocol(oscClient);
  const healthMonitor = new HealthMonitor(qlabProtocol, oscClient);

  // The engine only ever decides WHEN to duck/unduck a zone (see zoneQueueEngine.js) -
  // issuing the actual OSC call and waiting out the duck/unduck cue's own real completion
  // is the caller's job, same split as preemptZones/vogInterruptHandler. The engine AWAITS
  // this before firing the message (duck) / before considering the zone free (unduck) - see
  // playCueAndWaitForDuration. Best-effort: a failed duck/unduck must never crash the engine
  // or block a real message from firing.
  const onZoneTransition = (kind, zoneName) => {
    const cfg = zoneConfig.get(zoneName);
    if (!cfg) return Promise.resolve(); // startup validation (see fn_startup) should make this unreachable
    const cueNumber = kind === 'duck' ? cfg.duckCueNumber : cfg.unduckCueNumber;
    return playCueAndWaitForDuration(qlabProtocol, cueNumber);
  };
  const queueEngine = new ZoneQueueEngine(qlabProtocol, { onEvent: config.onQueueEvent, onZoneTransition });

  // /update/.../cue_id/{uniqueId} pushes carry no payload (see qlab-osc-findings.md) - on
  // each one, ask the queue engine to check whether it's a uniqueId currently occupying a
  // zone, and if so confirm via a live isRunning query whether that zone just freed early.
  const updateAddressPattern = /^\/update\/workspace\/[^/]+\/cue_id\/([^/]+)$/;
  oscClient.on('message', (msg) => {
    const match = updateAddressPattern.exec(msg.address);
    if (match) queueEngine.handleQlabUpdate(match[1]);
  });

  const resolveZonesForCue = (cueNumber) => zoneResolver.resolveZonesForCue(qlabProtocol, patchToZone, cueNumber);

  // Each of a cue's zones' own discrete duration, rather than one shared duration - matters
  // for a Group cue whose children are scoped to different zones, since QLab reports the
  // group's own duration as its longest child's (see zoneResolver.js).
  const resolveDurationSecondsByZone = (cueNumber) =>
    zoneResolver.resolveDurationSecondsByZone(qlabProtocol, patchToZone, cueNumber);

  // VOG ducks a zone immediately and directly (see vogInterruptHandler.js), bypassing the
  // queue engine's own batched duck-on-first-occupant timing given VOG's urgency.
  const duckImmediately = (zoneName) => {
    const cfg = zoneConfig.get(zoneName);
    if (!cfg) return Promise.resolve();
    return Promise.resolve(qlabProtocol.playCue(cfg.duckCueNumber));
  };

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
      patchToZone,
      config: zoneConfig,
      resolveZonesForCue,
      resolveDurationSecondsByZone
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
        triggerVog(
          { qlabProtocol, resolveZonesForCue, resolveDurationSecondsByZone, queueEngine, duckImmediately },
          vogMessage
        )
    }
  };
}

module.exports = { createCore };

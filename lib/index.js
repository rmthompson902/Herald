'use strict';

const { openDatabase } = require('./db/database');
const schedulesRepo = require('./db/repositories/schedulesRepo');
const vogMessagesRepo = require('./db/repositories/vogMessagesRepo');
const cueCacheRepo = require('./db/repositories/cueCacheRepo');

const { OscClient } = require('./osc/oscClient');
const { QlabProtocol } = require('./osc/qlabProtocol');

const { loadAudioPatchMap, saveAudioPatchMap } = require('./zones/audioPatchMap');
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

  // Re-reads config/audio-patch-map.json and repopulates the EXISTING patchToZone/zoneConfig
  // Map objects in place (never replacing the references) - every closure below that already
  // captured one of these two Maps (onZoneTransition, duckImmediately,
  // resolveZoneDetailsForCue) sees a saved zone-config change immediately, with no Node-RED
  // restart needed. Called by the Zones admin UI's write endpoints after a successful
  // saveAudioPatchMap(). Reads and validates the fresh file BEFORE clearing anything, so a
  // failed reload (e.g. the file was hand-edited into an invalid state after the fact)
  // leaves the current in-memory config untouched rather than half-updated.
  const reloadZones = () => {
    const fresh = loadAudioPatchMap(config.audioPatchMapPath);
    patchToZone.clear();
    for (const [patchId, zoneName] of fresh.patchToZone) patchToZone.set(patchId, zoneName);
    zoneConfig.clear();
    for (const [zoneName, cfg] of fresh.zoneConfig) zoneConfig.set(zoneName, cfg);
  };

  // Validates + writes a complete new zones object (see saveAudioPatchMap) then reloads -
  // the one call the Zones admin UI's write endpoints need, keeping config.audioPatchMapPath
  // and the save/reload ordering fully encapsulated here rather than known to flows.json.
  // Throws (and never reloads) on an invalid zones object, same as saveAudioPatchMap itself.
  const saveZones = (zones) => {
    saveAudioPatchMap(config.audioPatchMapPath, zones);
    reloadZones();
  };

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

  // Every inbound OSC message - matched replies, denials, and unsolicited pushes alike -
  // logged to app-*.log so nothing QLab sends is ever silently dropped with no durable
  // trace (found via a real investigation: a denied/aborted cue start produces no /reply
  // and only an early /update push, which nothing previously logged anywhere). Denial-
  // shaped envelopes (`{"status": "error", ...}`, QLab's own shape for a rejected request)
  // are bumped to warn so they're visible at the default console level too, not just in the
  // file; everything else logs at debug (matched replies, /update pushes, /thump, etc.) -
  // this listener never interprets or acts on a message, it only records it, so it can't
  // itself introduce a behavior change or a new failure mode.
  if (config.appLogger) {
    const oscLog = config.appLogger('oscClient');
    oscClient.on('message', (msg) => {
      let payload;
      try {
        payload = msg.args && msg.args[0] ? JSON.parse(msg.args[0].value) : undefined;
      } catch {
        payload = undefined;
      }
      const argsText = payload !== undefined ? JSON.stringify(payload) : JSON.stringify(msg.args ?? []);
      if (payload && payload.status && payload.status !== 'ok') {
        oscLog.warn(`${msg.address} ${argsText}`);
      } else {
        oscLog.debug(`${msg.address} ${argsText}`);
      }
    });
  }

  // Each of a cue's zones' own complete play details (specific child cue number, duration,
  // uniqueId) rather than one shared value assumed to apply to every zone - matters for a
  // Group cue whose children are scoped to different zones, since QLab reports the group's
  // own duration as its longest child's (see zoneResolver.js). This is what lets
  // zoneQueueEngine fire and track each zone's own child cue independently.
  const resolveZoneDetailsForCue = (cueNumber) =>
    zoneResolver.resolveZoneDetailsForCue(qlabProtocol, patchToZone, cueNumber);

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
      resolveZoneDetailsForCue,
      reload: reloadZones,
      save: saveZones
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
        triggerVog({ qlabProtocol, resolveZoneDetailsForCue, queueEngine, duckImmediately }, vogMessage)
    }
  };
}

module.exports = { createCore };

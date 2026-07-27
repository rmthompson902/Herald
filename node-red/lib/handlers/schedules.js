'use strict';

// Schedule-related Node-RED endpoint/flow handlers, extracted verbatim from the flows.json
// function nodes so the branching (health-gating, validation error envelopes, cron-sync
// directive translation, live cue-cache refresh) is plain, dependency-injected, and unit
// testable. Each handler takes the Node-RED (msg, node) and returns exactly what the
// original function node returned - a single msg, a [outputs] array, or null - so the
// flows.json wrappers stay one-liners.

const { warnUnmappedLeafCues } = require('./util');

function createScheduleHandlers({ core, cronSyncMessages, refreshCueCache }) {
  // cron-plus fires this via msg.topic === `sched-<id>`; anything else on the wire is a
  // cron-plus command-response/status message, not a fire event - ignore it.
  function onDue(msg, node) {
    if (!msg.topic || !msg.topic.startsWith('sched-')) {
      return null;
    }

    const scheduleId = Number(msg.topic.replace('sched-', ''));
    const schedule = core.db.schedules.getById(core.db.connection, scheduleId);

    if (!schedule) {
      node.warn(`No schedule found in DB for ${msg.topic} (deleted since being scheduled?)`);
      return null;
    }

    if (!core.health.isArmed()) {
      node.warn(
        `Skipping ${schedule.qlabCueNumber}: QLab not confirmed live (health state: ${core.health.getState()})`
      );
      return null;
    }

    return (async () => {
      // Live-resolve zones/duration/per-zone play details (also refreshes cue_cache as a
      // side effect) rather than trusting a possibly-stale cache entry for a collision
      // decision. zoneDetails is what lets zoneQueueEngine fire/free each zone of a
      // multi-zone Group cue independently (see zoneResolver.resolveZoneDetailsForCue).
      const cue = await refreshCueCache(core, schedule.qlabCueNumber);
      if (cue.error) {
        node.warn(
          `Skipping ${schedule.qlabCueNumber}: failed to resolve zones/duration live (${cue.error})`
        );
        return null;
      }

      const { fired } = await core.queue.enqueue({
        id: `sched-${scheduleId}-${Date.now()}`,
        dedupeKey: `schedule-${scheduleId}`,
        scheduleId,
        cueNumber: schedule.qlabCueNumber,
        qlabInternalId: cue.qlabInternalId,
        zones: cue.zones,
        zoneDetails: cue.zoneDetails,
        durationSeconds: cue.durationSeconds,
        dueAt: Date.now(),
        name: schedule.name,
        cueDisplayName: cue.cueDisplayName
      });

      return {
        payload: `${fired ? 'Fired' : 'Queued'} ${schedule.qlabCueNumber} (schedule ${scheduleId}: ${schedule.name})`
      };
    })();
  }

  function createSchedule(msg, node) {
    let schedule;
    try {
      const validated = core.scheduling.validateSchedule(msg.payload || {});
      schedule = core.db.schedules.create(core.db.connection, validated);
    } catch (err) {
      msg.statusCode = 400;
      msg.payload = { status: 'error', message: err.message };
      return [null, msg];
    }

    const directives = core.scheduling.cronSync.syncOne(core.db.connection, schedule.id);
    const cronMsgs = cronSyncMessages.toCronPlusMessages(directives);

    return (async () => {
      const cacheResult = await refreshCueCache(core, schedule.qlabCueNumber);
      if (cacheResult && cacheResult.error) {
        node.warn(`cue_cache refresh failed for ${schedule.qlabCueNumber}: ${cacheResult.error}`);
      }
      warnUnmappedLeafCues(node, cacheResult, schedule.qlabCueNumber);

      msg.statusCode = 201;
      msg.payload = { status: 'success', schedule };
      return [cronMsgs, msg];
    })();
  }

  function updateSchedule(msg, node) {
    const id = Number(msg.req.params.id);

    let schedule;
    try {
      const validated = core.scheduling.validateSchedule(msg.payload || {});
      schedule = core.db.schedules.update(core.db.connection, id, validated);
    } catch (err) {
      msg.statusCode = 400;
      msg.payload = { status: 'error', message: err.message };
      return [null, msg];
    }

    if (!schedule) {
      msg.statusCode = 404;
      msg.payload = { status: 'error', message: `Schedule ${id} not found` };
      return [null, msg];
    }

    const directives = core.scheduling.cronSync.syncOne(core.db.connection, id);
    const cronMsgs = cronSyncMessages.toCronPlusMessages(directives);

    return (async () => {
      const cacheResult = await refreshCueCache(core, schedule.qlabCueNumber);
      if (cacheResult && cacheResult.error) {
        node.warn(`cue_cache refresh failed for ${schedule.qlabCueNumber}: ${cacheResult.error}`);
      }
      warnUnmappedLeafCues(node, cacheResult, schedule.qlabCueNumber);

      msg.statusCode = 200;
      msg.payload = { status: 'success', schedule };
      return [cronMsgs, msg];
    })();
  }

  function deleteSchedule(msg, _node) {
    const id = Number(msg.req.params.id);

    const existing = core.db.schedules.getById(core.db.connection, id);
    if (!existing) {
      msg.statusCode = 404;
      msg.payload = { status: 'error', message: `Schedule ${id} not found` };
      return [null, msg];
    }

    const removeMsg = { payload: core.scheduling.cronSync.toRemoveCommand(id) };
    core.db.schedules.remove(core.db.connection, id);

    msg.statusCode = 200;
    msg.payload = { status: 'success' };
    return [[removeMsg], msg];
  }

  function toggleSchedule(msg, _node) {
    const id = Number(msg.req.params.id);

    const existing = core.db.schedules.getById(core.db.connection, id);
    if (!existing) {
      msg.statusCode = 404;
      msg.payload = { status: 'error', message: `Schedule ${id} not found` };
      return [null, msg];
    }

    const schedule = core.db.schedules.setEnabled(core.db.connection, id, !existing.enabled);

    const directives = core.scheduling.cronSync.syncOne(core.db.connection, id);
    const cronMsgs = cronSyncMessages.toCronPlusMessages(directives);

    msg.statusCode = 200;
    msg.payload = { status: 'success', schedule };
    return [cronMsgs, msg];
  }

  // Goes through the exact same zoneQueueEngine as a real schedule fire - a UI convenience
  // button isn't allowed to be the one thing that can overlap audio (see plan / ADR 0001).
  // No dedupeKey: play-now never stale-drops anything and is never stale-dropped itself.
  function playNow(msg, node) {
    const id = Number(msg.req.params.id);

    const schedule = core.db.schedules.getById(core.db.connection, id);
    if (!schedule) {
      msg.statusCode = 404;
      msg.payload = { status: 'error', message: `Schedule ${id} not found` };
      return msg;
    }

    if (!core.health.isArmed()) {
      msg.statusCode = 503;
      msg.payload = { status: 'error', message: 'qlab_disconnected' };
      return msg;
    }

    return (async () => {
      const cue = await refreshCueCache(core, schedule.qlabCueNumber);
      if (cue.error) {
        msg.statusCode = 502;
        msg.payload = { status: 'error', message: `Could not resolve cue from QLab: ${cue.error}` };
        return msg;
      }
      warnUnmappedLeafCues(node, cue, schedule.qlabCueNumber);

      const { fired } = await core.queue.enqueue({
        id: `playnow-${id}-${Date.now()}`,
        scheduleId: id,
        cueNumber: schedule.qlabCueNumber,
        qlabInternalId: cue.qlabInternalId,
        zones: cue.zones,
        zoneDetails: cue.zoneDetails,
        durationSeconds: cue.durationSeconds,
        dueAt: Date.now(),
        name: schedule.name,
        cueDisplayName: cue.cueDisplayName
      });

      msg.statusCode = 200;
      msg.payload = { status: 'success', queued: !fired };
      return msg;
    })();
  }

  // One rebuildAll rather than N syncOne calls - it always wipes every dynamic cron-plus job
  // first (idempotent by construction, same as fn_startup's own use), so this stays correct
  // however many schedules exist.
  function bulkSetEnabledSchedules(msg, _node) {
    const enabled = !!(msg.payload && msg.payload.enabled);

    const schedules = core.db.schedules.listAll(core.db.connection);
    for (const schedule of schedules) {
      core.db.schedules.setEnabled(core.db.connection, schedule.id, enabled);
    }

    const directives = core.scheduling.cronSync.rebuildAll(core.db.connection);
    const cronMsgs = cronSyncMessages.toCronPlusMessages(directives);

    msg.statusCode = 200;
    msg.payload = { status: 'success', updated: schedules.length, enabled };
    return [cronMsgs, msg];
  }

  return {
    onDue,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    toggleSchedule,
    playNow,
    bulkSetEnabledSchedules
  };
}

module.exports = { createScheduleHandlers };

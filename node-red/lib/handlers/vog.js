'use strict';

// VOG (Voice of God / emergency) endpoint handlers, extracted from flows.json. VOG messages
// are manual-trigger only (no cron-plus sync). Trigger is gated on both `enabled` (enabled
// IS armed for VOG - see docs/claude-plan.md) and live QLab connectivity.

const { warnUnmappedLeafCues } = require('./util');

function createVogHandlers({ core, refreshCueCache }) {
  function createVog(msg, node) {
    const p = msg.payload || {};

    if (!p.name || !p.qlabCueNumber) {
      msg.statusCode = 400;
      msg.payload = { status: 'error', message: 'name and qlabCueNumber are required' };
      return msg;
    }

    const vogMessage = core.db.vogMessages.create(core.db.connection, {
      name: p.name,
      qlabCueNumber: p.qlabCueNumber,
      enabled: p.enabled !== false
    });

    return (async () => {
      const cacheResult = await refreshCueCache(core, vogMessage.qlabCueNumber);
      if (cacheResult && cacheResult.error) {
        node.warn(`cue_cache refresh failed for ${vogMessage.qlabCueNumber}: ${cacheResult.error}`);
      }
      warnUnmappedLeafCues(node, cacheResult, vogMessage.qlabCueNumber);

      msg.statusCode = 201;
      msg.payload = { status: 'success', vogMessage };
      return msg;
    })();
  }

  function updateVog(msg, node) {
    const id = Number(msg.req.params.id);
    const p = msg.payload || {};

    if (!p.name || !p.qlabCueNumber) {
      msg.statusCode = 400;
      msg.payload = { status: 'error', message: 'name and qlabCueNumber are required' };
      return msg;
    }

    const vogMessage = core.db.vogMessages.update(core.db.connection, id, {
      name: p.name,
      qlabCueNumber: p.qlabCueNumber,
      enabled: p.enabled !== false
    });

    if (!vogMessage) {
      msg.statusCode = 404;
      msg.payload = { status: 'error', message: `VOG message ${id} not found` };
      return msg;
    }

    return (async () => {
      const cacheResult = await refreshCueCache(core, vogMessage.qlabCueNumber);
      if (cacheResult && cacheResult.error) {
        node.warn(`cue_cache refresh failed for ${vogMessage.qlabCueNumber}: ${cacheResult.error}`);
      }
      warnUnmappedLeafCues(node, cacheResult, vogMessage.qlabCueNumber);

      msg.statusCode = 200;
      msg.payload = { status: 'success', vogMessage };
      return msg;
    })();
  }

  function deleteVog(msg, _node) {
    const id = Number(msg.req.params.id);

    const existing = core.db.vogMessages.getById(core.db.connection, id);
    if (!existing) {
      msg.statusCode = 404;
      msg.payload = { status: 'error', message: `VOG message ${id} not found` };
      return msg;
    }

    core.db.vogMessages.remove(core.db.connection, id);
    msg.statusCode = 200;
    msg.payload = { status: 'success' };
    return msg;
  }

  function toggleVog(msg, _node) {
    const id = Number(msg.req.params.id);

    const existing = core.db.vogMessages.getById(core.db.connection, id);
    if (!existing) {
      msg.statusCode = 404;
      msg.payload = { status: 'error', message: `VOG message ${id} not found` };
      return msg;
    }

    const vogMessage = core.db.vogMessages.setEnabled(core.db.connection, id, !existing.enabled);

    msg.statusCode = 200;
    msg.payload = { status: 'success', vogMessage };
    return msg;
  }

  // Stops everything currently playing in this VOG cue's own auto-derived zone scope, drops
  // anything queued there (no requeue), then plays the VOG cue into that same scope - see
  // lib/vog/vogInterruptHandler.js and ADR 0001 decision 9.
  function triggerVog(msg, _node) {
    const id = Number(msg.req.params.id);

    const vogMessage = core.db.vogMessages.getById(core.db.connection, id);
    if (!vogMessage) {
      msg.statusCode = 404;
      msg.payload = { status: 'error', message: `VOG message ${id} not found` };
      return msg;
    }

    if (!vogMessage.enabled) {
      msg.statusCode = 400;
      msg.payload = {
        status: 'error',
        message: 'VOG message is disabled - enable it before triggering'
      };
      return msg;
    }

    if (!core.health.isArmed()) {
      msg.statusCode = 503;
      msg.payload = { status: 'error', message: 'qlab_disconnected' };
      return msg;
    }

    return (async () => {
      const { fired, zones } = await core.vog.trigger(vogMessage);
      msg.statusCode = 200;
      msg.payload = { status: 'success', fired, zones };
      return msg;
    })();
  }

  // VOG messages are manual-trigger only (no cron-plus sync involved), so this is just a
  // per-row setEnabled loop - unlike the schedules equivalent, there's no scheduler state to
  // rebuild afterward.
  function bulkSetEnabledVog(msg, _node) {
    const enabled = !!(msg.payload && msg.payload.enabled);

    const vogMessages = core.db.vogMessages.listAll(core.db.connection);
    for (const vogMessage of vogMessages) {
      core.db.vogMessages.setEnabled(core.db.connection, vogMessage.id, enabled);
    }

    msg.statusCode = 200;
    msg.payload = { status: 'success', updated: vogMessages.length, enabled };
    return msg;
  }

  return { createVog, updateVog, deleteVog, toggleVog, triggerVog, bulkSetEnabledVog };
}

module.exports = { createVogHandlers };

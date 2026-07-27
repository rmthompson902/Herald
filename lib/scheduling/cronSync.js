'use strict';

const schedulesRepo = require('../db/repositories/schedulesRepo');
const { occurrencesUntil } = require('./occurrenceCalculator');

// How far ahead to pre-compute a schedule's fire dates. cron-plus's `expressionType:
// "dates"` mode takes a fixed list, not a perpetual generator (confirmed against its real
// source/examples - see test/fixtures/qlab-osc-findings.md's sibling cron-plus notes),
// so this needs periodic re-topping-up before it runs out, not just an on-change sync.
// Sized in hours (not a fixed occurrence count) so it scales sensibly regardless of
// intervalSeconds.
const DEFAULT_WINDOW_HOURS = 48;

function jobName(scheduleId) {
  return `sched-${scheduleId}`;
}

/**
 * Builds the cron-plus "add" command payload for one schedule, or null if it has no
 * occurrences in the window (e.g. its date range has already ended).
 *
 * This is NOT a Node-RED msg - it's the plain command object that belongs in msg.payload
 * when sent into the cronplus node (confirmed against its real add-command handler:
 * name/expressionType/expression, `type` and `payloadType` are accepted as aliases).
 */
function toAddCommand(scheduleRow, { from = new Date(), windowHours = DEFAULT_WINDOW_HOURS } = {}) {
  const until = new Date(from.getTime() + windowHours * 3600 * 1000);
  const occurrences = occurrencesUntil(scheduleRow, from, until);

  if (occurrences.length === 0) return null;

  return {
    command: 'add',
    name: jobName(scheduleRow.id),
    topic: jobName(scheduleRow.id),
    expressionType: 'dates',
    expression: occurrences.map((d) => d.getTime()).join(','),
    payloadType: 'default'
  };
}

function toRemoveCommand(scheduleId) {
  return { command: 'remove', name: jobName(scheduleId) };
}

/**
 * Directives for a single schedule: always remove any existing job first (idempotent -
 * harmless if none exists), then add fresh if it's enabled and has occurrences in the
 * window. Returns plain directive objects for a Function node to translate into actual
 * Node-RED msgs sent to the cronplus node - cronSync itself never imports cron-plus or
 * touches Node-RED's msg shape.
 */
function syncOne(db, scheduleId, options = {}) {
  const schedule = schedulesRepo.getById(db, scheduleId);
  const directives = [{ toRemove: toRemoveCommand(scheduleId) }];

  if (schedule && schedule.enabled) {
    const addCommand = toAddCommand(schedule, options);
    if (addCommand) directives.push({ toAdd: addCommand });
  }

  return directives;
}

/**
 * Directives to rebuild every enabled schedule's cron-plus job from scratch - used on
 * Node-RED startup (restart-safety: SQLite is the source of truth, cron-plus's own state
 * is fully disposable and rebuilt from it) and on a periodic maintenance tick to keep
 * every schedule's dates list topped up before it's exhausted.
 */
function rebuildAll(db, options = {}) {
  const directives = [{ toRemoveAllDynamic: true }];

  for (const schedule of schedulesRepo.listEnabled(db)) {
    const addCommand = toAddCommand(schedule, options);
    if (addCommand) directives.push({ toAdd: addCommand });
  }

  return directives;
}

module.exports = {
  jobName,
  toAddCommand,
  toRemoveCommand,
  syncOne,
  rebuildAll,
  DEFAULT_WINDOW_HOURS
};

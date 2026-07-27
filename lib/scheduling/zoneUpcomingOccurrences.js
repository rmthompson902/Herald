'use strict';

const DEFAULT_COUNT = 25;

/**
 * Merged, paginated "what's coming up next in this zone" for the queue visualizer -
 * every enabled schedule whose cue resolves to `zone`, projected forward via
 * occurrenceCalculator.nextOccurrences and interleaved by fire time.
 *
 * Zone resolution deliberately uses the same cheap, cached path
 * webapp/app/routers/pages.py's _render_schedules_list already uses (a SQLite join
 * against cue_cache.zones) rather than zones/zoneResolver.js's resolveZoneDetailsForCue,
 * which does a live OSC round-trip per call - that's fine at real fire-time (one call per
 * actual fire) but would hammer the OSC connection if called on every page load/scroll
 * here. A schedule with no cue_cache row yet (never resolved) is simply excluded, same as
 * that page's "Not Yet Assigned" bucket - not an error.
 *
 * @param {object} db - better-sqlite3 connection
 * @param {string} zone
 * @param {{ schedulesRepo: object, cueCacheRepo: object, nextOccurrences: Function }} deps - injectable for tests
 * @param {{ from?: Date, offset?: number, count?: number, liveScheduleIds?: Set<number> }} [options]
 * @returns {{ occurrences: Array<{scheduleId, name, qlabCueNumber, cueDisplayName, dueAt, durationSeconds}>, hasMore: boolean }}
 */
function getUpcomingOccurrencesForZone(db, zone, deps, options = {}) {
  const { schedulesRepo, cueCacheRepo, nextOccurrences } = deps;
  const { from = new Date(), offset = 0, count = DEFAULT_COUNT, liveScheduleIds = new Set() } = options;

  const schedules = schedulesRepo.listEnabled(db);
  // +1 beyond the page end, from EVERY schedule, so hasMore can be determined correctly: in
  // a k-way merge of ascending streams, an element at global rank r can never have a local
  // rank (within its own stream) greater than r, so asking each stream for its first
  // (offset+count+1) elements is guaranteed sufficient to both fill the page and correctly
  // detect whether a next element exists, however the schedules interleave.
  const depth = offset + count + 1;

  const merged = [];
  for (const schedule of schedules) {
    const cue = cueCacheRepo.getByCueNumber(db, schedule.qlabCueNumber);
    if (!cue || !cue.zones.includes(zone)) continue;

    let occurrences = nextOccurrences(schedule, from, depth);
    // A schedule with a live occupancy/queued entry in this zone has already "spoken for"
    // its own next due moment - drop only that one occurrence so it isn't double-shown
    // once here (as a projection) and once via the engine's own live queued/occupancy
    // entries, which the caller merges in separately.
    if (liveScheduleIds.has(schedule.id)) {
      occurrences = occurrences.slice(1);
    }

    for (const dueAt of occurrences) {
      merged.push({
        scheduleId: schedule.id,
        name: schedule.name,
        qlabCueNumber: schedule.qlabCueNumber,
        cueDisplayName: cue.cueDisplayName,
        dueAt: dueAt.toISOString(),
        durationSeconds: cue.durationSeconds ?? null
      });
    }
  }

  merged.sort((a, b) => {
    if (a.dueAt !== b.dueAt) return a.dueAt < b.dueAt ? -1 : 1;
    return a.qlabCueNumber < b.qlabCueNumber ? -1 : a.qlabCueNumber > b.qlabCueNumber ? 1 : 0;
  });

  const page = merged.slice(offset, offset + count);
  const hasMore = merged.length > offset + count;

  return { occurrences: page, hasMore };
}

module.exports = { getUpcomingOccurrencesForZone };

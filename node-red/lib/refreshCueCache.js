'use strict';

// Best-effort cue_cache refresh: fetches this cue's duration/zones/internal-id live from
// QLab and upserts into cue_cache (see lib/db/repositories/cueCacheRepo.js - cached-only,
// never authoritative). Failure here must never block a schedule save or startup - if
// QLab is briefly unreachable, the schedule still saves/fires correctly, the cache just
// stays stale until the next successful refresh.
//
// Also returns `zoneDetails` (each zone's own specific child cue number/duration/uniqueId -
// see zoneResolver.resolveZoneDetailsForCue) alongside the cached summary, so callers that
// need to enqueue a per-zone-independent fire (fn_on_due/fn_play_now/vogInterruptHandler)
// get everything they need from this ONE call - no separate resolveDurationSecondsByZone
// round trip, and no separate failure-tolerance layer needed on top: this function's
// existing try/catch already converts any resolution failure (including a losing race on
// the shared getCueLists() query) to `{ error }`, which every one of those callers already
// checks before proceeding.
async function refreshCueCache(core, qlabCueNumber) {
  try {
    const [duration, { zones, zoneDetails }, qlabInternalId] = await Promise.all([
      core.osc.protocol.getDuration(qlabCueNumber),
      core.zones.resolveZoneDetailsForCue(qlabCueNumber),
      core.osc.protocol.getUniqueId(qlabCueNumber)
    ]);

    const cached = core.db.cueCache.upsert(core.db.connection, {
      qlabCueNumber,
      qlabInternalId,
      durationSeconds: duration,
      zones
    });
    return { ...cached, zoneDetails };
  } catch (err) {
    return { error: err.message };
  }
}

// Refreshes every cue referenced by any schedule or VOG message - shared by the startup
// warm-up (fn_startup) and the periodic background sweep (fn_periodic_cue_refresh), so
// both use identical logic instead of near-duplicate copies.
async function refreshAllReferencedCues(core, refreshCueCacheFn) {
  const cueNumbers = new Set([
    ...core.db.schedules.listAll(core.db.connection).map((s) => s.qlabCueNumber),
    ...core.db.vogMessages.listAll(core.db.connection).map((v) => v.qlabCueNumber)
  ]);

  const results = {};
  for (const cueNumber of cueNumbers) {
    results[cueNumber] = await refreshCueCacheFn(core, cueNumber);
  }
  return results;
}

module.exports = { refreshCueCache, refreshAllReferencedCues };

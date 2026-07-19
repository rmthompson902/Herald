'use strict';

// Best-effort cue_cache refresh: fetches this cue's duration/zones/internal-id live from
// QLab and upserts into cue_cache (see lib/db/repositories/cueCacheRepo.js - cached-only,
// never authoritative). Failure here must never block a schedule save or startup - if
// QLab is briefly unreachable, the schedule still saves/fires correctly, the cache just
// stays stale until the next successful refresh.
async function refreshCueCache(core, qlabCueNumber) {
  try {
    const [duration, zones, qlabInternalId] = await Promise.all([
      core.osc.protocol.getDuration(qlabCueNumber),
      core.zones.resolveZonesForCue(qlabCueNumber),
      core.osc.protocol.getUniqueId(qlabCueNumber)
    ]);

    return core.db.cueCache.upsert(core.db.connection, {
      qlabCueNumber,
      qlabInternalId,
      durationSeconds: duration,
      zones
    });
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { refreshCueCache };

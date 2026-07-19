'use strict';

// cue_cache is cached-only, never authoritative - safe to wipe/rebuild anytime (see plan).

function fromRow(row) {
  if (!row) return null;
  return {
    qlabCueNumber: row.qlab_cue_number,
    qlabInternalId: row.qlab_internal_id,
    cueDisplayName: row.cue_display_name,
    durationSeconds: row.duration_seconds,
    zones: row.zones ? JSON.parse(row.zones) : [],
    refreshedAt: row.refreshed_at
  };
}

function upsert(db, entry) {
  db.prepare(
    `INSERT INTO cue_cache (qlab_cue_number, qlab_internal_id, cue_display_name, duration_seconds, zones, refreshed_at)
     VALUES (@qlabCueNumber, @qlabInternalId, @cueDisplayName, @durationSeconds, @zones, @refreshedAt)
     ON CONFLICT(qlab_cue_number) DO UPDATE SET
       qlab_internal_id = excluded.qlab_internal_id,
       cue_display_name = excluded.cue_display_name,
       duration_seconds = excluded.duration_seconds,
       zones = excluded.zones,
       refreshed_at = excluded.refreshed_at`
  ).run({
    qlabCueNumber: entry.qlabCueNumber,
    qlabInternalId: entry.qlabInternalId ?? null,
    cueDisplayName: entry.cueDisplayName ?? null,
    durationSeconds: entry.durationSeconds ?? null,
    zones: JSON.stringify(entry.zones ?? []),
    refreshedAt: new Date().toISOString()
  });

  return getByCueNumber(db, entry.qlabCueNumber);
}

function getByCueNumber(db, qlabCueNumber) {
  return fromRow(db.prepare('SELECT * FROM cue_cache WHERE qlab_cue_number = ?').get(qlabCueNumber));
}

function getByInternalId(db, qlabInternalId) {
  return fromRow(
    db.prepare('SELECT * FROM cue_cache WHERE qlab_internal_id = ?').get(qlabInternalId)
  );
}

function listAll(db) {
  return db.prepare('SELECT * FROM cue_cache ORDER BY qlab_cue_number').all().map(fromRow);
}

module.exports = { upsert, getByCueNumber, getByInternalId, listAll };

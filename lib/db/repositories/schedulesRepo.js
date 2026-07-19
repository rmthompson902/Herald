'use strict';

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    qlabCueNumber: row.qlab_cue_number,
    intervalSeconds: row.interval_seconds,
    startTime: row.start_time,
    endTime: row.end_time,
    weekdays: JSON.parse(row.weekdays),
    dateRangeStart: row.date_range_start,
    dateRangeEnd: row.date_range_end,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function create(db, schedule) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO schedules
        (name, qlab_cue_number, interval_seconds, start_time, end_time, weekdays,
         date_range_start, date_range_end, enabled, created_at, updated_at)
       VALUES (@name, @qlabCueNumber, @intervalSeconds, @startTime, @endTime, @weekdays,
         @dateRangeStart, @dateRangeEnd, @enabled, @createdAt, @updatedAt)`
    )
    .run({
      name: schedule.name,
      qlabCueNumber: schedule.qlabCueNumber,
      intervalSeconds: schedule.intervalSeconds ?? null,
      startTime: schedule.startTime ?? null,
      endTime: schedule.endTime ?? null,
      weekdays: JSON.stringify(schedule.weekdays ?? [1, 2, 3, 4, 5, 6, 7]),
      dateRangeStart: schedule.dateRangeStart ?? null,
      dateRangeEnd: schedule.dateRangeEnd ?? null,
      enabled: schedule.enabled === false ? 0 : 1,
      createdAt: now,
      updatedAt: now
    });

  return getById(db, result.lastInsertRowid);
}

function update(db, id, changes) {
  const existing = getById(db, id);
  if (!existing) return null;

  const merged = { ...existing, ...changes, updatedAt: new Date().toISOString() };

  db.prepare(
    `UPDATE schedules SET
        name = @name,
        qlab_cue_number = @qlabCueNumber,
        interval_seconds = @intervalSeconds,
        start_time = @startTime,
        end_time = @endTime,
        weekdays = @weekdays,
        date_range_start = @dateRangeStart,
        date_range_end = @dateRangeEnd,
        enabled = @enabled,
        updated_at = @updatedAt
     WHERE id = @id`
  ).run({
    id,
    name: merged.name,
    qlabCueNumber: merged.qlabCueNumber,
    intervalSeconds: merged.intervalSeconds ?? null,
    startTime: merged.startTime ?? null,
    endTime: merged.endTime ?? null,
    weekdays: JSON.stringify(merged.weekdays ?? [1, 2, 3, 4, 5, 6, 7]),
    dateRangeStart: merged.dateRangeStart ?? null,
    dateRangeEnd: merged.dateRangeEnd ?? null,
    enabled: merged.enabled === false ? 0 : 1,
    updatedAt: merged.updatedAt
  });

  return getById(db, id);
}

function setEnabled(db, id, enabled) {
  return update(db, id, { enabled: Boolean(enabled) });
}

function remove(db, id) {
  db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
}

function getById(db, id) {
  return fromRow(db.prepare('SELECT * FROM schedules WHERE id = ?').get(id));
}

function listAll(db) {
  return db.prepare('SELECT * FROM schedules ORDER BY id').all().map(fromRow);
}

function listEnabled(db) {
  return db.prepare('SELECT * FROM schedules WHERE enabled = 1 ORDER BY id').all().map(fromRow);
}

module.exports = { create, update, setEnabled, remove, getById, listAll, listEnabled };

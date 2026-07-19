'use strict';

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    qlabCueNumber: row.qlab_cue_number,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function create(db, vogMessage) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO vog_messages (name, qlab_cue_number, enabled, created_at, updated_at)
       VALUES (@name, @qlabCueNumber, @enabled, @createdAt, @updatedAt)`
    )
    .run({
      name: vogMessage.name,
      qlabCueNumber: vogMessage.qlabCueNumber,
      enabled: vogMessage.enabled === false ? 0 : 1,
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
    `UPDATE vog_messages SET name = @name, qlab_cue_number = @qlabCueNumber,
       enabled = @enabled, updated_at = @updatedAt
     WHERE id = @id`
  ).run({
    id,
    name: merged.name,
    qlabCueNumber: merged.qlabCueNumber,
    enabled: merged.enabled === false ? 0 : 1,
    updatedAt: merged.updatedAt
  });

  return getById(db, id);
}

function setEnabled(db, id, enabled) {
  return update(db, id, { enabled: Boolean(enabled) });
}

function remove(db, id) {
  db.prepare('DELETE FROM vog_messages WHERE id = ?').run(id);
}

function getById(db, id) {
  return fromRow(db.prepare('SELECT * FROM vog_messages WHERE id = ?').get(id));
}

function listAll(db) {
  return db.prepare('SELECT * FROM vog_messages ORDER BY id').all().map(fromRow);
}

function listEnabled(db) {
  return db.prepare('SELECT * FROM vog_messages WHERE enabled = 1 ORDER BY id').all().map(fromRow);
}

module.exports = { create, update, setEnabled, remove, getById, listAll, listEnabled };

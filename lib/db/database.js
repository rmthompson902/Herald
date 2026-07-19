'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { runMigrations } = require('./migrations/runner');

/**
 * Opens (creating if needed) a SQLite database at dbPath, applies PRAGMA settings, and
 * runs any pending migrations. Safe to call multiple times with the same path (e.g. in
 * tests) - migrations are idempotent via schema_migrations.
 */
function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);

  return db;
}

module.exports = { openDatabase };

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

  // Deliberately still fails fast (rethrows) - this runs during Node-RED startup, before
  // anything else in createCore exists, so there's nowhere useful to degrade to. The only
  // fix here is a much clearer diagnostic than the raw better-sqlite3 driver stack trace
  // (e.g. "SQLITE_CORRUPT" or "SQLITE_BUSY" with no path context) - found via a real
  // robustness review, not a report. launchd's KeepAlive (see deploy/launchd/) is the actual
  // recovery mechanism for a startup failure; a clear log line is what lets a human tell "a
  // transient race, it'll come back" apart from "the db file is actually corrupted."
  try {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    runMigrations(db);

    return db;
  } catch (err) {
    console.error(`[database] FATAL: failed to open/migrate database at ${dbPath}: ${err.message}`);
    throw err;
  }
}

module.exports = { openDatabase };

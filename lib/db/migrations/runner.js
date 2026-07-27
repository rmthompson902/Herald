'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = __dirname;
const MIGRATION_FILE_PATTERN = /^(\d+)_.*\.sql$/;

function listMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .map((filename) => {
      const match = filename.match(MIGRATION_FILE_PATTERN);
      return match ? { version: Number(match[1]), filename } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.version - b.version);
}

/**
 * Applies any un-applied migrations, in version order, inside a transaction each.
 * Bootstraps schema_migrations itself (not a versioned migration) so there's no
 * chicken-and-egg problem checking "has migration 1 run" before the tracking table exists.
 */
function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      applied_at  TEXT NOT NULL
    )
  `);

  const appliedVersions = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => row.version)
  );

  const pending = listMigrationFiles().filter((m) => !appliedVersions.has(m.version));

  for (const migration of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, migration.filename), 'utf8');
    const applyMigration = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        new Date().toISOString()
      );
    });
    applyMigration();
  }

  return pending.map((m) => m.version);
}

module.exports = { runMigrations, listMigrationFiles };

#!/usr/bin/env node
// One-off seed script for Phase 3's first end-to-end verification: inserts a single
// hardcoded schedule (cue 101, every 30s, unrestricted hours/days) so the real
// cronSync/cron-plus/qlabProtocol pipeline has something to fire, before the dashboard's
// create/edit UI exists to do this normally.

const path = require('path');
const { openDatabase } = require('../lib/db/database');
const schedulesRepo = require('../lib/db/repositories/schedulesRepo');

const db = openDatabase(path.join(__dirname, '..', 'data', 'schedule.db'));

const existing = schedulesRepo.listAll(db).find((s) => s.qlabCueNumber === '101');
if (existing) {
  console.log('Test schedule already exists:', existing);
} else {
  const created = schedulesRepo.create(db, {
    name: 'Phase 3 test - cue 101 every 30s',
    qlabCueNumber: '101',
    intervalSeconds: 30
  });
  console.log('Created test schedule:', created);
}

db.close();

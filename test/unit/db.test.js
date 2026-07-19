'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDatabase } = require('../../lib/db/database');
const schedulesRepo = require('../../lib/db/repositories/schedulesRepo');
const vogMessagesRepo = require('../../lib/db/repositories/vogMessagesRepo');
const cueCacheRepo = require('../../lib/db/repositories/cueCacheRepo');

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qlab-sched-test-')), 'schedule.db');
}

describe('database bootstrap', () => {
  it('creates schema and is idempotent across repeated opens', () => {
    const dbPath = tempDbPath();

    const db1 = openDatabase(dbPath);
    db1.close();

    const db2 = openDatabase(dbPath); // re-opening must not fail or re-apply migrations
    const migrationCount = db2.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;
    expect(migrationCount).toBe(1);
    db2.close();
  });
});

describe('schedulesRepo', () => {
  let db;
  beforeEach(() => {
    db = openDatabase(tempDbPath());
  });
  afterEach(() => db.close());

  it('creates and reads back a schedule with defaults applied', () => {
    const created = schedulesRepo.create(db, {
      name: 'Lobby safety reminder',
      qlabCueNumber: 'MSG.LOBBY.SAFETY',
      intervalSeconds: 600
    });

    expect(created.id).toBeGreaterThan(0);
    expect(created.weekdays).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(created.enabled).toBe(true);

    const fetched = schedulesRepo.getById(db, created.id);
    expect(fetched).toEqual(created);
  });

  it('updates fields and bumps updatedAt', async () => {
    const created = schedulesRepo.create(db, {
      name: 'Gallery closing',
      qlabCueNumber: 'MSG.GALLERY.CLOSING',
      intervalSeconds: 1800
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = schedulesRepo.update(db, created.id, { intervalSeconds: 3600 });

    expect(updated.intervalSeconds).toBe(3600);
    expect(updated.updatedAt).not.toBe(created.updatedAt);
  });

  it('setEnabled toggles the enabled flag', () => {
    const created = schedulesRepo.create(db, {
      name: 'x',
      qlabCueNumber: 'MSG.X',
      intervalSeconds: 60
    });

    const disabled = schedulesRepo.setEnabled(db, created.id, false);
    expect(disabled.enabled).toBe(false);
    expect(schedulesRepo.listEnabled(db)).toHaveLength(0);

    const reenabled = schedulesRepo.setEnabled(db, created.id, true);
    expect(reenabled.enabled).toBe(true);
    expect(schedulesRepo.listEnabled(db)).toHaveLength(1);
  });

  it('remove deletes the row', () => {
    const created = schedulesRepo.create(db, {
      name: 'x',
      qlabCueNumber: 'MSG.X',
      intervalSeconds: 60
    });
    schedulesRepo.remove(db, created.id);
    expect(schedulesRepo.getById(db, created.id)).toBeNull();
  });
});

describe('vogMessagesRepo', () => {
  let db;
  beforeEach(() => {
    db = openDatabase(tempDbPath());
  });
  afterEach(() => db.close());

  it('creates a VOG message with no timing fields', () => {
    const created = vogMessagesRepo.create(db, {
      name: 'Fire evacuation',
      qlabCueNumber: 'MSG.ALL.EMERGENCY'
    });
    expect(created.enabled).toBe(true);
    expect(vogMessagesRepo.listEnabled(db)).toHaveLength(1);
  });
});

describe('cueCacheRepo', () => {
  let db;
  beforeEach(() => {
    db = openDatabase(tempDbPath());
  });
  afterEach(() => db.close());

  it('upserts by cue number, overwriting on conflict', () => {
    cueCacheRepo.upsert(db, {
      qlabCueNumber: '101',
      qlabInternalId: 'abc-123',
      cueDisplayName: 'Show will begin soon',
      durationSeconds: 9.62,
      zones: ['Zone 1']
    });

    const second = cueCacheRepo.upsert(db, {
      qlabCueNumber: '101',
      qlabInternalId: 'abc-123',
      cueDisplayName: 'Show will begin soon',
      durationSeconds: 9.62,
      zones: ['Zone 1', 'Zone 2']
    });

    expect(second.zones).toEqual(['Zone 1', 'Zone 2']);
    expect(cueCacheRepo.listAll(db)).toHaveLength(1);
    expect(cueCacheRepo.getByInternalId(db, 'abc-123').qlabCueNumber).toBe('101');
  });
});

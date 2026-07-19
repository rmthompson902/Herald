'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { openDatabase } = require('../../lib/db/database');
const schedulesRepo = require('../../lib/db/repositories/schedulesRepo');
const cronSync = require('../../lib/scheduling/cronSync');

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qlab-sched-test-')), 'schedule.db');
}

describe('cronSync', () => {
  let db;
  beforeEach(() => {
    db = openDatabase(tempDbPath());
  });
  afterEach(() => db.close());

  it('toAddCommand builds a dates-mode cron-plus command from real occurrences', () => {
    const schedule = schedulesRepo.create(db, {
      name: 'Lobby safety',
      qlabCueNumber: 'MSG.LOBBY.SAFETY',
      intervalSeconds: 3600,
      startTime: '09:00',
      endTime: '10:00'
    });

    const from = new Date(2026, 6, 20, 8, 0, 0); // Monday 08:00, before the window opens
    const command = cronSync.toAddCommand(schedule, { from, windowHours: 24 });

    expect(command.command).toBe('add');
    expect(command.name).toBe(`sched-${schedule.id}`);
    expect(command.topic).toBe(`sched-${schedule.id}`);
    expect(command.expressionType).toBe('dates');
    expect(command.expression.split(',')).toHaveLength(2); // 09:00 and 10:00 within the window
  });

  it('toAddCommand returns null when there are no occurrences in the window', () => {
    const schedule = schedulesRepo.create(db, {
      name: 'Expired',
      qlabCueNumber: 'MSG.X',
      intervalSeconds: 3600,
      dateRangeStart: '2020-01-01',
      dateRangeEnd: '2020-01-02'
    });

    const command = cronSync.toAddCommand(schedule, { from: new Date(2026, 0, 1), windowHours: 48 });
    expect(command).toBeNull();
  });

  it('syncOne always removes first, and adds again only if enabled with occurrences', () => {
    const enabled = schedulesRepo.create(db, {
      name: 'A',
      qlabCueNumber: 'MSG.A',
      intervalSeconds: 3600,
      startTime: '09:00',
      endTime: '17:00'
    });

    const directives = cronSync.syncOne(db, enabled.id, { from: new Date(2026, 6, 20, 8, 0, 0) });

    expect(directives[0]).toEqual({ toRemove: { command: 'remove', name: `sched-${enabled.id}` } });
    expect(directives[1].toAdd.name).toBe(`sched-${enabled.id}`);
  });

  it('syncOne only removes (no add) when the schedule is disabled', () => {
    const disabled = schedulesRepo.create(db, {
      name: 'B',
      qlabCueNumber: 'MSG.B',
      intervalSeconds: 3600,
      enabled: false
    });

    const directives = cronSync.syncOne(db, disabled.id);

    expect(directives).toEqual([{ toRemove: { command: 'remove', name: `sched-${disabled.id}` } }]);
  });

  it('syncOne only removes when the schedule no longer exists (deleted)', () => {
    const directives = cronSync.syncOne(db, 99999);
    expect(directives).toEqual([{ toRemove: { command: 'remove', name: 'sched-99999' } }]);
  });

  it('rebuildAll removes all dynamic jobs then re-adds every enabled schedule with occurrences', () => {
    const a = schedulesRepo.create(db, {
      name: 'A',
      qlabCueNumber: 'MSG.A',
      intervalSeconds: 3600,
      startTime: '09:00',
      endTime: '17:00'
    });
    schedulesRepo.create(db, { name: 'B (disabled)', qlabCueNumber: 'MSG.B', intervalSeconds: 60, enabled: false });

    const directives = cronSync.rebuildAll(db, { from: new Date(2026, 6, 20, 8, 0, 0) });

    expect(directives[0]).toEqual({ toRemoveAllDynamic: true });
    const addNames = directives.filter((d) => d.toAdd).map((d) => d.toAdd.name);
    expect(addNames).toEqual([`sched-${a.id}`]); // disabled schedule excluded entirely
  });
});

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCore } = require('../../lib/index');

function tempDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qlab-sched-test-')), 'schedule.db');
}

describe('createCore', () => {
  it('wires every module together without opening the OSC socket or starting health monitoring', () => {
    const core = createCore({
      dbPath: tempDbPath(),
      zoneMapPath: path.join(__dirname, '..', '..', 'config', 'zone-map.json'),
      qlabOscHost: '127.0.0.1',
      qlabOscPort: 53000,
      localOscPort: 53001
    });

    expect(core.db.schedules.listAll(core.db.connection)).toEqual([]);
    expect(core.zones.map.get(1)).toBe('Zone 1');
    expect(typeof core.osc.protocol.getDuration).toBe('function');
    expect(core.health.getState()).toBe('unknown'); // not started
    expect(typeof core.scheduling.cronSync.rebuildAll).toBe('function');

    core.db.connection.close();
  });
});

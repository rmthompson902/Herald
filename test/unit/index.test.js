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
      audioPatchMapPath: path.join(__dirname, '..', '..', 'config', 'audio-patch-map.json'),
      qlabOscHost: '127.0.0.1',
      qlabOscPort: 53000,
      localOscPort: 53001
    });

    expect(core.db.schedules.listAll(core.db.connection)).toEqual([]);
    expect(core.zones.patchToZone.get('1')).toBe('Zone 1');
    expect(core.zones.config.get('Zone 1')).toEqual({ duckCueNumber: '1198', unduckCueNumber: '1199' });
    expect(typeof core.osc.protocol.getDuration).toBe('function');
    expect(core.health.getState()).toBe('unknown'); // not started
    expect(typeof core.scheduling.cronSync.rebuildAll).toBe('function');
    expect(typeof core.scheduling.zoneUpcomingOccurrences.getUpcomingOccurrencesForZone).toBe('function');
    expect(typeof core.queue.getState).toBe('function');

    core.db.connection.close();
  });
});

function writeTempPatchMap(obj) {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qlab-sched-test-patchmap-')), 'audio-patch-map.json');
  fs.writeFileSync(filePath, JSON.stringify(obj));
  return filePath;
}

describe('core.zones.reload', () => {
  it('updates the existing patchToZone/zoneConfig Map objects in place, without replacing their references', () => {
    const patchMapPath = writeTempPatchMap({
      zones: { 'Zone 1': { messagingPatchId: '1', duckCueNumber: '1198', unduckCueNumber: '1199' } }
    });

    const core = createCore({
      dbPath: tempDbPath(),
      audioPatchMapPath: patchMapPath,
      qlabOscHost: '127.0.0.1',
      qlabOscPort: 53000,
      localOscPort: 53002
    });

    const patchToZoneRef = core.zones.patchToZone;
    const zoneConfigRef = core.zones.config;

    expect(patchToZoneRef.get('1')).toBe('Zone 1');
    expect(patchToZoneRef.has('3')).toBe(false);

    // Simulate a save through the Zones admin UI having rewritten the file directly
    fs.writeFileSync(patchMapPath, JSON.stringify({
      zones: {
        'Zone 1': { messagingPatchId: '1', duckCueNumber: '1198', unduckCueNumber: '1199' },
        'Zone 2': { messagingPatchId: '3', duckCueNumber: '2198', unduckCueNumber: '2199' }
      }
    }));

    core.zones.reload();

    // Same Map objects - every closure that already captured one of these two references
    // (onZoneTransition, duckImmediately, resolveZoneDetailsForCue) sees this update for free
    expect(core.zones.patchToZone).toBe(patchToZoneRef);
    expect(core.zones.config).toBe(zoneConfigRef);
    expect(patchToZoneRef.get('3')).toBe('Zone 2');
    expect(zoneConfigRef.get('Zone 2')).toEqual({ duckCueNumber: '2198', unduckCueNumber: '2199' });

    core.db.connection.close();
  });

  it('leaves the current in-memory config untouched if the reload reads an invalid file', () => {
    const patchMapPath = writeTempPatchMap({
      zones: { 'Zone 1': { messagingPatchId: '1', duckCueNumber: '1198', unduckCueNumber: '1199' } }
    });

    const core = createCore({
      dbPath: tempDbPath(),
      audioPatchMapPath: patchMapPath,
      qlabOscHost: '127.0.0.1',
      qlabOscPort: 53000,
      localOscPort: 53003
    });

    fs.writeFileSync(patchMapPath, JSON.stringify({ zones: {} })); // invalid: no zones

    expect(() => core.zones.reload()).toThrow(/no zones found/);
    expect(core.zones.patchToZone.get('1')).toBe('Zone 1'); // untouched by the failed reload

    core.db.connection.close();
  });
});

describe('core.zones.save', () => {
  it('validates, writes, and reloads in one call', () => {
    const patchMapPath = writeTempPatchMap({
      zones: { 'Zone 1': { messagingPatchId: '1', duckCueNumber: '1198', unduckCueNumber: '1199' } }
    });

    const core = createCore({
      dbPath: tempDbPath(),
      audioPatchMapPath: patchMapPath,
      qlabOscHost: '127.0.0.1',
      qlabOscPort: 53000,
      localOscPort: 53004
    });

    core.zones.save({
      'Zone 1': { messagingPatchId: '1', duckCueNumber: '1198', unduckCueNumber: '1199' },
      'Zone 2': { messagingPatchId: '3', duckCueNumber: '2198', unduckCueNumber: '2199' }
    });

    expect(core.zones.patchToZone.get('3')).toBe('Zone 2');
    expect(JSON.parse(fs.readFileSync(patchMapPath, 'utf8')).zones['Zone 2']).toBeDefined();

    core.db.connection.close();
  });

  it('throws and reloads nothing when the given zones object is invalid', () => {
    const patchMapPath = writeTempPatchMap({
      zones: { 'Zone 1': { messagingPatchId: '1', duckCueNumber: '1198', unduckCueNumber: '1199' } }
    });

    const core = createCore({
      dbPath: tempDbPath(),
      audioPatchMapPath: patchMapPath,
      qlabOscHost: '127.0.0.1',
      qlabOscPort: 53000,
      localOscPort: 53005
    });

    expect(() =>
      core.zones.save({
        'Zone 1': { messagingPatchId: '1', duckCueNumber: '1198', unduckCueNumber: '1199' },
        'Zone 2': { messagingPatchId: '1', duckCueNumber: '2198', unduckCueNumber: '2199' } // duplicate patch id
      })
    ).toThrow(/claimed by more than one zone/);

    expect(core.zones.config.has('Zone 2')).toBe(false);
    expect(JSON.parse(fs.readFileSync(patchMapPath, 'utf8')).zones['Zone 2']).toBeUndefined();

    core.db.connection.close();
  });
});

describe('OSC message logging', () => {
  function fakeAppLogger() {
    const oscLog = { debug: jest.fn(), warn: jest.fn() };
    const getLogger = jest.fn(() => oscLog);
    return { getLogger, oscLog };
  }

  it('logs every inbound OSC message at debug when appLogger is configured', () => {
    const { getLogger, oscLog } = fakeAppLogger();
    const core = createCore({
      dbPath: tempDbPath(),
      audioPatchMapPath: path.join(__dirname, '..', '..', 'config', 'audio-patch-map.json'),
      qlabOscHost: '127.0.0.1',
      qlabOscPort: 53000,
      localOscPort: 53001,
      appLogger: getLogger
    });

    expect(getLogger).toHaveBeenCalledWith('oscClient');

    // /update pushes carry no payload (see test/fixtures/qlab-osc-findings.md) - must not throw.
    core.osc.client.emit('message', { address: '/update/workspace/ABC/cue_id/XYZ', args: [] });

    expect(oscLog.debug).toHaveBeenCalledWith('/update/workspace/ABC/cue_id/XYZ []');
    expect(oscLog.warn).not.toHaveBeenCalled();

    core.db.connection.close();
  });

  it('logs a denial-shaped reply at warn instead of debug', () => {
    const { getLogger, oscLog } = fakeAppLogger();
    const core = createCore({
      dbPath: tempDbPath(),
      audioPatchMapPath: path.join(__dirname, '..', '..', 'config', 'audio-patch-map.json'),
      qlabOscHost: '127.0.0.1',
      qlabOscPort: 53000,
      localOscPort: 53001,
      appLogger: getLogger
    });

    core.osc.client.emit('message', {
      address: '/reply/cue/1101/start',
      args: [{ type: 's', value: JSON.stringify({ status: 'error', message: 'denied' }) }]
    });

    expect(oscLog.warn).toHaveBeenCalledWith('/reply/cue/1101/start {"status":"error","message":"denied"}');
    expect(oscLog.debug).not.toHaveBeenCalled();

    core.db.connection.close();
  });

  it('does not attach an OSC logging listener when appLogger is not configured', () => {
    const core = createCore({
      dbPath: tempDbPath(),
      audioPatchMapPath: path.join(__dirname, '..', '..', 'config', 'audio-patch-map.json'),
      qlabOscHost: '127.0.0.1',
      qlabOscPort: 53000,
      localOscPort: 53001
    });

    // Should not throw with no logger wired in.
    expect(() =>
      core.osc.client.emit('message', { address: '/thump', args: [{ type: 's', value: '{"status":"ok"}' }] })
    ).not.toThrow();

    core.db.connection.close();
  });
});

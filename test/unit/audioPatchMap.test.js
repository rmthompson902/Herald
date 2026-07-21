'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadAudioPatchMap } = require('../../lib/zones/audioPatchMap');

function writeTempConfig(obj) {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audio-patch-map-test-')), 'audio-patch-map.json');
  fs.writeFileSync(filePath, JSON.stringify(obj));
  return filePath;
}

describe('loadAudioPatchMap', () => {
  it('loads a valid config into patchToZone and zoneConfig maps', () => {
    const filePath = writeTempConfig({
      zones: {
        'Zone 1': { messagingPatchId: '1', duckCueNumber: '1198', unduckCueNumber: '1199' },
        'Zone 2': { messagingPatchId: '3', duckCueNumber: '2198', unduckCueNumber: '2199' }
      }
    });

    const { patchToZone, zoneConfig } = loadAudioPatchMap(filePath);

    expect(patchToZone.get('1')).toBe('Zone 1');
    expect(patchToZone.get('3')).toBe('Zone 2');
    expect(zoneConfig.get('Zone 1')).toEqual({ duckCueNumber: '1198', unduckCueNumber: '1199' });
    expect(zoneConfig.get('Zone 2')).toEqual({ duckCueNumber: '2198', unduckCueNumber: '2199' });
  });

  it('throws when the file has no zones object at all', () => {
    const filePath = writeTempConfig({});
    expect(() => loadAudioPatchMap(filePath)).toThrow(/no zones found/);
  });

  it('throws when a zone is missing messagingPatchId', () => {
    const filePath = writeTempConfig({
      zones: { 'Zone 1': { duckCueNumber: '1198', unduckCueNumber: '1199' } }
    });
    expect(() => loadAudioPatchMap(filePath)).toThrow(/missing messagingPatchId/);
  });

  it('throws when a zone is missing duckCueNumber', () => {
    const filePath = writeTempConfig({
      zones: { 'Zone 1': { messagingPatchId: '1', unduckCueNumber: '1199' } }
    });
    expect(() => loadAudioPatchMap(filePath)).toThrow(/missing duckCueNumber/);
  });

  it('throws when a zone is missing unduckCueNumber', () => {
    const filePath = writeTempConfig({
      zones: { 'Zone 1': { messagingPatchId: '1', duckCueNumber: '1198' } }
    });
    expect(() => loadAudioPatchMap(filePath)).toThrow(/missing unduckCueNumber/);
  });

  it('throws when two zones claim the same messagingPatchId', () => {
    const filePath = writeTempConfig({
      zones: {
        'Zone 1': { messagingPatchId: '1', duckCueNumber: '1198', unduckCueNumber: '1199' },
        'Zone 2': { messagingPatchId: '1', duckCueNumber: '2198', unduckCueNumber: '2199' }
      }
    });
    expect(() => loadAudioPatchMap(filePath)).toThrow(/claimed by more than one zone/);
  });

  it('loads the real committed config/audio-patch-map.json without throwing', () => {
    const realPath = path.join(__dirname, '..', '..', 'config', 'audio-patch-map.json');
    expect(() => loadAudioPatchMap(realPath)).not.toThrow();
  });
});

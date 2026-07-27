'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadAudioPatchMap,
  saveAudioPatchMap,
  validateAndBuildMaps
} = require('../../lib/zones/audioPatchMap');

function writeTempConfig(obj) {
  const filePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'audio-patch-map-test-')),
    'audio-patch-map.json'
  );
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

describe('validateAndBuildMaps', () => {
  it('builds identical maps to loadAudioPatchMap for the same zones object', () => {
    const zones = {
      'Zone 1': { messagingPatchId: '1', duckCueNumber: '1198', unduckCueNumber: '1199' }
    };
    const { patchToZone, zoneConfig } = validateAndBuildMaps(zones);
    expect(patchToZone.get('1')).toBe('Zone 1');
    expect(zoneConfig.get('Zone 1')).toEqual({ duckCueNumber: '1198', unduckCueNumber: '1199' });
  });

  it('throws the same errors loadAudioPatchMap does, given the same shared validation', () => {
    expect(() => validateAndBuildMaps({})).toThrow(/no zones found/);
    expect(() =>
      validateAndBuildMaps({
        'Zone 1': { messagingPatchId: '1', duckCueNumber: '1198', unduckCueNumber: '1199' },
        'Zone 2': { messagingPatchId: '1', duckCueNumber: '2198', unduckCueNumber: '2199' }
      })
    ).toThrow(/claimed by more than one zone/);
  });
});

describe('saveAudioPatchMap', () => {
  function writeTempConfigFile(obj) {
    const filePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'audio-patch-map-save-test-')),
      'audio-patch-map.json'
    );
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
    return filePath;
  }

  it('writes a valid zones object and it round-trips through loadAudioPatchMap', () => {
    const filePath = writeTempConfigFile({
      _comment: 'original comment',
      zones: { 'Zone 1': { messagingPatchId: '1', duckCueNumber: '1198', unduckCueNumber: '1199' } }
    });

    const newZones = {
      'Zone 1': { messagingPatchId: '1', duckCueNumber: '1198', unduckCueNumber: '1199' },
      'Zone 2': { messagingPatchId: '3', duckCueNumber: '2198', unduckCueNumber: '2199' }
    };
    saveAudioPatchMap(filePath, newZones);

    const { patchToZone } = loadAudioPatchMap(filePath);
    expect(patchToZone.get('1')).toBe('Zone 1');
    expect(patchToZone.get('3')).toBe('Zone 2');
  });

  it("preserves the file's existing _comment field", () => {
    const filePath = writeTempConfigFile({
      _comment: 'original comment',
      zones: { 'Zone 1': { messagingPatchId: '1', duckCueNumber: '1198', unduckCueNumber: '1199' } }
    });

    saveAudioPatchMap(filePath, {
      'Zone 1': { messagingPatchId: '1', duckCueNumber: '1198', unduckCueNumber: '1199' }
    });

    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(written._comment).toBe('original comment');
  });

  it('writes with 2-space indent', () => {
    const filePath = writeTempConfigFile({
      _comment: 'c',
      zones: { 'Zone 1': { messagingPatchId: '1', duckCueNumber: '1198', unduckCueNumber: '1199' } }
    });

    saveAudioPatchMap(filePath, {
      'Zone 1': { messagingPatchId: '1', duckCueNumber: '1198', unduckCueNumber: '1199' }
    });

    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw).toMatch(/^\{\n {2}"_comment"/);
  });

  it('throws and writes NOTHING when the new zones object has a duplicate patch id', () => {
    const filePath = writeTempConfigFile({
      _comment: 'c',
      zones: { 'Zone 1': { messagingPatchId: '1', duckCueNumber: '1198', unduckCueNumber: '1199' } }
    });
    const before = fs.readFileSync(filePath, 'utf8');

    const badZones = {
      'Zone 1': { messagingPatchId: '1', duckCueNumber: '1198', unduckCueNumber: '1199' },
      'Zone 2': { messagingPatchId: '1', duckCueNumber: '2198', unduckCueNumber: '2199' }
    };
    expect(() => saveAudioPatchMap(filePath, badZones)).toThrow(/claimed by more than one zone/);

    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
  });

  it('throws and writes NOTHING when the new zones object is missing a required field', () => {
    const filePath = writeTempConfigFile({
      _comment: 'c',
      zones: { 'Zone 1': { messagingPatchId: '1', duckCueNumber: '1198', unduckCueNumber: '1199' } }
    });
    const before = fs.readFileSync(filePath, 'utf8');

    const badZones = { 'Zone 1': { messagingPatchId: '1', unduckCueNumber: '1199' } };
    expect(() => saveAudioPatchMap(filePath, badZones)).toThrow(/missing duckCueNumber/);

    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
  });
});

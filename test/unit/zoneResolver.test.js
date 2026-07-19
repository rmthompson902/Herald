'use strict';

const path = require('path');
const { parseLevelsMatrix, resolveZonesForCue } = require('../../lib/zones/zoneResolver');
const { loadZoneMap } = require('../../lib/zones/zoneMap');

const defaultFixture = require('../fixtures/qlab-levels-cue101-default.json');
const adjustedFixture = require('../fixtures/qlab-levels-cue101-adjusted.json');

function expectedChannelsFrom(fixture) {
  return new Set(
    Object.entries(fixture.expectedZonesByOutputChannel)
      .filter(([, active]) => active)
      .map(([channel]) => Number(channel))
  );
}

describe('parseLevelsMatrix', () => {
  it('treats a straight 0dB pass-through cue as audible on every routed output channel', () => {
    const result = parseLevelsMatrix(defaultFixture.matrix);
    expect(result).toEqual(expectedChannelsFrom(defaultFixture));
  });

  it('excludes an output channel whose input fader is muted, even if its crosspoint is audible', () => {
    const result = parseLevelsMatrix(adjustedFixture.matrix);
    expect(result).toEqual(expectedChannelsFrom(adjustedFixture));
  });

  it('does not gate on the master bus cell (matrix[0][0])', () => {
    const matrix = [
      [-60, 0, 0], // master bus itself silenced; should NOT suppress channels per confirmed assumption
      [0, 0, -60],
      [0, -60, 0]
    ];
    expect(parseLevelsMatrix(matrix)).toEqual(new Set([1, 2]));
  });

  it('returns an empty set when every input fader is muted', () => {
    const matrix = [
      [0, -60, -60],
      [0, 0, -60],
      [0, -60, 0]
    ];
    expect(parseLevelsMatrix(matrix)).toEqual(new Set());
  });
});

describe('resolveZonesForCue', () => {
  it('maps active output channels through the zone map into zone names', async () => {
    const zoneMap = loadZoneMap(path.join(__dirname, '..', '..', 'config', 'zone-map.json'));
    const qlabProtocol = { getLevels: jest.fn().mockResolvedValue(adjustedFixture.matrix) };

    const zones = await resolveZonesForCue(qlabProtocol, zoneMap, '101');

    expect(qlabProtocol.getLevels).toHaveBeenCalledWith('101');
    expect(zones).toEqual(['Zone 1']); // Zone 2 excluded: ch2 muted at its input fader
  });
});

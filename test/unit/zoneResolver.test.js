'use strict';

const {
  resolveZoneForLeafCue,
  resolveZoneInfoForCue,
  resolveZoneDetailsForCue,
  findCueNode
} = require('../../lib/zones/zoneResolver');
const cueListsFixture = require('../fixtures/qlab-patch-cuelists.json');

// Matches config/audio-patch-map.json: patch 1 -> Zone 1, patch 3 -> Zone 2. Patch 2 (a Music
// patch) is deliberately left unmapped to exercise the zero-zone case.
const patchMap = new Map([
  ['1', 'Zone 1'],
  ['3', 'Zone 2']
]);

// cueNumber -> patch id, modeled on the real spike capture plus synthetic Group-child cases.
const patchByCue = new Map([
  ['1101', 1],
  ['1201', 2], // Zone 1 Music - unmapped patch
  ['2101', 3],
  ['990101', 1],
  ['990102', 3],
  ['99020101', 1],
  ['990301', 1],
  ['990302', 1]
]);

// cueNumber -> its own discrete duration, modeling cue 9901's two children having
// different real durations (5s vs 10s) even though the Group itself (9901) would report
// its OSC duration as the longest child's, per QLab's own Group semantics.
const durationByCue = new Map([
  ['1101', 5],
  ['990101', 5],
  ['990102', 10]
]);

// cueNumber -> its own QLab internal uniqueID, modeling each zone's specific child cue
// needing its own distinct id (not the group's) so zoneQueueEngine can track/confirm each
// zone's fire independently.
const uniqueIdByCue = new Map([
  ['1101', 'uid-1101'],
  ['990101', 'uid-990101'],
  ['990102', 'uid-990102']
]);

function fakeProtocol() {
  return {
    getCueLists: jest.fn().mockResolvedValue(cueListsFixture.data),
    getCuePatch: jest.fn((cueNumber) => Promise.resolve(patchByCue.get(cueNumber) ?? null)),
    getDuration: jest.fn((cueNumber) => Promise.resolve(durationByCue.get(cueNumber))),
    getUniqueId: jest.fn((cueNumber) => Promise.resolve(uniqueIdByCue.get(cueNumber)))
  };
}

describe('resolveZoneForLeafCue', () => {
  it('resolves a mapped patch id to its zone name', async () => {
    const protocol = fakeProtocol();
    await expect(resolveZoneForLeafCue(protocol, patchMap, '1101')).resolves.toBe('Zone 1');
    expect(protocol.getCuePatch).toHaveBeenCalledWith('1101');
  });

  it('returns null for a patch id with no zone mapping (e.g. a Music patch)', async () => {
    const protocol = fakeProtocol();
    await expect(resolveZoneForLeafCue(protocol, patchMap, '1201')).resolves.toBeNull();
  });

  it('returns null when the cue has no patch assignment at all', async () => {
    const protocol = { getCuePatch: jest.fn().mockResolvedValue(null) };
    await expect(resolveZoneForLeafCue(protocol, patchMap, '9999')).resolves.toBeNull();
  });
});

describe('findCueNode', () => {
  it('finds a top-level leaf cue by number', () => {
    const node = findCueNode(cueListsFixture.data, '1101');
    expect(node.uniqueID).toBe('cue-1101');
  });

  it('finds a deeply nested cue by number', () => {
    const node = findCueNode(cueListsFixture.data, '99020101');
    expect(node.uniqueID).toBe('cue-99020101');
  });

  it('returns null for an unknown cue number', () => {
    expect(findCueNode(cueListsFixture.data, 'nope')).toBeNull();
  });
});

describe('resolveZoneInfoForCue', () => {
  it('reports which specific child cue number provides each zone of a Group', async () => {
    const protocol = fakeProtocol();
    const { zones, zoneToCueNumber } = await resolveZoneInfoForCue(protocol, patchMap, '9901');

    expect(zones.sort()).toEqual(['Zone 1', 'Zone 2']);
    expect(zoneToCueNumber.get('Zone 1')).toBe('990101');
    expect(zoneToCueNumber.get('Zone 2')).toBe('990102');
  });

  it("maps a leaf cue's own single zone to its own cue number", async () => {
    const protocol = fakeProtocol();
    const { zoneToCueNumber } = await resolveZoneInfoForCue(protocol, patchMap, '1101');
    expect(zoneToCueNumber.get('Zone 1')).toBe('1101');
  });
});

describe('resolveZoneDetailsForCue', () => {
  it('resolves a leaf Audio cue to its single zone with its own cue number/duration/uniqueId', async () => {
    const protocol = fakeProtocol();
    const { zones, zoneDetails } = await resolveZoneDetailsForCue(protocol, patchMap, '1101');

    expect(zones).toEqual(['Zone 1']);
    expect(zoneDetails).toEqual({
      'Zone 1': { cueNumber: '1101', durationSeconds: 5, qlabInternalId: 'uid-1101' }
    });
  });

  it('resolves a leaf cue on an unmapped patch to zero zones, surfaced in unmappedLeafCues', async () => {
    const protocol = fakeProtocol();
    await expect(resolveZoneDetailsForCue(protocol, patchMap, '1201')).resolves.toEqual({
      zones: [],
      zoneDetails: {},
      unmappedLeafCues: [{ cueNumber: '1201', patchId: 2 }]
    });
  });

  it('does NOT surface a cue with no patch assignment at all in unmappedLeafCues (distinct from an unmapped patch)', async () => {
    const protocol = fakeProtocol();
    protocol.getCuePatch = jest.fn().mockResolvedValue(null);
    const { unmappedLeafCues } = await resolveZoneDetailsForCue(protocol, patchMap, '1101');
    expect(unmappedLeafCues).toEqual([]);
  });

  it('aggregates unmappedLeafCues across a Group whose children are a mix of mapped and unmapped patches', async () => {
    const protocol = fakeProtocol();
    // 990101 -> patch 1 (Zone 1, mapped), 990102 -> patch 3 (Zone 2, mapped) per the shared
    // fixture - reuse that structure but swap in an unmapped patch for one child to model
    // a real mixed Group without needing a new cue-tree fixture.
    protocol.getCuePatch = jest.fn((cueNumber) => {
      if (cueNumber === '990102') return Promise.resolve(2); // unmapped Music patch
      return Promise.resolve(patchByCue.get(cueNumber) ?? null);
    });

    const { zones, unmappedLeafCues } = await resolveZoneDetailsForCue(protocol, patchMap, '9901');
    expect(zones).toEqual(['Zone 1']);
    expect(unmappedLeafCues).toEqual([{ cueNumber: '990102', patchId: 2 }]);
  });

  it("resolves a Group cue with each zone mapped to ITS OWN child cue/duration/uniqueId, never the group's own number", async () => {
    const protocol = fakeProtocol();
    const { zones, zoneDetails } = await resolveZoneDetailsForCue(protocol, patchMap, '9901');

    expect(zones.sort()).toEqual(['Zone 1', 'Zone 2']);
    expect(zoneDetails['Zone 1']).toEqual({
      cueNumber: '990101',
      durationSeconds: 5,
      qlabInternalId: 'uid-990101'
    });
    expect(zoneDetails['Zone 2']).toEqual({
      cueNumber: '990102',
      durationSeconds: 10,
      qlabInternalId: 'uid-990102'
    });
    expect(protocol.getDuration).not.toHaveBeenCalledWith('9901');
    expect(protocol.getUniqueId).not.toHaveBeenCalledWith('9901');
  });

  it('recurses into nested Groups (Group containing a Group containing a leaf cue)', async () => {
    const protocol = fakeProtocol();
    const { zones } = await resolveZoneDetailsForCue(protocol, patchMap, '9902');
    expect(zones).toEqual(['Zone 1']);
  });

  it('deduplicates a Group whose children all resolve to the same zone', async () => {
    const protocol = fakeProtocol();
    const { zones } = await resolveZoneDetailsForCue(protocol, patchMap, '9903');
    expect(zones).toEqual(['Zone 1']);
  });

  it('resolves to no zones when the cue number is not found in the cue tree at all', async () => {
    const protocol = fakeProtocol();
    await expect(resolveZoneDetailsForCue(protocol, patchMap, 'does-not-exist')).resolves.toEqual({
      zones: [],
      zoneDetails: {},
      unmappedLeafCues: []
    });
  });

  it("keeps a zone (with its correctly-resolved cue number) even when that zone's own duration query fails, omitting only durationSeconds", async () => {
    const protocol = fakeProtocol();
    protocol.getDuration.mockImplementation((cueNumber) =>
      cueNumber === '990101'
        ? Promise.reject(new Error('timeout'))
        : Promise.resolve(durationByCue.get(cueNumber))
    );

    const { zones, zoneDetails } = await resolveZoneDetailsForCue(protocol, patchMap, '9901');
    expect(zones.sort()).toEqual(['Zone 1', 'Zone 2']);
    expect(zoneDetails['Zone 1']).toEqual({
      cueNumber: '990101',
      durationSeconds: undefined,
      qlabInternalId: 'uid-990101'
    });
    expect(zoneDetails['Zone 2']).toEqual({
      cueNumber: '990102',
      durationSeconds: 10,
      qlabInternalId: 'uid-990102'
    });
  });

  it("keeps a zone even when that zone's own uniqueId query fails, omitting only qlabInternalId", async () => {
    const protocol = fakeProtocol();
    protocol.getUniqueId.mockImplementation((cueNumber) =>
      cueNumber === '990101'
        ? Promise.reject(new Error('timeout'))
        : Promise.resolve(uniqueIdByCue.get(cueNumber))
    );

    const { zoneDetails } = await resolveZoneDetailsForCue(protocol, patchMap, '9901');
    expect(zoneDetails['Zone 1'].qlabInternalId).toBeUndefined();
    expect(zoneDetails['Zone 1'].durationSeconds).toBe(5);
  });

  it('propagates (never swallows) a failure of the underlying getCueLists/tree resolution itself, since zone membership is safety-critical', async () => {
    const protocol = fakeProtocol();
    protocol.getCueLists.mockRejectedValue(
      new Error('OSC request timed out waiting for /reply/cueLists')
    );

    await expect(resolveZoneDetailsForCue(protocol, patchMap, '9901')).rejects.toThrow('timed out');
  });
});

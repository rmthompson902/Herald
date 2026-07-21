'use strict';

const {
  resolveZoneForLeafCue,
  resolveZonesForCue,
  resolveZoneInfoForCue,
  resolveDurationSecondsByZone,
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

function fakeProtocol() {
  return {
    getCueLists: jest.fn().mockResolvedValue(cueListsFixture.data),
    getCuePatch: jest.fn((cueNumber) => Promise.resolve(patchByCue.get(cueNumber) ?? null)),
    getDuration: jest.fn((cueNumber) => Promise.resolve(durationByCue.get(cueNumber)))
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

describe('resolveZonesForCue', () => {
  it('resolves a leaf Audio cue to its single zone via the patch map', async () => {
    const protocol = fakeProtocol();
    await expect(resolveZonesForCue(protocol, patchMap, '1101')).resolves.toEqual(['Zone 1']);
  });

  it('resolves a leaf cue on an unmapped patch to zero zones', async () => {
    const protocol = fakeProtocol();
    await expect(resolveZonesForCue(protocol, patchMap, '1201')).resolves.toEqual([]);
  });

  it('resolves a Group cue as the union of its children in different zones', async () => {
    const protocol = fakeProtocol();
    const zones = await resolveZonesForCue(protocol, patchMap, '9901');
    expect(zones.sort()).toEqual(['Zone 1', 'Zone 2']);
  });

  it('recurses into nested Groups (Group containing a Group containing a leaf cue)', async () => {
    const protocol = fakeProtocol();
    await expect(resolveZonesForCue(protocol, patchMap, '9902')).resolves.toEqual(['Zone 1']);
  });

  it('deduplicates a Group whose children all resolve to the same zone', async () => {
    const protocol = fakeProtocol();
    await expect(resolveZonesForCue(protocol, patchMap, '9903')).resolves.toEqual(['Zone 1']);
  });

  it('resolves to an empty array when the cue number is not found in the cue tree at all', async () => {
    const protocol = fakeProtocol();
    await expect(resolveZonesForCue(protocol, patchMap, 'does-not-exist')).resolves.toEqual([]);
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

  it('maps a leaf cue\'s own single zone to its own cue number', async () => {
    const protocol = fakeProtocol();
    const { zoneToCueNumber } = await resolveZoneInfoForCue(protocol, patchMap, '1101');
    expect(zoneToCueNumber.get('Zone 1')).toBe('1101');
  });
});

describe('resolveDurationSecondsByZone', () => {
  it('resolves each zone of a Group cue to its OWN child\'s discrete duration, not the group\'s overall one', async () => {
    const protocol = fakeProtocol();
    const result = await resolveDurationSecondsByZone(protocol, patchMap, '9901');

    expect(result).toEqual({ 'Zone 1': 5, 'Zone 2': 10 });
    expect(protocol.getDuration).toHaveBeenCalledWith('990101');
    expect(protocol.getDuration).toHaveBeenCalledWith('990102');
    expect(protocol.getDuration).not.toHaveBeenCalledWith('9901'); // never the group's own number
  });

  it('resolves a leaf cue to { [its own zone]: its own duration }', async () => {
    const protocol = fakeProtocol();
    await expect(resolveDurationSecondsByZone(protocol, patchMap, '1101')).resolves.toEqual({ 'Zone 1': 5 });
  });

  it('omits a zone whose duration query fails, without throwing', async () => {
    const protocol = fakeProtocol();
    protocol.getDuration.mockImplementation((cueNumber) =>
      cueNumber === '990101' ? Promise.reject(new Error('timeout')) : Promise.resolve(durationByCue.get(cueNumber))
    );

    await expect(resolveDurationSecondsByZone(protocol, patchMap, '9901')).resolves.toEqual({ 'Zone 2': 10 });
  });

  it('returns an empty object for a cue not found in the cue tree', async () => {
    const protocol = fakeProtocol();
    await expect(resolveDurationSecondsByZone(protocol, patchMap, 'does-not-exist')).resolves.toEqual({});
  });
});

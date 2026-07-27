'use strict';

const { createZoneHandlers } = require('../../../node-red/lib/handlers/zones');

function makeNode() {
  return { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
}

function makeDeps(configEntries = []) {
  const core = {
    osc: { protocol: { getCuePatch: jest.fn(async () => 1) } },
    zones: { config: new Map(configEntries), save: jest.fn() }
  };
  const deps = {
    core,
    zonesAdmin: { buildZonesObject: jest.fn(() => ({})) },
    deriveZoneSuggestion: jest.fn(() => ({
      zoneName: 'Zone 3',
      duckCueNumber: '3198',
      unduckCueNumber: '3199'
    }))
  };
  return { deps, core, node: makeNode() };
}

describe('zoneDiscover', () => {
  it('400s without a cueNumber', () => {
    const { deps, node } = makeDeps();
    const { zoneDiscover } = createZoneHandlers(deps);
    expect(zoneDiscover({ req: { query: {} } }, node).statusCode).toBe(400);
  });

  it('returns the live patchId plus the convention-based suggestion', async () => {
    const { deps, node } = makeDeps();
    const { zoneDiscover } = createZoneHandlers(deps);
    const out = await zoneDiscover({ req: { query: { cueNumber: '3101' } } }, node);
    expect(out.payload).toEqual({
      status: 'success',
      patchId: '1',
      zoneName: 'Zone 3',
      duckCueNumber: '3198',
      unduckCueNumber: '3199'
    });
  });

  it('still succeeds with patchId null when the live patch lookup throws', async () => {
    const { deps, core, node } = makeDeps();
    core.osc.protocol.getCuePatch.mockRejectedValue(new Error('unreachable'));
    const { zoneDiscover } = createZoneHandlers(deps);
    const out = await zoneDiscover({ req: { query: { cueNumber: '3101' } } }, node);
    expect(out.statusCode).toBe(200);
    expect(out.payload.patchId).toBeNull();
  });
});

describe('createZone', () => {
  it('400s a blank zoneName', () => {
    const { deps, node } = makeDeps();
    const { createZone } = createZoneHandlers(deps);
    expect(createZone({ payload: { zoneName: '  ' } }, node).statusCode).toBe(400);
  });

  it('409s a zone that already exists', () => {
    const { deps, node } = makeDeps([['Zone 1', {}]]);
    const { createZone } = createZoneHandlers(deps);
    expect(createZone({ payload: { zoneName: 'Zone 1' } }, node).statusCode).toBe(409);
  });

  it('400s and does not persist when save validation throws', () => {
    const { deps, core, node } = makeDeps();
    core.zones.save.mockImplementation(() => {
      throw new Error('missing duckCueNumber');
    });
    const { createZone } = createZoneHandlers(deps);
    const out = createZone({ payload: { zoneName: 'Zone 9', messagingPatchId: '9' } }, node);
    expect(out.statusCode).toBe(400);
    expect(out.payload.message).toBe('missing duckCueNumber');
  });

  it('201s on success, saving the rebuilt zones object', () => {
    const { deps, core, node } = makeDeps();
    const { createZone } = createZoneHandlers(deps);
    const out = createZone(
      {
        payload: {
          zoneName: 'Zone 9',
          messagingPatchId: '9',
          duckCueNumber: '9198',
          unduckCueNumber: '9199'
        }
      },
      node
    );
    expect(core.zones.save).toHaveBeenCalledWith(
      expect.objectContaining({
        'Zone 9': { messagingPatchId: '9', duckCueNumber: '9198', unduckCueNumber: '9199' }
      })
    );
    expect(out.statusCode).toBe(201);
  });
});

describe('updateZone / deleteZone', () => {
  it('updateZone 404s an unknown zone', () => {
    const { deps, node } = makeDeps();
    const { updateZone } = createZoneHandlers(deps);
    expect(
      updateZone({ req: { params: { zoneName: 'Nope' } }, payload: {} }, node).statusCode
    ).toBe(404);
  });

  it('deleteZone removes the entry and saves', () => {
    const { deps, core, node } = makeDeps([['Zone 1', {}]]);
    deps.zonesAdmin.buildZonesObject.mockReturnValue({ 'Zone 1': {}, 'Zone 2': {} });
    const { deleteZone } = createZoneHandlers(deps);
    const out = deleteZone({ req: { params: { zoneName: 'Zone 1' } } }, node);
    expect(core.zones.save).toHaveBeenCalledWith({ 'Zone 2': {} });
    expect(out.statusCode).toBe(200);
  });
});

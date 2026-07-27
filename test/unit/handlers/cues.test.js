'use strict';

const { createCueHandlers } = require('../../../node-red/lib/handlers/cues');

function makeNode() {
  return { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
}

function makeDeps(results) {
  const deps = {
    core: {},
    refreshCueCache: jest.fn(),
    refreshAllReferencedCues: jest.fn(async () => results)
  };
  return { deps, node: makeNode() };
}

describe('refreshAllCues', () => {
  it('reports refreshedCount and the list of failed cue numbers', async () => {
    const { deps, node } = makeDeps({
      101: { zones: ['Zone 1'], unmappedLeafCues: [] },
      102: { error: 'timeout' },
      103: { zones: ['Zone 2'], unmappedLeafCues: [] }
    });
    const { refreshAllCues } = createCueHandlers(deps);
    const out = await refreshAllCues({}, node);
    expect(out.statusCode).toBe(200);
    expect(out.payload).toEqual({ status: 'success', refreshedCount: 2, failed: ['102'] });
  });

  it('warns for unmapped leaf cues surfaced during the sweep', async () => {
    const { deps, node } = makeDeps({
      9900: { zones: ['Zone 1'], unmappedLeafCues: [{ cueNumber: '990102', patchId: 2 }] }
    });
    const { refreshAllCues } = createCueHandlers(deps);
    await refreshAllCues({}, node);
    expect(node.warn).toHaveBeenCalledWith(expect.stringContaining('990102'));
  });
});

describe('periodicCueRefresh', () => {
  it('warns on failures and returns null (no HTTP response)', async () => {
    const { deps, node } = makeDeps({
      101: { error: 'x' },
      102: { zones: [], unmappedLeafCues: [] }
    });
    const { periodicCueRefresh } = createCueHandlers(deps);
    const out = await periodicCueRefresh({}, node);
    expect(out).toBeNull();
    expect(node.warn).toHaveBeenCalledWith(expect.stringContaining('1 cue(s) failed'));
  });
});

'use strict';

const { createStartupHandler } = require('../../../node-red/lib/handlers/startup');

function makeNode() {
  return { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
}

function makeDeps(results = {}, configZones = ['Zone 1']) {
  const core = {
    osc: { client: { open: jest.fn(async () => {}) } },
    health: { start: jest.fn(async () => {}) },
    scheduling: { cronSync: { rebuildAll: jest.fn(() => ['dir']) } },
    db: { connection: {} },
    zones: { config: new Map(configZones.map((z) => [z, {}])) }
  };
  const deps = {
    core,
    cronSyncMessages: { toCronPlusMessages: jest.fn(() => ['M1']) },
    refreshCueCache: jest.fn(),
    refreshAllReferencedCues: jest.fn(async () => results)
  };
  return { deps, core, node: makeNode() };
}

describe('startup', () => {
  it('opens OSC, arms health, and returns the rebuilt cron directives', async () => {
    const { deps, core, node } = makeDeps({ 101: { zones: ['Zone 1'], unmappedLeafCues: [] } });
    const { startup } = createStartupHandler(deps);
    const out = await startup({}, node);
    expect(core.osc.client.open).toHaveBeenCalled();
    expect(core.health.start).toHaveBeenCalled();
    expect(out).toEqual([['M1']]);
  });

  it('aborts (returns null, node.error) when the OSC connection cannot be opened', async () => {
    const { deps, core, node } = makeDeps();
    core.osc.client.open.mockRejectedValue(new Error('EADDRINUSE'));
    const { startup } = createStartupHandler(deps);
    const out = await startup({}, node);
    expect(out).toBeNull();
    expect(node.error).toHaveBeenCalledWith(expect.stringContaining('Startup FAILED'));
    expect(core.scheduling.cronSync.rebuildAll).not.toHaveBeenCalled();
  });

  it('node.errors (but does not abort) when a resolved zone has no duck/unduck config', async () => {
    const { deps, node } = makeDeps({ 202: { zones: ['Zone 2'], unmappedLeafCues: [] } }, [
      'Zone 1'
    ]);
    const { startup } = createStartupHandler(deps);
    const out = await startup({}, node);
    expect(out).toEqual([['M1']]); // still returns directives - one bad zone doesn't disarm the rest
    expect(node.error).toHaveBeenCalledWith(expect.stringContaining('Zone 2'));
  });

  it('warns on a cue warm-up failure without aborting', async () => {
    const { deps, node } = makeDeps({ 101: { error: 'timeout' } });
    const { startup } = createStartupHandler(deps);
    const out = await startup({}, node);
    expect(out).toEqual([['M1']]);
    expect(node.warn).toHaveBeenCalledWith(expect.stringContaining('warm-up failed'));
  });
});

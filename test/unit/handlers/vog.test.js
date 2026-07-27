'use strict';

const { createVogHandlers } = require('../../../node-red/lib/handlers/vog');

function makeNode() {
  return { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
}

function makeDeps() {
  const core = {
    db: {
      connection: {},
      vogMessages: {
        getById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        remove: jest.fn(),
        setEnabled: jest.fn(),
        listAll: jest.fn(() => [])
      }
    },
    health: { isArmed: jest.fn(() => true), getState: jest.fn(() => 'connected') },
    vog: { trigger: jest.fn(async () => ({ fired: true, zones: ['Zone 1'] })) }
  };
  const deps = {
    core,
    refreshCueCache: jest.fn(async () => ({ zones: ['Zone 1'], unmappedLeafCues: [] }))
  };
  return { deps, core, node: makeNode() };
}

describe('createVog', () => {
  it('400s when name or cue number is missing', () => {
    const { deps, node } = makeDeps();
    const { createVog } = createVogHandlers(deps);
    const out = createVog({ payload: { name: 'x' } }, node);
    expect(out.statusCode).toBe(400);
  });

  it('creates and returns 201 after a cache refresh', async () => {
    const { deps, core, node } = makeDeps();
    core.db.vogMessages.create.mockReturnValue({ id: 2, qlabCueNumber: '104' });
    const { createVog } = createVogHandlers(deps);
    const out = await createVog({ payload: { name: 'Evac', qlabCueNumber: '104' } }, node);
    expect(out.statusCode).toBe(201);
    expect(deps.refreshCueCache).toHaveBeenCalledWith(core, '104');
  });
});

describe('updateVog', () => {
  it('404s when the message does not exist', () => {
    const { deps, core, node } = makeDeps();
    core.db.vogMessages.update.mockReturnValue(null);
    const { updateVog } = createVogHandlers(deps);
    const out = updateVog(
      { req: { params: { id: '9' } }, payload: { name: 'a', qlabCueNumber: 'b' } },
      node
    );
    expect(out.statusCode).toBe(404);
  });
});

describe('toggleVog', () => {
  it('flips the current enabled state server-side', () => {
    const { deps, core, node } = makeDeps();
    core.db.vogMessages.getById.mockReturnValue({ id: 1, enabled: false });
    core.db.vogMessages.setEnabled.mockReturnValue({ id: 1, enabled: true });
    const { toggleVog } = createVogHandlers(deps);
    toggleVog({ req: { params: { id: '1' } } }, node);
    expect(core.db.vogMessages.setEnabled).toHaveBeenCalledWith(core.db.connection, 1, true);
  });
});

describe('triggerVog', () => {
  it('404s an unknown message', () => {
    const { deps, core, node } = makeDeps();
    core.db.vogMessages.getById.mockReturnValue(null);
    const { triggerVog } = createVogHandlers(deps);
    expect(triggerVog({ req: { params: { id: '9' } } }, node).statusCode).toBe(404);
  });

  it('400s a disabled message (enabled IS the arm gate for VOG)', () => {
    const { deps, core, node } = makeDeps();
    core.db.vogMessages.getById.mockReturnValue({ id: 1, enabled: false });
    const { triggerVog } = createVogHandlers(deps);
    const out = triggerVog({ req: { params: { id: '1' } } }, node);
    expect(out.statusCode).toBe(400);
    expect(core.vog.trigger).not.toHaveBeenCalled();
  });

  it('503s when QLab is not armed', () => {
    const { deps, core, node } = makeDeps();
    core.db.vogMessages.getById.mockReturnValue({ id: 1, enabled: true });
    core.health.isArmed.mockReturnValue(false);
    const { triggerVog } = createVogHandlers(deps);
    expect(triggerVog({ req: { params: { id: '1' } } }, node).statusCode).toBe(503);
  });

  it('triggers and returns fired/zones on success', async () => {
    const { deps, core, node } = makeDeps();
    const vog = { id: 1, enabled: true, qlabCueNumber: '104' };
    core.db.vogMessages.getById.mockReturnValue(vog);
    const { triggerVog } = createVogHandlers(deps);
    const out = await triggerVog({ req: { params: { id: '1' } } }, node);
    expect(core.vog.trigger).toHaveBeenCalledWith(vog);
    expect(out.payload).toEqual({ status: 'success', fired: true, zones: ['Zone 1'] });
  });
});

describe('bulkSetEnabledVog', () => {
  it('sets every message with no cron rebuild (VOG has no scheduler state)', () => {
    const { deps, core, node } = makeDeps();
    core.db.vogMessages.listAll.mockReturnValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const { bulkSetEnabledVog } = createVogHandlers(deps);
    const out = bulkSetEnabledVog({ payload: { enabled: false } }, node);
    expect(core.db.vogMessages.setEnabled).toHaveBeenCalledTimes(3);
    expect(out.payload).toEqual({ status: 'success', updated: 3, enabled: false });
  });
});

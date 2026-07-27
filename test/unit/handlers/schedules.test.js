'use strict';

const { createScheduleHandlers } = require('../../../node-red/lib/handlers/schedules');

function makeNode() {
  return { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
}

// Minimal fake core; individual tests override the bits they exercise.
function makeDeps(overrides = {}) {
  const core = {
    db: {
      connection: {},
      schedules: {
        getById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        remove: jest.fn(),
        setEnabled: jest.fn(),
        listAll: jest.fn(() => [])
      }
    },
    scheduling: {
      validateSchedule: jest.fn((p) => p),
      cronSync: {
        syncOne: jest.fn(() => ['dir']),
        rebuildAll: jest.fn(() => ['dir']),
        toRemoveCommand: jest.fn((id) => ({ command: 'remove', name: `sched-${id}` }))
      }
    },
    health: { isArmed: jest.fn(() => true), getState: jest.fn(() => 'connected') },
    queue: { enqueue: jest.fn(async () => ({ fired: true })) },
    ...(overrides.core || {})
  };
  const deps = {
    core,
    cronSyncMessages: { toCronPlusMessages: jest.fn(() => ['CRONMSG']) },
    refreshCueCache: jest.fn(async () => ({
      qlabInternalId: 'uid',
      zones: ['Zone 1'],
      zoneDetails: {},
      durationSeconds: 5,
      unmappedLeafCues: []
    }))
  };
  return { deps, core, node: makeNode() };
}

describe('onDue', () => {
  it('ignores a non-schedule topic (cron-plus command/status message)', () => {
    const { deps, node } = makeDeps();
    const { onDue } = createScheduleHandlers(deps);
    expect(onDue({ topic: 'command-response' }, node)).toBeNull();
  });

  it('warns and skips when the schedule no longer exists', () => {
    const { deps, core, node } = makeDeps();
    core.db.schedules.getById.mockReturnValue(null);
    const { onDue } = createScheduleHandlers(deps);
    expect(onDue({ topic: 'sched-7' }, node)).toBeNull();
    expect(node.warn).toHaveBeenCalled();
  });

  it('skips (does not fire) when QLab is not armed', () => {
    const { deps, core, node } = makeDeps();
    core.db.schedules.getById.mockReturnValue({ id: 7, qlabCueNumber: '101', name: 'S' });
    core.health.isArmed.mockReturnValue(false);
    const { onDue } = createScheduleHandlers(deps);
    expect(onDue({ topic: 'sched-7' }, node)).toBeNull();
    expect(core.queue.enqueue).not.toHaveBeenCalled();
  });

  it('enqueues with a dedupeKey and reports Fired when it fired immediately', async () => {
    const { deps, core, node } = makeDeps();
    core.db.schedules.getById.mockReturnValue({ id: 7, qlabCueNumber: '101', name: 'Safety' });
    const { onDue } = createScheduleHandlers(deps);
    const out = await onDue({ topic: 'sched-7' }, node);
    expect(core.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: 'schedule-7', scheduleId: 7, cueNumber: '101' })
    );
    expect(out.payload).toMatch(/^Fired 101/);
  });

  it('reports Queued when the fire was deferred', async () => {
    const { deps, core, node } = makeDeps();
    core.db.schedules.getById.mockReturnValue({ id: 7, qlabCueNumber: '101', name: 'Safety' });
    core.queue.enqueue.mockResolvedValue({ fired: false });
    const { onDue } = createScheduleHandlers(deps);
    const out = await onDue({ topic: 'sched-7' }, node);
    expect(out.payload).toMatch(/^Queued 101/);
  });

  it('skips when live cue resolution fails, never calling enqueue', async () => {
    const { deps, core, node } = makeDeps();
    core.db.schedules.getById.mockReturnValue({ id: 7, qlabCueNumber: '101', name: 'S' });
    deps.refreshCueCache.mockResolvedValue({ error: 'timeout' });
    const { onDue } = createScheduleHandlers(deps);
    expect(await onDue({ topic: 'sched-7' }, node)).toBeNull();
    expect(core.queue.enqueue).not.toHaveBeenCalled();
  });
});

describe('createSchedule', () => {
  it('returns a 400 envelope on validation failure and no cron messages', () => {
    const { deps, core, node } = makeDeps();
    core.scheduling.validateSchedule.mockImplementation(() => {
      throw new Error('name is required');
    });
    const { createSchedule } = createScheduleHandlers(deps);
    const msg = { payload: {} };
    const [cron, out] = createSchedule(msg, node);
    expect(cron).toBeNull();
    expect(out.statusCode).toBe(400);
    expect(out.payload).toEqual({ status: 'error', message: 'name is required' });
  });

  it('creates, syncs cron, refreshes cache, and returns 201 with cron messages', async () => {
    const { deps, core, node } = makeDeps();
    core.db.schedules.create.mockReturnValue({ id: 3, qlabCueNumber: '101' });
    const { createSchedule } = createScheduleHandlers(deps);
    const msg = { payload: { name: 'S', qlabCueNumber: '101', intervalSeconds: 30 } };
    const [cron, out] = await createSchedule(msg, node);
    expect(cron).toEqual(['CRONMSG']);
    expect(out.statusCode).toBe(201);
    expect(out.payload.status).toBe('success');
    expect(deps.refreshCueCache).toHaveBeenCalledWith(core, '101');
  });

  it('warns for each unmapped leaf cue surfaced by the refresh', async () => {
    const { deps, core, node } = makeDeps();
    core.db.schedules.create.mockReturnValue({ id: 3, qlabCueNumber: '9900' });
    deps.refreshCueCache.mockResolvedValue({
      zones: ['Zone 1'],
      unmappedLeafCues: [{ cueNumber: '990102', patchId: 2 }]
    });
    const { createSchedule } = createScheduleHandlers(deps);
    await createSchedule(
      { payload: { name: 'S', qlabCueNumber: '9900', intervalSeconds: 30 } },
      node
    );
    expect(node.warn).toHaveBeenCalledWith(expect.stringContaining('990102'));
  });
});

describe('updateSchedule', () => {
  it('returns 404 when the schedule does not exist', () => {
    const { deps, core, node } = makeDeps();
    core.db.schedules.update.mockReturnValue(null);
    const { updateSchedule } = createScheduleHandlers(deps);
    const [, out] = updateSchedule({ req: { params: { id: '9' } }, payload: {} }, node);
    expect(out.statusCode).toBe(404);
  });
});

describe('deleteSchedule', () => {
  it('404s an unknown schedule', () => {
    const { deps, core, node } = makeDeps();
    core.db.schedules.getById.mockReturnValue(null);
    const { deleteSchedule } = createScheduleHandlers(deps);
    const [, out] = deleteSchedule({ req: { params: { id: '9' } } }, node);
    expect(out.statusCode).toBe(404);
  });

  it('removes and emits a cron remove directive', () => {
    const { deps, core, node } = makeDeps();
    core.db.schedules.getById.mockReturnValue({ id: 9 });
    const { deleteSchedule } = createScheduleHandlers(deps);
    const [cron, out] = deleteSchedule({ req: { params: { id: '9' } } }, node);
    expect(core.db.schedules.remove).toHaveBeenCalledWith(core.db.connection, 9);
    expect(cron[0].payload).toEqual({ command: 'remove', name: 'sched-9' });
    expect(out.statusCode).toBe(200);
  });
});

describe('toggleSchedule', () => {
  it('flips the current enabled state server-side (not from the request body)', () => {
    const { deps, core, node } = makeDeps();
    core.db.schedules.getById.mockReturnValue({ id: 4, enabled: true });
    core.db.schedules.setEnabled.mockReturnValue({ id: 4, enabled: false });
    const { toggleSchedule } = createScheduleHandlers(deps);
    toggleSchedule({ req: { params: { id: '4' } } }, node);
    expect(core.db.schedules.setEnabled).toHaveBeenCalledWith(core.db.connection, 4, false);
  });
});

describe('playNow', () => {
  it('503s when QLab is not armed', () => {
    const { deps, core, node } = makeDeps();
    core.db.schedules.getById.mockReturnValue({ id: 1, qlabCueNumber: '101' });
    core.health.isArmed.mockReturnValue(false);
    const { playNow } = createScheduleHandlers(deps);
    const out = playNow({ req: { params: { id: '1' } } }, node);
    expect(out.statusCode).toBe(503);
    expect(out.payload.message).toBe('qlab_disconnected');
  });

  it('502s when the cue cannot be resolved from QLab', async () => {
    const { deps, core, node } = makeDeps();
    core.db.schedules.getById.mockReturnValue({ id: 1, qlabCueNumber: '101' });
    deps.refreshCueCache.mockResolvedValue({ error: 'timeout' });
    const { playNow } = createScheduleHandlers(deps);
    const out = await playNow({ req: { params: { id: '1' } } }, node);
    expect(out.statusCode).toBe(502);
  });

  it('reports queued:true when the fire was deferred', async () => {
    const { deps, core, node } = makeDeps();
    core.db.schedules.getById.mockReturnValue({ id: 1, qlabCueNumber: '101', name: 'S' });
    core.queue.enqueue.mockResolvedValue({ fired: false });
    const { playNow } = createScheduleHandlers(deps);
    const out = await playNow({ req: { params: { id: '1' } } }, node);
    expect(out.statusCode).toBe(200);
    expect(out.payload.queued).toBe(true);
  });
});

describe('bulkSetEnabledSchedules', () => {
  it('sets every schedule and rebuilds all cron jobs', () => {
    const { deps, core, node } = makeDeps();
    core.db.schedules.listAll.mockReturnValue([{ id: 1 }, { id: 2 }]);
    const { bulkSetEnabledSchedules } = createScheduleHandlers(deps);
    const [cron, out] = bulkSetEnabledSchedules({ payload: { enabled: true } }, node);
    expect(core.db.schedules.setEnabled).toHaveBeenCalledTimes(2);
    expect(core.scheduling.cronSync.rebuildAll).toHaveBeenCalled();
    expect(cron).toEqual(['CRONMSG']);
    expect(out.payload).toEqual({ status: 'success', updated: 2, enabled: true });
  });
});

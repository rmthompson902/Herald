'use strict';

const { triggerVog } = require('../../lib/vog/vogInterruptHandler');

function makeDeps({
  zones = ['Zone 1', 'Zone 2'],
  zoneDetails = {},
  occupancy = {},
  cueDisplayName = 'VO - Evacuate'
} = {}) {
  const qlabProtocol = {
    stopCue: jest.fn().mockResolvedValue(undefined),
    getDuration: jest.fn().mockResolvedValue(12),
    getUniqueId: jest.fn().mockResolvedValue('vog-uid')
  };
  const resolveZoneDetailsForCue = jest
    .fn()
    .mockResolvedValue({ zones, zoneDetails, cueDisplayName });
  const queueEngine = {
    getState: jest.fn().mockReturnValue({ occupancy, queued: {} }),
    preemptZones: jest.fn(),
    markDucked: jest.fn(),
    enqueue: jest.fn().mockResolvedValue({ fired: true })
  };
  const duckImmediately = jest.fn().mockResolvedValue(undefined);
  return { qlabProtocol, resolveZoneDetailsForCue, queueEngine, duckImmediately };
}

const vogMessage = { id: 7, name: 'Evacuate All', qlabCueNumber: '900' };

describe('vogInterruptHandler.triggerVog', () => {
  test('stops every distinct confirmed occupant across the VOG zone scope', async () => {
    const deps = makeDeps({
      zones: ['Zone 1', 'Zone 2'],
      occupancy: {
        'Zone 1': { entry: { cueNumber: '101' }, confirmed: true },
        'Zone 2': { entry: { cueNumber: '102' }, confirmed: true }
      }
    });

    await triggerVog(deps, vogMessage);

    expect(deps.qlabProtocol.stopCue).toHaveBeenCalledWith('101');
    expect(deps.qlabProtocol.stopCue).toHaveBeenCalledWith('102');
    expect(deps.qlabProtocol.stopCue).toHaveBeenCalledTimes(2);
  });

  test('dedupes a single multi-zone occupant into one stopCue call', async () => {
    const sharedEntry = { cueNumber: '102' };
    const deps = makeDeps({
      zones: ['Zone 1', 'Zone 2'],
      occupancy: {
        'Zone 1': { entry: sharedEntry, confirmed: true },
        'Zone 2': { entry: sharedEntry, confirmed: true }
      }
    });

    await triggerVog(deps, vogMessage);

    expect(deps.qlabProtocol.stopCue).toHaveBeenCalledTimes(1);
    expect(deps.qlabProtocol.stopCue).toHaveBeenCalledWith('102');
  });

  test('does not stop a zone whose occupant is only reserved/mid-confirm, not confirmed', async () => {
    const deps = makeDeps({
      zones: ['Zone 1'],
      occupancy: {
        'Zone 1': { entry: { cueNumber: '101' }, confirmed: false }
      }
    });

    await triggerVog(deps, vogMessage);

    expect(deps.qlabProtocol.stopCue).not.toHaveBeenCalled();
    expect(deps.queueEngine.preemptZones).toHaveBeenCalledWith(['Zone 1']);
  });

  test('ignores occupancy in zones outside the VOG cue own scope', async () => {
    const deps = makeDeps({
      zones: ['Zone 1'],
      occupancy: {
        'Zone 1': { entry: { cueNumber: '101' }, confirmed: true },
        'Zone 2': { entry: { cueNumber: '102' }, confirmed: true }
      }
    });

    await triggerVog(deps, vogMessage);

    expect(deps.qlabProtocol.stopCue).toHaveBeenCalledTimes(1);
    expect(deps.qlabProtocol.stopCue).toHaveBeenCalledWith('101');
  });

  test('preempts the queue engine for the resolved zones before enqueueing the VOG cue', async () => {
    const deps = makeDeps({ zones: ['Zone 1', 'Zone 2'] });

    await triggerVog(deps, vogMessage);

    expect(deps.queueEngine.preemptZones).toHaveBeenCalledWith(['Zone 1', 'Zone 2']);
    const preemptOrder = deps.queueEngine.preemptZones.mock.invocationCallOrder[0];
    const enqueueOrder = deps.queueEngine.enqueue.mock.invocationCallOrder[0];
    expect(preemptOrder).toBeLessThan(enqueueOrder);
  });

  test('enqueues the VOG cue into every resolved zone with live duration/uniqueId', async () => {
    const deps = makeDeps({ zones: ['Zone 1', 'Zone 2'] });

    const result = await triggerVog(deps, vogMessage);

    expect(deps.queueEngine.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        cueNumber: '900',
        qlabInternalId: 'vog-uid',
        zones: ['Zone 1', 'Zone 2'],
        zoneDetails: {},
        durationSeconds: 12,
        name: 'Evacuate All',
        cueDisplayName: 'VO - Evacuate',
        source: 'vog'
      })
    );
    expect(result).toEqual({ fired: true, zones: ['Zone 1', 'Zone 2'] });
  });

  test("resolves and passes through each zone's own discrete play details (e.g. for a multi-zone Group cue)", async () => {
    const zoneDetails = {
      'Zone 1': { cueNumber: '901', durationSeconds: 5, qlabInternalId: 'uid-901' },
      'Zone 2': { cueNumber: '902', durationSeconds: 10, qlabInternalId: 'uid-902' }
    };
    const deps = makeDeps({ zones: ['Zone 1', 'Zone 2'], zoneDetails });

    await triggerVog(deps, vogMessage);

    expect(deps.resolveZoneDetailsForCue).toHaveBeenCalledWith('900');
    expect(deps.queueEngine.enqueue).toHaveBeenCalledWith(expect.objectContaining({ zoneDetails }));
  });

  test('a stopCue rejection for one occupant does not block stopping/preempting the rest', async () => {
    const deps = makeDeps({
      zones: ['Zone 1', 'Zone 2'],
      occupancy: {
        'Zone 1': { entry: { cueNumber: '101' }, confirmed: true },
        'Zone 2': { entry: { cueNumber: '102' }, confirmed: true }
      }
    });
    deps.qlabProtocol.stopCue.mockImplementation((cueNumber) =>
      cueNumber === '101' ? Promise.reject(new Error('no reply')) : Promise.resolve()
    );

    await expect(triggerVog(deps, vogMessage)).resolves.toEqual({
      fired: true,
      zones: ['Zone 1', 'Zone 2']
    });
    expect(deps.queueEngine.preemptZones).toHaveBeenCalledWith(['Zone 1', 'Zone 2']);
  });

  test('zero-zone VOG cue (fully muted/unrouted) skips stop/preempt entirely and still fires', async () => {
    const deps = makeDeps({ zones: [] });

    const result = await triggerVog(deps, vogMessage);

    expect(deps.qlabProtocol.stopCue).not.toHaveBeenCalled();
    expect(deps.queueEngine.preemptZones).not.toHaveBeenCalled();
    expect(deps.queueEngine.enqueue).toHaveBeenCalledWith(expect.objectContaining({ zones: [] }));
    expect(result).toEqual({ fired: true, zones: [] });
  });

  test('propagates fired:false if the queue engine reports the VOG cue as queued (e.g. race with another preempt)', async () => {
    const deps = makeDeps({ zones: ['Zone 1'] });
    deps.queueEngine.enqueue.mockResolvedValue({ fired: false });

    const result = await triggerVog(deps, vogMessage);

    expect(result).toEqual({ fired: false, zones: ['Zone 1'] });
  });

  test('ducks every resolved zone immediately, before enqueueing the VOG cue', async () => {
    const deps = makeDeps({ zones: ['Zone 1', 'Zone 2'] });

    await triggerVog(deps, vogMessage);

    expect(deps.duckImmediately).toHaveBeenCalledWith('Zone 1');
    expect(deps.duckImmediately).toHaveBeenCalledWith('Zone 2');
    const duckOrder = deps.duckImmediately.mock.invocationCallOrder[0];
    const enqueueOrder = deps.queueEngine.enqueue.mock.invocationCallOrder[0];
    expect(duckOrder).toBeLessThan(enqueueOrder);
  });

  test('marks every resolved zone as ducked on the queue engine after ducking', async () => {
    const deps = makeDeps({ zones: ['Zone 1', 'Zone 2'] });

    await triggerVog(deps, vogMessage);

    expect(deps.queueEngine.markDucked).toHaveBeenCalledWith(['Zone 1', 'Zone 2']);
    const duckOrder = deps.duckImmediately.mock.invocationCallOrder[0];
    const markDuckedOrder = deps.queueEngine.markDucked.mock.invocationCallOrder[0];
    expect(duckOrder).toBeLessThan(markDuckedOrder);
  });

  test('zero-zone VOG cue skips ducking entirely', async () => {
    const deps = makeDeps({ zones: [] });

    await triggerVog(deps, vogMessage);

    expect(deps.duckImmediately).not.toHaveBeenCalled();
    expect(deps.queueEngine.markDucked).not.toHaveBeenCalled();
  });

  test('a rejected duck call for one zone does not block ducking the others or firing the VOG cue', async () => {
    const deps = makeDeps({ zones: ['Zone 1', 'Zone 2'] });
    deps.duckImmediately.mockImplementation((zone) =>
      zone === 'Zone 1' ? Promise.reject(new Error('duck cue denied')) : Promise.resolve()
    );

    const result = await triggerVog(deps, vogMessage);

    expect(deps.duckImmediately).toHaveBeenCalledWith('Zone 1');
    expect(deps.duckImmediately).toHaveBeenCalledWith('Zone 2');
    expect(deps.queueEngine.markDucked).toHaveBeenCalledWith(['Zone 1', 'Zone 2']);
    expect(result).toEqual({ fired: true, zones: ['Zone 1', 'Zone 2'] });
  });
});

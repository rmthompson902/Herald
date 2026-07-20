'use strict';

const { ZoneQueueEngine } = require('../../lib/queue/zoneQueueEngine');

function fakeProtocol() {
  return {
    playCue: jest.fn().mockResolvedValue(undefined),
    // Default: cue is never already running, so entries admit on the first confirm check.
    // Individual tests override this to exercise the confirm-wait/retry path.
    getIsRunningByUniqueId: jest.fn().mockResolvedValue(false)
  };
}

function makeEngine(protocol, overrides = {}) {
  return new ZoneQueueEngine(protocol, {
    onEvent: jest.fn(),
    confirmRetryDelayMs: 100,
    confirmMaxAttempts: 5,
    // Disabled by default so existing tests' hand-computed timing math doesn't need to
    // account for it - the dedicated "settle window" tests below turn it back on.
    admissionSettleMs: 0,
    ...overrides
  });
}

function entry(id, zones, { dedupeKey, durationSeconds = 10, dueAt = 0, qlabInternalId } = {}) {
  return { id, zones, dedupeKey, durationSeconds, dueAt, cueNumber: id, qlabInternalId: qlabInternalId ?? id };
}

describe('ZoneQueueEngine', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('fires immediately when the zone is free and the cue is not already running', async () => {
    const protocol = fakeProtocol();
    const engine = makeEngine(protocol);

    const result = await engine.enqueue(entry('a', ['Zone 1']));

    expect(result.fired).toBe(true);
    expect(protocol.getIsRunningByUniqueId).toHaveBeenCalledWith('a');
    expect(protocol.playCue).toHaveBeenCalledWith('a');
  });

  it('queues a second entry for an occupied zone and fires it once the first frees', async () => {
    const protocol = fakeProtocol();
    const onEvent = jest.fn();
    const engine = makeEngine(protocol, { onEvent });

    const firstResult = await engine.enqueue(entry('a', ['Zone 1'], { durationSeconds: 10 }));
    const secondPromise = engine.enqueue(entry('b', ['Zone 1'], { dueAt: 1 }));
    const secondResult = await secondPromise;

    expect(firstResult.fired).toBe(true);
    expect(secondResult.fired).toBe(false);
    expect(protocol.playCue).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith('queued', expect.objectContaining({ id: 'b' }), undefined);

    await jest.advanceTimersByTimeAsync(10000); // fallback duration elapses -> zone frees -> b fires

    expect(protocol.playCue).toHaveBeenCalledWith('b');
    expect(onEvent).toHaveBeenCalledWith('zone_freed', expect.objectContaining({ id: 'a' }), { zone: 'Zone 1' });
    // b was genuinely queued behind a, so its eventual fire is flagged for a follow-up notification
    expect(onEvent).toHaveBeenCalledWith('fired', expect.objectContaining({ id: 'b' }), { afterQueue: true });
    // a fired immediately, no follow-up notification needed for it
    expect(onEvent).toHaveBeenCalledWith('fired', expect.objectContaining({ id: 'a' }), { afterQueue: false });
  });

  it('retries the live confirm if the cue looks still-running, then fires once it clears', async () => {
    const protocol = fakeProtocol();
    const onEvent = jest.fn();
    // First two checks say "still running" (simulating our duration estimate firing a hair
    // early), third check says it's actually finished.
    protocol.getIsRunningByUniqueId
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const engine = makeEngine(protocol, { onEvent, confirmRetryDelayMs: 100 });

    const promise = engine.enqueue(entry('a', ['Zone 1']));

    await jest.advanceTimersByTimeAsync(0);
    expect(protocol.playCue).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith('confirm_wait', expect.objectContaining({ id: 'a' }), { attempt: 0 });

    await jest.advanceTimersByTimeAsync(250);
    const result = await promise;

    expect(result.fired).toBe(true);
    expect(protocol.getIsRunningByUniqueId).toHaveBeenCalledTimes(3);
    expect(protocol.playCue).toHaveBeenCalledWith('a');
  });

  it('fires anyway once the confirm retry cap is hit, as a last-resort safety net', async () => {
    const protocol = fakeProtocol();
    const onEvent = jest.fn();
    protocol.getIsRunningByUniqueId.mockResolvedValue(true); // never clears
    const engine = makeEngine(protocol, { onEvent, confirmRetryDelayMs: 100, confirmMaxAttempts: 3 });

    const promise = engine.enqueue(entry('a', ['Zone 1']));
    await jest.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result.fired).toBe(true);
    expect(protocol.getIsRunningByUniqueId).toHaveBeenCalledTimes(4); // initial + 3 retries
    expect(onEvent).toHaveBeenCalledWith(
      'confirm_timeout_firing_anyway',
      expect.objectContaining({ id: 'a' }),
      { attempts: 3 }
    );
    expect(protocol.playCue).toHaveBeenCalledWith('a');
  });

  it('drops a stale waiting entry from the same schedule when a newer occurrence comes due', async () => {
    const protocol = fakeProtocol();
    const onEvent = jest.fn();
    const engine = makeEngine(protocol, { onEvent });

    await engine.enqueue(entry('occupant', ['Zone 1'], { durationSeconds: 100 }));
    const stalePromise = engine.enqueue(entry('sched1-fire1', ['Zone 1'], { dedupeKey: 'schedule-1', dueAt: 1 }));
    const resultPromise = engine.enqueue(entry('sched1-fire2', ['Zone 1'], { dedupeKey: 'schedule-1', dueAt: 2 }));
    const [, result] = await Promise.all([stalePromise, resultPromise]);

    expect(result.fired).toBe(false);
    expect(onEvent).toHaveBeenCalledWith(
      'dropped_stale',
      expect.objectContaining({ id: 'sched1-fire1' }),
      { zone: 'Zone 1' }
    );

    await jest.advanceTimersByTimeAsync(100000);
    expect(protocol.playCue).toHaveBeenCalledWith('sched1-fire2');
    expect(protocol.playCue).not.toHaveBeenCalledWith('sched1-fire1');
  });

  it('does not stale-drop entries without a dedupeKey (play-now/VOG)', async () => {
    const protocol = fakeProtocol();
    const engine = makeEngine(protocol);

    await engine.enqueue(entry('occupant', ['Zone 1'], { durationSeconds: 100 }));
    const p1 = engine.enqueue(entry('playnow1', ['Zone 1'], { dueAt: 1 }));
    const p2 = engine.enqueue(entry('playnow2', ['Zone 1'], { dueAt: 2 }));
    const [, result2] = await Promise.all([p1, p2]);

    expect(result2.fired).toBe(false);
    await jest.advanceTimersByTimeAsync(100000);
    // FIFO: playnow1 fires first since it was queued first (both lack a dedupeKey)
    expect(protocol.playCue).toHaveBeenCalledWith('playnow1');
    expect(protocol.playCue).not.toHaveBeenCalledWith('playnow2');
  });

  it('orders cross-schedule entries in the same zone by due time (FIFO)', async () => {
    const protocol = fakeProtocol();
    const engine = makeEngine(protocol);

    await engine.enqueue(entry('occupant', ['Zone 1'], { durationSeconds: 50 }));
    const p1 = engine.enqueue(entry('later', ['Zone 1'], { dueAt: 20 }));
    const p2 = engine.enqueue(entry('earlier', ['Zone 1'], { dueAt: 10 }));
    await Promise.all([p1, p2]);

    // occupant frees at 50s, then each of the two queued 10s-duration entries admits and
    // runs its own duration in turn before the next can fire.
    await jest.advanceTimersByTimeAsync(70000);

    const order = protocol.playCue.mock.calls.map((call) => call[0]);
    expect(order).toEqual(['occupant', 'earlier', 'later']);
  });

  it('breaks a same-second tie by cue number ascending, not arrival order', async () => {
    const protocol = fakeProtocol();
    const engine = makeEngine(protocol);

    await engine.enqueue(entry('occupant', ['Zone 1'], { durationSeconds: 50 }));
    // Both due within the same wall-clock second (500ms apart) - cue 103 arrives first but
    // cue 101 should still play first once the zone frees, since it has the lower number.
    const p103 = engine.enqueue({ ...entry('sched-103', ['Zone 1'], { dueAt: 500 }), cueNumber: '103' });
    const p101 = engine.enqueue({ ...entry('sched-101', ['Zone 1'], { dueAt: 900 }), cueNumber: '101' });
    await Promise.all([p103, p101]);

    await jest.advanceTimersByTimeAsync(70000);

    const order = protocol.playCue.mock.calls.map((call) => call[0]);
    expect(order).toEqual(['occupant', '101', '103']);
  });

  it('still orders strictly by due time across different seconds, regardless of cue number', async () => {
    const protocol = fakeProtocol();
    const engine = makeEngine(protocol);

    await engine.enqueue(entry('occupant', ['Zone 1'], { durationSeconds: 50 }));
    // cue 103 is genuinely due a full second earlier than cue 101 - it should still go
    // first, since this isn't a same-time collision at all.
    const p103 = engine.enqueue({ ...entry('sched-103', ['Zone 1'], { dueAt: 1000 }), cueNumber: '103' });
    const p101 = engine.enqueue({ ...entry('sched-101', ['Zone 1'], { dueAt: 2000 }), cueNumber: '101' });
    await Promise.all([p103, p101]);

    await jest.advanceTimersByTimeAsync(70000);

    const order = protocol.playCue.mock.calls.map((call) => call[0]);
    expect(order).toEqual(['occupant', '103', '101']);
  });

  it('does not head-of-line-block a single-zone entry behind an unrelated multi-zone entry stuck on another zone', async () => {
    // Reproduces a real reported bug: schedule 1 (cue 101, Zone 1 only), a "cue 2" schedule
    // (cue 102, Zone 1 AND Zone 2), and schedule 3 (cue 103, Zone 2 only) all become due at
    // once. Zone 2 is completely free for cue 103's entire wait - it should fire right away,
    // not be stuck behind cue 102 in Zone 2's queue just because 102 < 103 sorts it first
    // there, when cue 102 itself can't go yet (it's also waiting on the busy Zone 1).
    const protocol = fakeProtocol();
    const engine = makeEngine(protocol);

    const p101 = engine.enqueue({ ...entry('sched-101', ['Zone 1'], { dueAt: 1000 }), cueNumber: '101' });
    const p102 = engine.enqueue({
      ...entry('sched-102', ['Zone 1', 'Zone 2'], { dueAt: 1000, durationSeconds: 100 }),
      cueNumber: '102'
    });
    const p103 = engine.enqueue({ ...entry('sched-103', ['Zone 2'], { dueAt: 1000 }), cueNumber: '103' });

    const [result101, result102, result103] = await Promise.all([p101, p102, p103]);

    expect(result101.fired).toBe(true); // Zone 1 was free and only 101 needed it
    expect(result103.fired).toBe(true); // Zone 2 was free and only 103 needed it - must not wait on 102
    expect(result102.fired).toBe(false); // 102 needs both zones, both currently taken by 101/103

    const order = protocol.playCue.mock.calls.map((call) => call[0]);
    expect(order).toEqual(['101', '103']);
  });

  it('settle window: still fires a lone entry into a free zone once the window elapses', async () => {
    const protocol = fakeProtocol();
    const engine = makeEngine(protocol, { admissionSettleMs: 50 });

    const promise = engine.enqueue(entry('a', ['Zone 1']));
    await jest.advanceTimersByTimeAsync(0);
    expect(protocol.playCue).not.toHaveBeenCalled(); // still settling

    await jest.advanceTimersByTimeAsync(60);
    const result = await promise;

    expect(result.fired).toBe(true);
    expect(protocol.playCue).toHaveBeenCalledWith('a');
  });

  it('settle window: lets a slightly-later-arriving lower cue number still win a race into a free zone', async () => {
    const protocol = fakeProtocol();
    const engine = makeEngine(protocol, { admissionSettleMs: 50 });

    // Reproduces the real bug: cue 103's schedule tick reaches enqueue() a few ms before
    // cue 101's (cron-plus dispatch order, not anything meaningful) - without the settle
    // window, 103 would grab the free zone before 101 even arrives.
    const p103 = engine.enqueue({ ...entry('sched-103', ['Zone 1'], { dueAt: 1000 }), cueNumber: '103' });
    await jest.advanceTimersByTimeAsync(10);
    const p101 = engine.enqueue({ ...entry('sched-101', ['Zone 1'], { dueAt: 1005 }), cueNumber: '101' });

    await jest.advanceTimersByTimeAsync(100);
    await Promise.all([p103, p101]);

    expect(protocol.playCue).toHaveBeenCalledWith('101');
    expect(protocol.playCue).not.toHaveBeenCalledWith('103');
  });

  it('preemptZones unblocks an enqueue() call still waiting on that zone\'s settle window', async () => {
    const protocol = fakeProtocol();
    const engine = makeEngine(protocol, { admissionSettleMs: 5000 });

    const promise = engine.enqueue(entry('a', ['Zone 1']));
    await jest.advanceTimersByTimeAsync(0); // still settling, nowhere near the 5s window closing

    engine.preemptZones(['Zone 1']);
    const result = await promise; // must resolve, not hang forever

    expect(result.fired).toBe(false);
    expect(protocol.playCue).not.toHaveBeenCalled();
  });

  it('drops the oldest waiting entry once a zone queue exceeds the cap', async () => {
    const protocol = fakeProtocol();
    const onEvent = jest.fn();
    const engine = makeEngine(protocol, { onEvent, maxQueueLength: 2 });

    await engine.enqueue(entry('occupant', ['Zone 1'], { durationSeconds: 1000 }));
    const p1 = engine.enqueue(entry('q1', ['Zone 1'], { dueAt: 1 }));
    const p2 = engine.enqueue(entry('q2', ['Zone 1'], { dueAt: 2 }));
    const p3 = engine.enqueue(entry('q3', ['Zone 1'], { dueAt: 3 })); // pushes queue length to 3, over cap of 2
    await Promise.all([p1, p2, p3]);

    expect(onEvent).toHaveBeenCalledWith(
      'queue_overflow_dropped',
      expect.objectContaining({ id: 'q1' }),
      { zone: 'Zone 1' }
    );

    await jest.advanceTimersByTimeAsync(1020000);
    const order = protocol.playCue.mock.calls.map((call) => call[0]);
    expect(order).toEqual(['occupant', 'q2', 'q3']);
  });

  it('only admits a multi-zone entry once every one of its zones is free and it is at each queue front', async () => {
    const protocol = fakeProtocol();
    const engine = makeEngine(protocol);

    await engine.enqueue(entry('zone2-occupant', ['Zone 2'], { durationSeconds: 5 }));
    // enqueue()'s own promise only reflects the FIRST admission attempt - since this entry
    // can't be admitted yet (Zone 2 busy), it resolves quickly with {fired:false} and stays
    // that way even though the entry goes on to fire later; only playCue/onEvent observe that.
    const multiResult = await engine.enqueue(entry('vog-all', ['Zone 1', 'Zone 2'], { dueAt: 1 }));
    expect(multiResult.fired).toBe(false); // Zone 1 is free but Zone 2 is occupied
    expect(protocol.playCue).not.toHaveBeenCalledWith('vog-all');

    await jest.advanceTimersByTimeAsync(5000);

    expect(protocol.playCue).toHaveBeenCalledWith('vog-all');
  });

  it('frees a confirmed zone early on a real /updates-confirmed stop instead of waiting out the fallback timer', async () => {
    const protocol = fakeProtocol();
    const engine = makeEngine(protocol);

    await engine.enqueue(entry('a', ['Zone 1'], { durationSeconds: 100, qlabInternalId: 'uid-a' }));
    const bPromise = engine.enqueue(entry('b', ['Zone 1'], { dueAt: 1 }));

    protocol.getIsRunningByUniqueId.mockResolvedValueOnce(false); // confirms 'a' has actually stopped
    await engine.handleQlabUpdate('uid-a');
    await bPromise;

    expect(protocol.playCue).toHaveBeenCalledWith('b');
  });

  it('ignores /updates pushes for uniqueIds it is not tracking', async () => {
    const protocol = fakeProtocol();
    const engine = makeEngine(protocol);

    await engine.handleQlabUpdate('__root__');

    // only the initial per-entry confirm calls should exist - none for an untracked id
    expect(protocol.getIsRunningByUniqueId).not.toHaveBeenCalledWith('__root__');
  });

  it('ignores /updates pushes for a zone whose occupant is still mid-confirm (not yet fired)', async () => {
    const protocol = fakeProtocol();
    protocol.getIsRunningByUniqueId.mockResolvedValue(true); // 'a' never clears its own confirm
    const engine = makeEngine(protocol, { confirmMaxAttempts: 100 });

    engine.enqueue(entry('a', ['Zone 1'], { qlabInternalId: 'uid-a' }));
    await jest.advanceTimersByTimeAsync(0);

    const callsBefore = protocol.getIsRunningByUniqueId.mock.calls.length;
    await engine.handleQlabUpdate('uid-a'); // should no-op: 'a' isn't CONFIRMED occupying yet
    expect(protocol.getIsRunningByUniqueId.mock.calls.length).toBe(callsBefore);
  });

  it('preemptZones clears occupancy and drops waiting entries without requeueing', async () => {
    const protocol = fakeProtocol();
    const onEvent = jest.fn();
    const engine = makeEngine(protocol, { onEvent });

    await engine.enqueue(entry('occupant', ['Zone 1'], { durationSeconds: 1000 }));
    const waitingPromise = engine.enqueue(entry('waiting', ['Zone 1'], { dueAt: 1 }));

    engine.preemptZones(['Zone 1']);

    expect(onEvent).toHaveBeenCalledWith('vog_preempt_dropped', expect.objectContaining({ id: 'waiting' }), {
      zone: 'Zone 1'
    });

    const vogResult = await engine.enqueue(entry('vog', ['Zone 1'], { dueAt: 2 }));
    expect(vogResult.fired).toBe(true); // zone was actually cleared, not left occupied by "occupant"

    await jest.advanceTimersByTimeAsync(1000000);
    await waitingPromise;
    expect(protocol.playCue).not.toHaveBeenCalledWith('waiting');
  });

  it('fires immediately for a cue resolving to zero zones, without tracking any occupancy', async () => {
    const protocol = fakeProtocol();
    const engine = makeEngine(protocol);

    const result = await engine.enqueue(entry('muted', []));

    expect(result.fired).toBe(true);
    expect(protocol.playCue).toHaveBeenCalledWith('muted');
    expect(engine.getState().occupancy).toEqual({});
  });

  it('getState returns a read-only snapshot of occupancy and queued entries', async () => {
    const protocol = fakeProtocol();
    const engine = makeEngine(protocol);

    await engine.enqueue(entry('a', ['Zone 1'], { durationSeconds: 10 }));
    const bPromise = engine.enqueue(entry('b', ['Zone 1'], { dueAt: 1 }));

    const state = engine.getState();
    expect(state.occupancy['Zone 1'].entry.id).toBe('a');
    expect(state.occupancy['Zone 1'].confirmed).toBe(true);
    expect(state.queued['Zone 1']).toHaveLength(1);
    expect(state.queued['Zone 1'][0].id).toBe('b');

    await jest.advanceTimersByTimeAsync(10000);
    await bPromise;
  });

  it('getRecentEvents returns a chronological, optionally-filtered event log', async () => {
    const protocol = fakeProtocol();
    const engine = makeEngine(protocol);

    await engine.enqueue(entry('a', ['Zone 1']));
    const all = engine.getRecentEvents();
    expect(all.map((e) => e.event)).toEqual(['queued', 'fired']);
    expect(all[1].entry.cueNumber).toBe('a');

    const sinceFuture = engine.getRecentEvents(new Date(Date.now() + 60000).toISOString());
    expect(sinceFuture).toEqual([]);
  });
});

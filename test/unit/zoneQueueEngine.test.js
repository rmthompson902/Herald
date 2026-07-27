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

  it('frees the zone immediately on a failed/denied playCue, instead of holding it for the full duration', async () => {
    const protocol = fakeProtocol();
    protocol.playCue.mockRejectedValueOnce(new Error('QLab denied /cue/a/start: OSC control permissions off'));
    const onEvent = jest.fn();
    const engine = makeEngine(protocol, { onEvent });

    const result = await engine.enqueue(entry('a', ['Zone 1'], { durationSeconds: 1000 }));
    // Let the rejected playCue promise's .catch() run before asserting.
    await jest.advanceTimersByTimeAsync(0);

    expect(result.fired).toBe(true); // admission succeeded - the failure is in the OSC dispatch itself
    expect(onEvent).toHaveBeenCalledWith('error', expect.objectContaining({ id: 'a' }), {
      message: 'QLab denied /cue/a/start: OSC control permissions off'
    });
    expect(onEvent).toHaveBeenCalledWith('start_failed_zone_freed', expect.objectContaining({ id: 'a' }), {
      zone: 'Zone 1'
    });

    // A later entry doesn't wait out the 1000s duration timer - the zone is free right away.
    const laterResult = await engine.enqueue(entry('b', ['Zone 1'], { dueAt: 1 }));
    expect(laterResult.fired).toBe(true);
    expect(protocol.playCue).toHaveBeenCalledWith('b');
  });

  it('frees every zone of a multi-zone entry on a failed playCue, not just one', async () => {
    // Each zone of a multi-zone entry fires (and can fail) completely independently now -
    // reject every zone's own playCue call to model a denial affecting the whole cue.
    const protocol = fakeProtocol();
    protocol.playCue.mockRejectedValue(new Error('denied'));
    const engine = makeEngine(protocol);

    await engine.enqueue(entry('a', ['Zone 1', 'Zone 2'], { durationSeconds: 1000 }));
    await jest.advanceTimersByTimeAsync(0);

    protocol.playCue.mockResolvedValue(undefined); // the later entry's own attempt should succeed
    const laterResult = await engine.enqueue(entry('b', ['Zone 1', 'Zone 2'], { dueAt: 1 }));
    expect(laterResult.fired).toBe(true);
  });

  it('does not double-free or throw if the zone was already reclaimed before the failed playCue resolves', async () => {
    const protocol = fakeProtocol();
    let rejectPlayCue;
    protocol.playCue.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectPlayCue = reject;
      })
    );
    const onEvent = jest.fn();
    const engine = makeEngine(protocol, { onEvent });

    await engine.enqueue(entry('a', ['Zone 1'], { durationSeconds: 1000 }));

    // VOG preempts the zone before the stalled playCue call ever resolves.
    engine.preemptZones(['Zone 1']);
    rejectPlayCue(new Error('denied'));
    await jest.advanceTimersByTimeAsync(0);

    // 'a' is no longer the zone's occupant, so the failed-start handler must not touch it -
    // no crash, and it must not emit a bogus free for whatever (if anything) is there now.
    expect(onEvent).not.toHaveBeenCalledWith('start_failed_zone_freed', expect.anything(), expect.anything());
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

  it('admits each zone of a multi-zone entry independently - one zone firing never waits on another', async () => {
    // Zone 1 is free, Zone 2 is occupied - a multi-zone entry targeting both should still
    // fire its Zone 1 portion immediately rather than waiting for Zone 2 too (supersedes the
    // old "wait for every zone" admission rule - see ADR 0001 decision 4's amendment).
    const protocol = fakeProtocol();
    const engine = makeEngine(protocol);

    await engine.enqueue(entry('zone2-occupant', ['Zone 2'], { durationSeconds: 5 }));
    const multi = entry('vog-all', ['Zone 1', 'Zone 2'], { dueAt: 1 });
    multi.zoneDetails = {
      'Zone 1': { cueNumber: 'vog-zone1' },
      'Zone 2': { cueNumber: 'vog-zone2' }
    };
    const multiResult = await engine.enqueue(multi);

    expect(multiResult.fired).toBe(false); // Zone 2's own portion is still waiting
    expect(protocol.playCue).toHaveBeenCalledWith('vog-zone1'); // Zone 1's portion fired right away
    expect(protocol.playCue).not.toHaveBeenCalledWith('vog-zone2');

    await jest.advanceTimersByTimeAsync(5000);
    expect(protocol.playCue).toHaveBeenCalledWith('vog-zone2');
  });

  it('fires each zone of a multi-zone entry independently once THAT zone frees, even when unrelated single-zone entries already occupy every target zone (real reported scenario)', async () => {
    // Reproduces the operator's exact report: a multi-zone Group cue triggered while
    // single-zone messages are already independently playing in both of its target zones
    // must not wait for the SLOWER of the two to finish - each zone's portion fires the
    // instant that zone alone frees.
    const protocol = fakeProtocol();
    const engine = makeEngine(protocol);

    await engine.enqueue(entry('zone1-occupant', ['Zone 1'], { durationSeconds: 5 }));
    await engine.enqueue(entry('zone2-occupant', ['Zone 2'], { durationSeconds: 10 }));

    const group = entry('group', ['Zone 1', 'Zone 2'], { dueAt: 1 });
    group.zoneDetails = {
      'Zone 1': { cueNumber: 'group-zone1', durationSeconds: 3 },
      'Zone 2': { cueNumber: 'group-zone2', durationSeconds: 3 }
    };
    const groupResult = await engine.enqueue(group);
    expect(groupResult.fired).toBe(false); // both zones were busy at enqueue time

    await jest.advanceTimersByTimeAsync(5000); // Zone 1's occupant frees
    expect(protocol.playCue).toHaveBeenCalledWith('group-zone1');
    expect(protocol.playCue).not.toHaveBeenCalledWith('group-zone2'); // Zone 2's occupant (10s) still playing

    await jest.advanceTimersByTimeAsync(5000); // Zone 2's occupant (10s total) now frees
    expect(protocol.playCue).toHaveBeenCalledWith('group-zone2');
  });

  it('frees a confirmed zone early on a real /updates-confirmed stop instead of waiting out the fallback timer', async () => {
    const protocol = fakeProtocol();
    const onEvent = jest.fn();
    const engine = makeEngine(protocol, { onEvent });

    await engine.enqueue(entry('a', ['Zone 1'], { durationSeconds: 100, qlabInternalId: 'uid-a' }));
    const bPromise = engine.enqueue(entry('b', ['Zone 1'], { dueAt: 1 }));

    // Realistic jitter only (fade tail/rounding - see ADR decision 3) - confirmed stopped a
    // few seconds ahead of the full 100s estimate, not near-instantly, so this is a genuine
    // completion, not a suspected failure (see the dedicated suspected_playback_failure tests
    // below for that case).
    await jest.advanceTimersByTimeAsync(95000);
    protocol.getIsRunningByUniqueId.mockResolvedValueOnce(false); // confirms 'a' has actually stopped
    await engine.handleQlabUpdate('uid-a');
    await bPromise;

    expect(protocol.playCue).toHaveBeenCalledWith('b');
    expect(onEvent).toHaveBeenCalledWith('zone_freed', expect.objectContaining({ id: 'a' }), { zone: 'Zone 1' });
    expect(onEvent).not.toHaveBeenCalledWith('suspected_playback_failure', expect.anything(), expect.anything());
  });

  it('flags a confirmed stop as suspected_playback_failure when it lands far short of the known duration', async () => {
    // Mirrors a real investigated failure: a cue's Audio Patch had its output device
    // disconnected. QLab never denies the /cue/{n}/start OSC command itself in that case -
    // the only signal is an /updates push + a live isRunning re-query confirming "not
    // running" within ~50-80ms, versus this same cue's real ~9.3s duration every other time.
    const protocol = fakeProtocol();
    const onEvent = jest.fn();
    const engine = makeEngine(protocol, { onEvent });

    await engine.enqueue(entry('a', ['Zone 1'], { durationSeconds: 9.292, qlabInternalId: 'uid-a' }));

    await jest.advanceTimersByTimeAsync(50);
    protocol.getIsRunningByUniqueId.mockResolvedValueOnce(false);
    await engine.handleQlabUpdate('uid-a');

    expect(onEvent).toHaveBeenCalledWith('suspected_playback_failure', expect.objectContaining({ id: 'a' }), {
      zone: 'Zone 1',
      elapsedMs: 50,
      expectedMs: 9292
    });
    expect(onEvent).not.toHaveBeenCalledWith('zone_freed', expect.anything(), expect.anything());
  });

  it('does not flag a suspected failure when the cue has no known duration (fallback default in use)', async () => {
    // An unresolved/unknown duration falls back to a deliberately generous 30s safety net
    // (see the plan/ADR) - not a real expectation, so it must never be used as the baseline
    // for "implausibly early", or a real short cue with a merely-unresolved duration would
    // misfire as a false positive.
    const protocol = fakeProtocol();
    const onEvent = jest.fn();
    const engine = makeEngine(protocol, { onEvent, fallbackDurationSeconds: 30 });

    await engine.enqueue({ id: 'a', zones: ['Zone 1'], dueAt: 0, cueNumber: 'a', qlabInternalId: 'uid-a' });

    await jest.advanceTimersByTimeAsync(50);
    protocol.getIsRunningByUniqueId.mockResolvedValueOnce(false);
    await engine.handleQlabUpdate('uid-a');

    expect(onEvent).toHaveBeenCalledWith('zone_freed', expect.objectContaining({ id: 'a' }), { zone: 'Zone 1' });
    expect(onEvent).not.toHaveBeenCalledWith('suspected_playback_failure', expect.anything(), expect.anything());
  });

  it('treats the suspected-failure ratio boundary as strictly-less-than, not less-than-or-equal', async () => {
    const protocol = fakeProtocol();
    const onEvent = jest.fn();
    const engine = makeEngine(protocol, { onEvent, suspectedFailureRatio: 0.5 });

    await engine.enqueue(entry('a', ['Zone 1'], { durationSeconds: 10, qlabInternalId: 'uid-a' }));

    await jest.advanceTimersByTimeAsync(5000); // exactly 50% of the 10s duration
    protocol.getIsRunningByUniqueId.mockResolvedValueOnce(false);
    await engine.handleQlabUpdate('uid-a');

    expect(onEvent).toHaveBeenCalledWith('zone_freed', expect.objectContaining({ id: 'a' }), { zone: 'Zone 1' });
    expect(onEvent).not.toHaveBeenCalledWith('suspected_playback_failure', expect.anything(), expect.anything());
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

  it('does not fire an entry whose zone was preempted while its confirm-before-fire check was still in flight', async () => {
    // Real race caught via live testing: an entry can be reserved into a zone (settle
    // window closed, confirm-retry chain started) a moment before a VOG trigger's
    // preemptZones() reclaims that same zone. Without this guard the reserved entry's
    // confirm chain completes obliviously and fires anyway, into a zone VOG just claimed.
    const protocol = fakeProtocol();
    let resolveIsRunning;
    protocol.getIsRunningByUniqueId.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveIsRunning = resolve;
      })
    );
    const onEvent = jest.fn();
    const engine = makeEngine(protocol, { onEvent });

    const promise = engine.enqueue(entry('a', ['Zone 1'], { qlabInternalId: 'uid-a' }));

    // 'a' is now reserved into Zone 1 and mid-confirm (awaiting the still-pending
    // getIsRunningByUniqueId call above) - a VOG trigger preempts the zone right now.
    engine.preemptZones(['Zone 1']);

    resolveIsRunning(false); // let the now-stale confirm chain resolve
    const result = await promise;

    expect(result.fired).toBe(false);
    expect(protocol.playCue).not.toHaveBeenCalledWith('a');
    expect(onEvent).toHaveBeenCalledWith('preempted_before_fire', expect.objectContaining({ id: 'a' }), undefined);

    // Zone 1 is genuinely free again afterward - not left stuck occupied by the aborted entry.
    const laterResult = await engine.enqueue(entry('b', ['Zone 1'], { dueAt: 1 }));
    expect(laterResult.fired).toBe(true);
    expect(protocol.playCue).toHaveBeenCalledWith('b');
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
    expect(state.occupancy['Zone 1'].firedAt).toEqual(expect.any(Number));
    expect(state.occupancy['Zone 1'].knownDurationMs).toBe(10000);
    expect(state.queued['Zone 1']).toHaveLength(1);
    expect(state.queued['Zone 1'][0].id).toBe('b');

    await jest.advanceTimersByTimeAsync(10000);
    await bPromise;
  });

  it('getState reports knownDurationMs: null (never the fallback duration) when a fired entry\'s duration was never resolved', async () => {
    const protocol = fakeProtocol();
    const engine = makeEngine(protocol);

    await engine.enqueue(entry('a', ['Zone 1'], { durationSeconds: null }));

    const state = engine.getState();
    expect(state.occupancy['Zone 1'].knownDurationMs).toBeNull();
    expect(state.occupancy['Zone 1'].firedAt).toEqual(expect.any(Number));
  });

  it('getRecentEvents returns a chronological, optionally-filtered event log', async () => {
    const protocol = fakeProtocol();
    const engine = makeEngine(protocol);

    await engine.enqueue(entry('a', ['Zone 1']));
    const all = engine.getRecentEvents();
    expect(all.map((e) => e.event)).toEqual(['queued', 'duck_wait', 'fired']);
    expect(all[2].entry.cueNumber).toBe('a');

    const sinceFuture = engine.getRecentEvents(new Date(Date.now() + 60000).toISOString());
    expect(sinceFuture).toEqual([]);
  });

  it('ducks a zone once a solo message admits, and unducks once it frees', async () => {
    const protocol = fakeProtocol();
    const onZoneTransition = jest.fn();
    const engine = makeEngine(protocol, { onZoneTransition });

    const promise = engine.enqueue(entry('a', ['Zone 1'], { durationSeconds: 10 }));
    await jest.advanceTimersByTimeAsync(0);
    await promise;

    expect(onZoneTransition).toHaveBeenCalledWith('duck', 'Zone 1');
    expect(onZoneTransition).not.toHaveBeenCalledWith('unduck', 'Zone 1');

    await jest.advanceTimersByTimeAsync(10000); // durationSeconds elapses, zone frees
    expect(onZoneTransition).toHaveBeenCalledWith('unduck', 'Zone 1');
    expect(onZoneTransition).toHaveBeenCalledTimes(2); // exactly one duck, one unduck
  });

  it('does not unduck between two back-to-back messages in the same zone (no flicker)', async () => {
    const protocol = fakeProtocol();
    const onZoneTransition = jest.fn();
    const engine = makeEngine(protocol, { onZoneTransition });

    const pA = engine.enqueue(entry('a', ['Zone 1'], { durationSeconds: 10, dueAt: 0 }));
    await jest.advanceTimersByTimeAsync(0);
    await pA;

    // Queued behind 'a' well before its duration elapses - the back-to-back case.
    const pB = engine.enqueue(entry('b', ['Zone 1'], { durationSeconds: 10, dueAt: 1 }));

    // Advance exactly to 'a' freeing - 'b' should be admitted in the very same _tryAdvance pass.
    await jest.advanceTimersByTimeAsync(10000);
    await pB;

    const kinds = onZoneTransition.mock.calls.map(([kind]) => kind);
    expect(kinds.filter((k) => k === 'duck')).toHaveLength(1); // only at 'a''s original admission
    expect(kinds.filter((k) => k === 'unduck')).toHaveLength(0); // not between 'a' freeing and 'b' admitting

    // Only once 'b' itself frees, with nothing left behind it, does the zone genuinely idle.
    await jest.advanceTimersByTimeAsync(10000);
    const kindsAfter = onZoneTransition.mock.calls.map(([kind]) => kind);
    expect(kindsAfter.filter((k) => k === 'unduck')).toHaveLength(1);
  });

  it('ducks once (not twice) across a settle-window race, and does not unduck while still settling', async () => {
    const protocol = fakeProtocol();
    const onZoneTransition = jest.fn();
    const engine = makeEngine(protocol, { admissionSettleMs: 50, onZoneTransition });

    const p103 = engine.enqueue({ ...entry('sched-103', ['Zone 1'], { dueAt: 1000 }), cueNumber: '103' });
    await jest.advanceTimersByTimeAsync(10);
    const p101 = engine.enqueue({ ...entry('sched-101', ['Zone 1'], { dueAt: 1005 }), cueNumber: '101' });

    expect(onZoneTransition).not.toHaveBeenCalled(); // still within the settle window

    await jest.advanceTimersByTimeAsync(100);
    await Promise.all([p103, p101]);

    const kinds = onZoneTransition.mock.calls.map(([kind]) => kind);
    expect(kinds.filter((k) => k === 'duck')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'unduck')).toHaveLength(0);
  });

  it('preemptZones does not itself trigger unduck', async () => {
    const protocol = fakeProtocol();
    const onZoneTransition = jest.fn();
    const engine = makeEngine(protocol, { onZoneTransition });

    const promise = engine.enqueue(entry('a', ['Zone 1'], { durationSeconds: 1000 }));
    await jest.advanceTimersByTimeAsync(0);
    await promise;
    expect(onZoneTransition).toHaveBeenCalledWith('duck', 'Zone 1');

    onZoneTransition.mockClear();
    engine.preemptZones(['Zone 1']);

    expect(onZoneTransition).not.toHaveBeenCalled();
  });

  it('never ducks/unducks a cue that resolves to zero zones', async () => {
    const protocol = fakeProtocol();
    const onZoneTransition = jest.fn();
    const engine = makeEngine(protocol, { onZoneTransition });

    const result = await engine.enqueue(entry('a', []));

    expect(result.fired).toBe(true);
    expect(onZoneTransition).not.toHaveBeenCalled();
  });

  it('markDucked lets a zone VOG ducked directly still unduck via the normal idle-check path', async () => {
    const protocol = fakeProtocol();
    const onZoneTransition = jest.fn();
    const engine = makeEngine(protocol, { onZoneTransition });

    engine.markDucked(['Zone 1']);
    const result = await engine.enqueue(entry('a', ['Zone 1'], { durationSeconds: 10 }));

    expect(result.fired).toBe(true);
    // duck must not fire again here - markDucked already accounted for VOG's own direct duck.
    expect(onZoneTransition).not.toHaveBeenCalledWith('duck', 'Zone 1');

    await jest.advanceTimersByTimeAsync(10000);
    expect(onZoneTransition).toHaveBeenCalledWith('unduck', 'Zone 1');
  });

  it('does not fire the message until the zone\'s duck cue is confirmed done', async () => {
    const protocol = fakeProtocol();
    let resolveDuck;
    const onZoneTransition = jest.fn((kind) => {
      if (kind === 'duck') return new Promise((resolve) => { resolveDuck = resolve; });
      return Promise.resolve();
    });
    const engine = makeEngine(protocol, { onZoneTransition });

    const promise = engine.enqueue(entry('a', ['Zone 1']));
    await jest.advanceTimersByTimeAsync(0);

    expect(protocol.playCue).not.toHaveBeenCalled(); // still waiting on the duck cue to finish

    resolveDuck();
    await jest.advanceTimersByTimeAsync(0);
    await promise;

    expect(protocol.playCue).toHaveBeenCalledWith('a');
  });

  it('fires the message anyway if the duck onZoneTransition hook rejects (best-effort)', async () => {
    const protocol = fakeProtocol();
    const onZoneTransition = jest.fn().mockRejectedValue(new Error('duck cue denied'));
    const engine = makeEngine(protocol, { onZoneTransition });

    const promise = engine.enqueue(entry('a', ['Zone 1']));
    await jest.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result.fired).toBe(true);
    expect(protocol.playCue).toHaveBeenCalledWith('a');
  });

  it('does not fire the message if preempted while the duck-wait was still in flight', async () => {
    const protocol = fakeProtocol();
    let resolveDuck;
    const onZoneTransition = jest.fn((kind) => {
      if (kind === 'duck') return new Promise((resolve) => { resolveDuck = resolve; });
      return Promise.resolve();
    });
    const onEvent = jest.fn();
    const engine = makeEngine(protocol, { onZoneTransition, onEvent });

    const promise = engine.enqueue(entry('a', ['Zone 1']));
    await jest.advanceTimersByTimeAsync(0);

    engine.preemptZones(['Zone 1']);
    resolveDuck();
    await jest.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result.fired).toBe(false);
    expect(protocol.playCue).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith('preempted_before_fire', expect.objectContaining({ id: 'a' }), undefined);
  });

  it('does not free the zone for new admission until the unduck cue is confirmed done', async () => {
    const protocol = fakeProtocol();
    let resolveUnduck;
    const onZoneTransition = jest.fn((kind) => {
      if (kind === 'unduck') return new Promise((resolve) => { resolveUnduck = resolve; });
      return Promise.resolve();
    });
    const engine = makeEngine(protocol, { onZoneTransition });

    const pA = engine.enqueue(entry('a', ['Zone 1'], { durationSeconds: 10 }));
    await jest.advanceTimersByTimeAsync(0);
    await pA;

    await jest.advanceTimersByTimeAsync(10000); // 'a' frees - unduck is now in flight, unresolved

    const pB = engine.enqueue(entry('b', ['Zone 1'], { dueAt: 1 }));
    await jest.advanceTimersByTimeAsync(0);
    expect(protocol.playCue).not.toHaveBeenCalledWith('b'); // must queue, not fire, mid-unduck

    resolveUnduck();
    await jest.advanceTimersByTimeAsync(0);
    await pB;

    expect(protocol.playCue).toHaveBeenCalledWith('b');
  });

  it('preempting a zone mid-unduck-wait clears the synthetic reservation cleanly', async () => {
    const protocol = fakeProtocol();
    let resolveUnduck;
    const onZoneTransition = jest.fn((kind) => {
      if (kind === 'unduck') return new Promise((resolve) => { resolveUnduck = resolve; });
      return Promise.resolve();
    });
    const engine = makeEngine(protocol, { onZoneTransition });

    const pA = engine.enqueue(entry('a', ['Zone 1'], { durationSeconds: 10 }));
    await jest.advanceTimersByTimeAsync(0);
    await pA;
    await jest.advanceTimersByTimeAsync(10000); // frees - synthetic unduck marker now reserving the zone

    expect(engine.getState().occupancy['Zone 1']).toBeDefined();

    engine.preemptZones(['Zone 1']);
    expect(engine.getState().occupancy['Zone 1']).toBeUndefined();

    resolveUnduck(); // a late resolution must not throw or re-occupy the zone
    await jest.advanceTimersByTimeAsync(0);
    expect(engine.getState().occupancy['Zone 1']).toBeUndefined();
  });

  it('frees each zone of a multi-zone entry on its OWN discrete duration, not a shared one (Group cue case)', async () => {
    const protocol = fakeProtocol();
    const onZoneTransition = jest.fn();
    const engine = makeEngine(protocol, { onZoneTransition });

    // Models a Group cue whose Zone 1 child is 5s and Zone 2 child is 10s - QLab would
    // report the group's own overall duration as 10s (the longest), but each zone should
    // free on its OWN child's real duration.
    const group = entry('group', ['Zone 1', 'Zone 2'], { durationSeconds: 10 });
    group.zoneDetails = { 'Zone 1': { durationSeconds: 5 }, 'Zone 2': { durationSeconds: 10 } };
    const promise = engine.enqueue(group);
    await jest.advanceTimersByTimeAsync(0);
    await promise;

    await jest.advanceTimersByTimeAsync(5000);
    expect(engine.getState().occupancy['Zone 1']).toBeUndefined(); // freed on its own 5s
    expect(engine.getState().occupancy['Zone 2']).toBeDefined(); // still busy for its own 10s
    expect(onZoneTransition).toHaveBeenCalledWith('unduck', 'Zone 1');
    expect(onZoneTransition).not.toHaveBeenCalledWith('unduck', 'Zone 2');

    await jest.advanceTimersByTimeAsync(5000);
    expect(engine.getState().occupancy['Zone 2']).toBeUndefined();
    expect(onZoneTransition).toHaveBeenCalledWith('unduck', 'Zone 2');
  });

  it('admits a new entry into a Group\'s shorter zone without waiting for the longer zone to clear', async () => {
    const protocol = fakeProtocol();
    const engine = makeEngine(protocol);

    const group = entry('group', ['Zone 1', 'Zone 2'], { durationSeconds: 10, dueAt: 0 });
    group.zoneDetails = { 'Zone 1': { durationSeconds: 5 }, 'Zone 2': { durationSeconds: 10 } };
    const pGroup = engine.enqueue(group);
    await jest.advanceTimersByTimeAsync(0);
    await pGroup;

    // Queued behind the group in Zone 1 only - should be admitted once Zone 1 (5s) frees,
    // not held up by Zone 2's longer 10s.
    const pNext = engine.enqueue(entry('next', ['Zone 1'], { dueAt: 1 }));

    await jest.advanceTimersByTimeAsync(5000);
    await pNext;
    expect(protocol.playCue).toHaveBeenCalledWith('next');
  });
});

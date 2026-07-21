'use strict';

const { playCueAndWaitForDuration } = require('../../lib/zones/duckDuration');

function fakeProtocol() {
  return {
    playCue: jest.fn().mockResolvedValue(undefined),
    getDuration: jest.fn().mockResolvedValue(2)
  };
}

describe('playCueAndWaitForDuration', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('plays the cue, then waits out its own live-queried duration before resolving', async () => {
    const protocol = fakeProtocol();
    let done = false;

    const promise = playCueAndWaitForDuration(protocol, '1198').then(() => {
      done = true;
    });

    await jest.advanceTimersByTimeAsync(0);
    expect(protocol.playCue).toHaveBeenCalledWith('1198');
    expect(done).toBe(false); // 2s duration hasn't elapsed yet

    await jest.advanceTimersByTimeAsync(2000);
    await promise;
    expect(done).toBe(true);
  });

  it('resolves immediately (after playing) if the duration query fails', async () => {
    const protocol = fakeProtocol();
    protocol.getDuration.mockRejectedValue(new Error('timeout'));

    await expect(playCueAndWaitForDuration(protocol, '1198')).resolves.toBeUndefined();
    expect(protocol.playCue).toHaveBeenCalledWith('1198');
  });

  it('resolves immediately if the duration is zero, negative, or not a number', async () => {
    const protocol = fakeProtocol();

    for (const bad of [0, -1, NaN, undefined, null]) {
      protocol.getDuration.mockResolvedValue(bad);
      await expect(playCueAndWaitForDuration(protocol, '1198')).resolves.toBeUndefined();
    }
  });

  it('still waits out the duration even if playCue itself rejects', async () => {
    const protocol = fakeProtocol();
    protocol.playCue.mockRejectedValue(new Error('cue denied'));
    let done = false;

    const promise = playCueAndWaitForDuration(protocol, '1198').then(() => {
      done = true;
    });

    await jest.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);

    await jest.advanceTimersByTimeAsync(2000);
    await promise;
    expect(done).toBe(true);
  });
});

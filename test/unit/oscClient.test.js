'use strict';

jest.mock('osc', () => {
  const EventEmitter = require('events');

  class FakeUDPPort extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.send = jest.fn();
      this.open = jest.fn(() => this.emit('ready'));
      this.close = jest.fn();
    }
  }

  return { UDPPort: jest.fn().mockImplementation((options) => new FakeUDPPort(options)) };
});

const osc = require('osc');
const { OscClient } = require('../../lib/osc/oscClient');

function getLastFakePort() {
  const results = osc.UDPPort.mock.results;
  return results[results.length - 1].value;
}

function replyEnvelope(status, data) {
  return { type: 'message', args: [{ type: 's', value: JSON.stringify({ status, data }) }] };
}

describe('OscClient', () => {
  let client;
  let lastFakePort;

  beforeEach(async () => {
    client = new OscClient({ localPort: 53001, remoteAddress: '127.0.0.1', remotePort: 53000 });
    await client.open();
    lastFakePort = getLastFakePort();
  });

  it('resolves request() with the reply data on status ok', async () => {
    const pending = client.request('/cue/101/duration');
    lastFakePort.emit('message', {
      address: '/reply/cue/101/duration',
      args: replyEnvelope('ok', 9.62).args
    });

    await expect(pending).resolves.toBe(9.62);
    expect(lastFakePort.send).toHaveBeenCalledWith({ address: '/cue/101/duration', args: [] });
  });

  it('rejects request() when QLab denies the command', async () => {
    const pending = client.request('/cue/101/start');
    lastFakePort.emit('message', {
      address: '/reply/cue/101/start',
      args: replyEnvelope('denied').args
    });

    await expect(pending).rejects.toThrow(/denied/);
  });

  it('times out if no reply arrives', async () => {
    jest.useFakeTimers();
    const pending = client.request('/cue/999/duration', [], { timeoutMs: 100 });
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    jest.advanceTimersByTime(150);
    await assertion;
    jest.useRealTimers();
  });

  it('correlates concurrent requests to the same address in FIFO order', async () => {
    const first = client.request('/cue/101/duration');
    const second = client.request('/cue/101/duration');

    lastFakePort.emit('message', {
      address: '/reply/cue/101/duration',
      args: replyEnvelope('ok', 1).args
    });
    lastFakePort.emit('message', {
      address: '/reply/cue/101/duration',
      args: replyEnvelope('ok', 2).args
    });

    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
  });

  it('emits "message" for every inbound message, including ones nothing is waiting on', () => {
    const handler = jest.fn();
    client.on('message', handler);

    lastFakePort.emit('message', { address: '/update/workspace/x/cue_id/y', args: [] });

    expect(handler).toHaveBeenCalledWith({ address: '/update/workspace/x/cue_id/y', args: [] });
  });

  it("requestOptionalReply resolves undefined on silence (QLab's success-is-silent control commands)", async () => {
    jest.useFakeTimers();
    const pending = client.requestOptionalReply('/cue/101/start', [], { timeoutMs: 100 });
    const assertion = expect(pending).resolves.toBeUndefined();
    jest.advanceTimersByTime(150);
    await assertion;
    jest.useRealTimers();
  });

  it('requestOptionalReply still rejects if an explicit denied reply arrives in time', async () => {
    const pending = client.requestOptionalReply('/cue/101/start');
    lastFakePort.emit('message', {
      address: '/reply/cue/101/start',
      args: replyEnvelope('denied').args
    });

    await expect(pending).rejects.toThrow(/denied/);
  });

  it('send() is fire-and-forget with no correlation bookkeeping', () => {
    client.send('/udpKeepAlive', [{ type: 'i', value: 1 }]);
    expect(lastFakePort.send).toHaveBeenCalledWith({
      address: '/udpKeepAlive',
      args: [{ type: 'i', value: 1 }]
    });
  });

  describe('transport error handling', () => {
    // EventEmitter special-cases 'error': emitted with no listener attached, it throws
    // synchronously and crashes the whole process - a real gap found via a robustness
    // review (nothing anywhere was listening to oscClient's proxied port errors). This
    // pins the fix: a bare OscClient, with no caller-attached listener at all, must survive
    // a transport error without throwing.
    it('does not throw when the underlying UDP port emits an error, even with no external listener attached', () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => lastFakePort.emit('error', new Error('EADDRINUSE'))).not.toThrow();
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('EADDRINUSE'));

      consoleError.mockRestore();
    });

    it('still notifies a caller-attached error listener in addition to the baseline safety net', () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      const onError = jest.fn();
      client.on('error', onError);

      lastFakePort.emit('error', new Error('ENETUNREACH'));

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'ENETUNREACH' }));

      consoleError.mockRestore();
    });
  });
});

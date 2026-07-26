'use strict';

const EventEmitter = require('events');
const { HealthMonitor } = require('../../lib/health/healthMonitor');

function fakeProtocol() {
  return {
    thump: jest.fn(),
    keepAlive: jest.fn(),
    subscribeUpdates: jest.fn().mockResolvedValue(undefined)
  };
}

describe('HealthMonitor', () => {
  let protocol;
  let client;
  let monitor;

  beforeEach(() => {
    jest.useFakeTimers();
    protocol = fakeProtocol();
    client = new EventEmitter();
    monitor = new HealthMonitor(protocol, client, { heartbeatIntervalMs: 1000, missThreshold: 2 });
  });

  afterEach(() => {
    monitor.stop();
    jest.useRealTimers();
  });

  it('starts unarmed, and arms after a successful heartbeat', async () => {
    protocol.thump.mockResolvedValue('thump');
    expect(monitor.isArmed()).toBe(false);

    await monitor.start(); // immediate tick on start()

    expect(monitor.getState()).toBe('connected');
    expect(monitor.isArmed()).toBe(true);
    expect(protocol.subscribeUpdates).toHaveBeenCalled();
  });

  it('disarms after missThreshold consecutive heartbeat failures', async () => {
    protocol.thump.mockRejectedValue(new Error('timeout'));
    const disconnected = jest.fn();
    monitor.on('disconnected', disconnected);

    await monitor.start(); // miss 1
    expect(monitor.isArmed()).toBe(false); // below threshold yet, but never was connected either

    await jest.advanceTimersByTimeAsync(1000); // miss 2 -> hits threshold
    expect(monitor.getState()).toBe('disconnected');
    expect(disconnected).toHaveBeenCalledTimes(1);
  });

  it('does not disconnect on a single miss once already connected', async () => {
    protocol.thump.mockResolvedValueOnce('thump');
    await monitor.start();
    expect(monitor.isArmed()).toBe(true);

    protocol.thump.mockRejectedValueOnce(new Error('timeout'));
    await jest.advanceTimersByTimeAsync(1000); // single miss, threshold is 2

    expect(monitor.getState()).toBe('connected');
    expect(monitor.isArmed()).toBe(true);
  });

  it('reconnects (re-arms) after a successful heartbeat following a disconnect', async () => {
    protocol.thump.mockRejectedValue(new Error('timeout'));
    await monitor.start();
    await jest.advanceTimersByTimeAsync(1000);
    expect(monitor.getState()).toBe('disconnected');

    protocol.thump.mockResolvedValue('thump');
    await jest.advanceTimersByTimeAsync(1000);

    expect(monitor.getState()).toBe('connected');
    expect(monitor.isArmed()).toBe(true);
  });

  it('treats an explicit /update/.../disconnect message as an immediate hard disconnect', async () => {
    protocol.thump.mockResolvedValue('thump');
    await monitor.start();
    expect(monitor.isArmed()).toBe(true);

    client.emit('message', { address: '/update/workspace/abc-123/disconnect', args: [] });

    expect(monitor.getState()).toBe('disconnected');
    expect(monitor.isArmed()).toBe(false);
  });

  it('sends keepAlive alongside every heartbeat tick', async () => {
    protocol.thump.mockResolvedValue('thump');
    await monitor.start();
    expect(protocol.keepAlive).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1000);
    expect(protocol.keepAlive).toHaveBeenCalledTimes(2);
  });

  it('logs a subscribeUpdates() startup failure via the injected logger instead of swallowing it silently', async () => {
    // Previously this had no logging at all (just a comment) - found via a real robustness
    // review. Not fatal by design (the heartbeat loop still surfaces real disconnects via
    // the normal miss-threshold path), but a startup-time failure here deserves a durable
    // trace, especially now that appLogger exists to carry it.
    protocol.subscribeUpdates.mockRejectedValueOnce(new Error('OSC request timed out'));
    protocol.thump.mockResolvedValue('thump');
    const log = { warn: jest.fn() };
    const loggedMonitor = new HealthMonitor(protocol, client, { heartbeatIntervalMs: 1000, log });

    await loggedMonitor.start();

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('OSC request timed out'));
    expect(loggedMonitor.isArmed()).toBe(true); // still arms normally via the heartbeat itself

    loggedMonitor.stop();
  });

  it('does not throw when subscribeUpdates() fails and no logger was injected', async () => {
    protocol.subscribeUpdates.mockRejectedValueOnce(new Error('OSC request timed out'));
    protocol.thump.mockResolvedValue('thump');

    await expect(monitor.start()).resolves.toBeUndefined();
  });
});

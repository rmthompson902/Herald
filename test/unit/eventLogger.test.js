'use strict';

const EventEmitter = require('events');

const { attachEventLogger } = require('../../lib/log/eventLogger');

// A real EventEmitter, not a plain object - winston's actual Logger is one too, and the
// transport-error-handling tests below depend on that (see attachEventLogger's own 'error'
// wiring, which calls logger.on(...)).
function fakeLogger() {
  const logger = new EventEmitter();
  logger.info = jest.fn();
  return logger;
}

describe('eventLogger', () => {
  describe('logQueueEvent', () => {
    it('formats a fired event with entry fields and extra', () => {
      const logger = fakeLogger();
      const { logQueueEvent } = attachEventLogger(logger);

      logQueueEvent(
        'fired',
        { id: 'sched-1-123', cueNumber: '101', zones: ['Zone 1'], name: 'Lobby Safety' },
        { afterQueue: true }
      );

      expect(logger.info).toHaveBeenCalledTimes(1);
      const line = logger.info.mock.calls[0][0];
      expect(line).toContain('fired');
      expect(line).toContain('id=sched-1-123');
      expect(line).toContain('cue=101');
      expect(line).toContain('zones=["Zone 1"]');
      expect(line).toContain('name=Lobby Safety');
      expect(line).toContain('afterQueue=true');
    });

    it('omits extra entirely when none is passed', () => {
      const logger = fakeLogger();
      const { logQueueEvent } = attachEventLogger(logger);

      logQueueEvent('queued', { id: 'a', cueNumber: '101', zones: ['Zone 1'] });

      const line = logger.info.mock.calls[0][0];
      expect(line).toBe('queued id=a cue=101 zones=["Zone 1"]');
    });

    it('omits undefined/null entry fields rather than printing them literally', () => {
      const logger = fakeLogger();
      const { logQueueEvent } = attachEventLogger(logger);

      logQueueEvent('dropped_stale', { id: 'b', cueNumber: '102', zones: [] }, { zone: 'Zone 1' });

      const line = logger.info.mock.calls[0][0];
      expect(line).not.toContain('name=');
      expect(line).not.toContain('source=');
      expect(line).toContain('zone=Zone 1');
    });

    it('includes source for VOG-originated entries', () => {
      const logger = fakeLogger();
      const { logQueueEvent } = attachEventLogger(logger);

      logQueueEvent('fired', {
        id: 'vog-1',
        cueNumber: '104',
        zones: ['Zone 1', 'Zone 2'],
        source: 'vog'
      });

      expect(logger.info.mock.calls[0][0]).toContain('source=vog');
    });
  });

  describe('logHealthTransition', () => {
    it('logs health_reconnect when transitioning to connected', () => {
      const logger = fakeLogger();
      const { logHealthTransition } = attachEventLogger(logger);

      logHealthTransition('disconnected', 'connected');

      expect(logger.info).toHaveBeenCalledWith('health_reconnect from=disconnected to=connected');
    });

    it('logs health_disconnect for any transition away from connected', () => {
      const logger = fakeLogger();
      const { logHealthTransition } = attachEventLogger(logger);

      logHealthTransition('connected', 'disconnected');

      expect(logger.info).toHaveBeenCalledWith('health_disconnect from=connected to=disconnected');
    });

    it('logs health_disconnect for the initial unknown -> disconnected transition too', () => {
      const logger = fakeLogger();
      const { logHealthTransition } = attachEventLogger(logger);

      logHealthTransition('unknown', 'disconnected');

      expect(logger.info).toHaveBeenCalledWith('health_disconnect from=unknown to=disconnected');
    });
  });

  describe('transport error handling', () => {
    // winston's Logger is itself an EventEmitter - an unhandled transport 'error' (disk
    // full, permission denied, a mid-rotation failure) throws and crashes the process, same
    // gap as lib/osc/oscClient.js had. This pins the fix: attaching the returned functions
    // must not require the CALLER to also remember to attach an error listener.
    it('does not throw when the underlying logger emits a transport error, even with no external listener attached', () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      const logger = fakeLogger();
      attachEventLogger(logger); // attaching alone must install the safety net

      expect(() => logger.emit('error', new Error('ENOSPC'))).not.toThrow();
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('ENOSPC'));

      consoleError.mockRestore();
    });
  });
});

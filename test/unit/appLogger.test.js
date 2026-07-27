'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAppLogger, attachAppLogger, logFatalAndExit } = require('../../lib/log/appLogger');

function tempLogDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qlab-sched-test-applogger-'));
}

function fakeRootLogger() {
  const child = { debug: jest.fn(), warn: jest.fn(), info: jest.fn() };
  return { root: { child: jest.fn(() => child) }, child };
}

describe('appLogger', () => {
  describe('attachAppLogger', () => {
    it('returns a factory that tags each child logger with its module name', () => {
      const { root, child } = fakeRootLogger();
      const getLogger = attachAppLogger(root);

      const oscLog = getLogger('oscClient');

      expect(root.child).toHaveBeenCalledWith({ module: 'oscClient' });
      expect(oscLog).toBe(child);
    });

    it('creates a distinct child per module name', () => {
      const { root } = fakeRootLogger();
      const getLogger = attachAppLogger(root);

      getLogger('oscClient');
      getLogger('healthMonitor');

      expect(root.child).toHaveBeenCalledTimes(2);
      expect(root.child).toHaveBeenNthCalledWith(1, { module: 'oscClient' });
      expect(root.child).toHaveBeenNthCalledWith(2, { module: 'healthMonitor' });
    });
  });

  describe('createAppLogger transport error handling', () => {
    // winston's Logger is itself an EventEmitter - an unhandled transport 'error' (disk
    // full, permission denied, a mid-rotation failure) throws and crashes the process
    // exactly like lib/osc/oscClient.js's identical gap. Uses the real, fs-backed logger
    // (not the fake-root half above) since the fix lives in createAppLogger itself, before
    // attachAppLogger ever sees it.
    it('does not throw when a named child logger emits a transport error, with no external listener attached', () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      const getLogger = createAppLogger(tempLogDir());
      const oscLog = getLogger('oscClient');

      expect(() => oscLog.emit('error', new Error('ENOSPC'))).not.toThrow();
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('ENOSPC'));

      consoleError.mockRestore();
    });
  });

  describe('logFatalAndExit', () => {
    // The whole point: this backs process.on('uncaughtException'/'unhandledRejection') in
    // node-red/settings.js - the last-resort backstop for whatever this session's other,
    // more specific fixes didn't anticipate. It has to actually preserve the "why" (wait for
    // the async file write to really finish before exiting) without being able to hang the
    // process forever if that write itself fails.
    it('logs the formatted message and exits only once the write actually completes', () => {
      let onWritten;
      const logger = {
        error: jest.fn((_message, cb) => {
          onWritten = cb;
        })
      };
      const exit = jest.fn();

      logFatalAndExit(logger, 'Uncaught exception - process exiting', 'boom', { exit });

      expect(logger.error).toHaveBeenCalledWith(
        'Uncaught exception - process exiting: boom',
        expect.any(Function)
      );
      expect(exit).not.toHaveBeenCalled(); // must not exit before the write is confirmed done

      onWritten();
      expect(exit).toHaveBeenCalledTimes(1);
    });

    it('falls back to exiting on a timeout if the write never completes (e.g. a hung/failing transport)', () => {
      jest.useFakeTimers();
      const logger = { error: jest.fn() }; // never invokes its callback - simulates a hang
      const exit = jest.fn();

      logFatalAndExit(logger, 'label', 'message', { exit, timeoutMs: 2000 });
      expect(exit).not.toHaveBeenCalled();

      jest.advanceTimersByTime(2000);
      expect(exit).toHaveBeenCalledTimes(1);

      jest.useRealTimers();
    });

    it('never exits twice, whichever of the write-complete callback or the timeout fires first', () => {
      jest.useFakeTimers();
      let onWritten;
      const logger = {
        error: jest.fn((_message, cb) => {
          onWritten = cb;
        })
      };
      const exit = jest.fn();

      logFatalAndExit(logger, 'label', 'message', { exit, timeoutMs: 2000 });
      onWritten(); // write completes first
      jest.advanceTimersByTime(2000); // timeout still fires afterward - must be a no-op

      expect(exit).toHaveBeenCalledTimes(1);

      jest.useRealTimers();
    });

    it('defaults to process.exit(1) when no exit function is injected', () => {
      const processExit = jest.spyOn(process, 'exit').mockImplementation(() => {});
      let onWritten;
      const logger = {
        error: jest.fn((_message, cb) => {
          onWritten = cb;
        })
      };

      logFatalAndExit(logger, 'label', 'message');
      onWritten();

      expect(processExit).toHaveBeenCalledWith(1);
      processExit.mockRestore();
    });
  });
});

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAppLogger, attachAppLogger } = require('../../lib/log/appLogger');

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
});

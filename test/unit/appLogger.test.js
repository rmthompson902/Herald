'use strict';

const { attachAppLogger } = require('../../lib/log/appLogger');

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
});

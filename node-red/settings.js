'use strict';

const path = require('path');
const { createCore } = require('../lib/index');

const core = createCore({
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'schedule.db'),
  zoneMapPath: path.join(__dirname, '..', 'config', 'zone-map.json'),
  qlabOscHost: process.env.QLAB_OSC_HOST || '127.0.0.1',
  qlabOscPort: Number(process.env.QLAB_OSC_PORT || 53000),
  localOscPort: Number(process.env.LOCAL_OSC_PORT || 53001)
});

module.exports = {
  uiPort: Number(process.env.DASHBOARD_PORT || 1880),
  flowFile: 'flows.json',

  // No dashboard/editor auth - access is gated entirely by KVM + a locked-down LAN/
  // firewall perimeter on the deployed machine (confirmed decision, see docs/claude-plan.md).
  functionGlobalContext: {
    core
  },

  logging: {
    console: {
      level: 'info',
      metrics: false,
      audit: false
    }
  }
};

'use strict';

const path = require('path');
const { createCore } = require('../lib/index');
const cronSyncMessages = require('./lib/applyCronSyncDirectives');
const { refreshCueCache } = require('./lib/refreshCueCache');

const core = createCore({
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'schedule.db'),
  zoneMapPath: path.join(__dirname, '..', 'config', 'zone-map.json'),
  qlabOscHost: process.env.QLAB_OSC_HOST || '127.0.0.1',
  qlabOscPort: Number(process.env.QLAB_OSC_PORT || 53000),
  localOscPort: Number(process.env.LOCAL_OSC_PORT || 53001)
});

module.exports = {
  uiPort: Number(process.env.NODE_RED_API_PORT || process.env.DASHBOARD_PORT || 1880),
  // Headless: no dashboard UI lives here anymore (see Frontend Pivot in the plan). This is
  // now an internal API only the co-located FastAPI app calls - never expose it to the LAN.
  uiHost: '127.0.0.1',
  flowFile: 'flows.json',

  // No auth anywhere - access is gated entirely by KVM + a locked-down LAN/firewall
  // perimeter on the deployed machine, plus this API being loopback-only (confirmed
  // decisions, see docs/claude-plan.md).
  functionGlobalContext: {
    core,
    cronSyncMessages,
    refreshCueCache
  },

  logging: {
    console: {
      level: 'info',
      metrics: false,
      audit: false
    }
  }
};

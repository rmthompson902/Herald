'use strict';

const path = require('path');
const { createCore } = require('../lib/index');
const cronSyncMessages = require('./lib/applyCronSyncDirectives');
const { refreshCueCache, refreshAllReferencedCues } = require('./lib/refreshCueCache');

const core = createCore({
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'schedule.db'),
  zoneMapPath: path.join(__dirname, '..', 'config', 'zone-map.json'),
  qlabOscHost: process.env.QLAB_OSC_HOST || '127.0.0.1',
  qlabOscPort: Number(process.env.QLAB_OSC_PORT || 53000),
  localOscPort: Number(process.env.LOCAL_OSC_PORT || 53001),
  // zoneQueueEngine had no logging at all until a real bug (a queued entry silently never
  // firing) was only discoverable by listening for audio - see docs/adr/0001. Replace with
  // lib/log/eventLogger.js once that lands instead of this bare console.log; the engine
  // also keeps its own short-lived recent-events buffer regardless (see getRecentEvents,
  // exposed via GET /api/queue/events), which is what the webapp polls for notifications.
  onQueueEvent: (event, entry, extra) => {
    console.log(`[queue] ${event} id=${entry.id} cue=${entry.cueNumber} zones=${JSON.stringify(entry.zones)}${extra ? ' ' + JSON.stringify(extra) : ''}`);
  }
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
    refreshCueCache,
    refreshAllReferencedCues
  },

  logging: {
    console: {
      level: 'info',
      metrics: false,
      audit: false
    }
  }
};

'use strict';

const path = require('path');
const { createCore } = require('../lib/index');
const { createEventLogger } = require('../lib/log/eventLogger');
const { createAppLogger, logFatalAndExit } = require('../lib/log/appLogger');
const cronSyncMessages = require('./lib/applyCronSyncDirectives');
const { refreshCueCache, refreshAllReferencedCues } = require('./lib/refreshCueCache');
const zonesAdmin = require('./lib/zonesAdmin');
const { deriveZoneSuggestion } = require('../lib/zones/zoneNamingConvention');
const { createHandlers } = require('./lib/handlers');

// Daily-rotating, 30-day-retained plain-text business event log (see plan's Logging
// section) - this is what the webapp's /history page tails directly.
const eventLogger = createEventLogger(path.join(__dirname, '..', 'logs'));

// General diagnostics, same directory/retention/rotation as eventLogger but a separate
// file (app-*.log) and a separate purpose - full raw detail (every inbound OSC message,
// among other things) rather than curated one-line-per-business-event history.
const appLogger = createAppLogger(path.join(__dirname, '..', 'logs'));

// Last-resort safety net, registered as early as possible (before createCore, before
// anything else that could throw): every other fix this session (oscClient's/the loggers'
// EventEmitter 'error' handling, the FastAPI pollers, healthMonitor's silent catch, ...)
// turned a SPECIFIC known crash into graceful, logged, non-fatal handling. This is the
// generic backstop for whatever we haven't anticipated - Node's own docs say resuming
// normal operation after an uncaughtException is unsafe, so it still exits (launchd's
// KeepAlive - see deploy/launchd/ - is what actually restarts it), but now the reason
// lands in the same durable, rotated app-*.log as everything else, not only in the raw,
// unrotated logs/launchd-node-red-error.log that launchd captures independently.
process.on('uncaughtException', (err) => {
  logFatalAndExit(
    appLogger('process'),
    'Uncaught exception - process exiting',
    err.stack || err.message
  );
});
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
  logFatalAndExit(appLogger('process'), 'Unhandled promise rejection - process exiting', message);
});

const core = createCore({
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'schedule.db'),
  audioPatchMapPath: path.join(__dirname, '..', 'config', 'audio-patch-map.json'),
  qlabOscHost: process.env.QLAB_OSC_HOST || '127.0.0.1',
  qlabOscPort: Number(process.env.QLAB_OSC_PORT || 53000),
  localOscPort: Number(process.env.LOCAL_OSC_PORT || 53001),
  onQueueEvent: eventLogger.logQueueEvent,
  appLogger
});

// healthMonitor emits 'stateChange' on every real transition (see lib/health/healthMonitor.js) -
// log each one so a disconnect/reconnect shows up in the same operator-facing history the
// queue events do, not just in Node-RED's own console.
core.health.on('stateChange', ({ from, to }) => eventLogger.logHealthTransition(from, to));

// Extracted flow/endpoint logic (see node-red/lib/handlers) - each logic-bearing flows.json
// function node is a thin wrapper calling into these, so the branching stays plain and
// unit-testable instead of living in flows.json function-node strings.
const handlers = createHandlers({
  core,
  cronSyncMessages,
  refreshCueCache,
  refreshAllReferencedCues,
  zonesAdmin,
  deriveZoneSuggestion
});

module.exports = {
  uiPort: Number(process.env.NODE_RED_API_PORT || process.env.DASHBOARD_PORT || 1880),
  // Headless: no dashboard UI lives here anymore (see Frontend Pivot in the plan). This is
  // now an internal API only the co-located FastAPI app calls - never expose it to the LAN.
  uiHost: '127.0.0.1',
  flowFile: 'flows.json',

  // No auth anywhere - access is gated entirely by KVM + a locked-down LAN/firewall
  // perimeter on the deployed machine, plus this API being loopback-only (confirmed
  // decisions, see docs/01-overview.md).
  functionGlobalContext: {
    core,
    cronSyncMessages,
    refreshCueCache,
    refreshAllReferencedCues,
    zonesAdmin,
    deriveZoneSuggestion,
    handlers
  },

  logging: {
    console: {
      level: 'info',
      metrics: false,
      audit: false
    }
  }
};

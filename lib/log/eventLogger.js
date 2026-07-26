'use strict';

const fs = require('fs');
const winston = require('winston');
require('winston-daily-rotate-file');

const RETENTION = '30d';

/**
 * One human-readable plain-text line per business event, daily-rotated with 30-day
 * retention (see plan's Logging section) - this is what the webapp's /history page tails
 * directly (app/routers/pages.py's history_page, no proxy/API), so the format favors being
 * readable straight out of a text editor over being machine-parsed.
 *
 * @param {string} logDir - directory to write events-YYYY-MM-DD.log into (created if missing)
 * @returns {{ logQueueEvent: Function, logHealthTransition: Function }}
 */
function createEventLogger(logDir) {
  fs.mkdirSync(logDir, { recursive: true });

  const transport = new winston.transports.DailyRotateFile({
    dirname: logDir,
    filename: 'events-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxFiles: RETENTION,
    utc: false
  });

  const logger = winston.createLogger({
    transports: [transport],
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.printf(({ timestamp, message }) => `${timestamp} ${message}`)
    )
  });

  return attachEventLogger(logger);
}

function formatFields(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
}

/**
 * Separated from createEventLogger so tests can exercise the formatting/field logic
 * against a plain in-memory winston logger instead of touching the filesystem.
 */
function attachEventLogger(logger) {
  // winston's Logger is itself an EventEmitter - an unhandled transport 'error' (disk full,
  // permission denied, a mid-rotation failure) throws and crashes the process, same as
  // lib/osc/oscClient.js's identical gap (see that file's comment for the full reasoning).
  // Lives here rather than in createEventLogger so it's covered by the same
  // filesystem-free tests as everything else in this function.
  logger.on('error', (err) => {
    console.error(`[eventLogger] transport error: ${err.message}`);
  });

  /** Same signature as zoneQueueEngine's onEvent hook - wire directly in as onQueueEvent. */
  function logQueueEvent(event, entry, extra) {
    const line = [
      event,
      formatFields({
        id: entry?.id,
        cue: entry?.cueNumber,
        zones: entry?.zones,
        name: entry?.name,
        source: entry?.source
      }),
      extra ? formatFields(extra) : ''
    ]
      .filter(Boolean)
      .join(' ');
    logger.info(line);
  }

  /** Wire to healthMonitor's 'stateChange' event: ({ from, to }) => ... */
  function logHealthTransition(from, to) {
    const event = to === 'connected' ? 'health_reconnect' : 'health_disconnect';
    logger.info(`${event} ${formatFields({ from, to })}`);
  }

  return { logQueueEvent, logHealthTransition };
}

module.exports = { createEventLogger, attachEventLogger };

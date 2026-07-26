'use strict';

const fs = require('fs');
const winston = require('winston');
require('winston-daily-rotate-file');

const RETENTION = '30d';

/**
 * General application diagnostics (see plan's Logging section) - daily-rotated,
 * 30-day-retained, one named child logger per lib/ module via the returned factory.
 * Console (configurable level, default info) + file (always debug, full detail) mirrors
 * the user's reference Python TimedRotatingFileHandler setup ("name - level - message"),
 * adapted to Node's idioms - a child logger's `module` metadata substitutes for Python's
 * `%(funcName)s:%(lineno)d`, which isn't cheaply available in Node without stack parsing.
 *
 * @param {string} logDir - directory to write app-YYYY-MM-DD.log into (created if missing)
 * @param {{ consoleLevel?: string }} [options]
 * @returns {(moduleName: string) => winston.Logger} factory for a named child logger
 */
function createAppLogger(logDir, { consoleLevel = 'info' } = {}) {
  fs.mkdirSync(logDir, { recursive: true });

  const fileTransport = new winston.transports.DailyRotateFile({
    dirname: logDir,
    filename: 'app-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxFiles: RETENTION,
    utc: false,
    level: 'debug'
  });

  const root = winston.createLogger({
    level: 'debug', // root must allow debug through, or the file transport never sees it
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.printf(
        ({ timestamp, level, message, module: moduleName }) =>
          `${timestamp} - ${moduleName || 'app'} - ${level} - ${message}`
      )
    ),
    transports: [new winston.transports.Console({ level: consoleLevel }), fileTransport]
  });

  // winston's Logger is itself an EventEmitter, and a transport error (disk full,
  // permission denied on logs/, a mid-rotation failure) bubbles up as 'error' on it -
  // unhandled, that's the same EventEmitter special case that crashes the process (see
  // lib/osc/oscClient.js's identical fix). Console-only and dependency-free deliberately -
  // if the FILE transport is what just failed, logging the failure back through the same
  // logger isn't a safe fallback.
  root.on('error', (err) => {
    console.error(`[appLogger] transport error: ${err.message}`);
  });

  return attachAppLogger(root);
}

/**
 * Separated from createAppLogger so tests can exercise child-logger wiring against a plain
 * fake logger instead of touching the filesystem (same split as eventLogger.js).
 */
function attachAppLogger(root) {
  return (moduleName) => root.child({ module: moduleName });
}

module.exports = { createAppLogger, attachAppLogger };

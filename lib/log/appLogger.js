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
 * Note: this is not the only place Node-RED's own output can land. When it's run under the
 * launchd LaunchAgent (see deploy/launchd/), raw stdout/stderr - including anything printed
 * before this logger exists, or a crash severe enough to bypass it entirely - goes to
 * logs/launchd-node-red.log / -error.log instead (see that folder's README). When run
 * manually via a plain `nohup` during dev (rather than through launchd), that same raw
 * console output has instead been redirected ad hoc to /private/tmp/node-red-*.log on
 * this machine - not a fixed convention, just wherever a given manual run happened to point
 * it, so check `lsof -p <pid>` for fd 1/2 if that filename doesn't exist on a given box.
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

const DEFAULT_FATAL_LOG_TIMEOUT_MS = 2000;

/**
 * Logs a fatal error via `logger` and then exits - the top-level process.on('uncaughtException'
 * / 'unhandledRejection') handler's job (see node-red/settings.js), split out here so it's
 * unit-testable without actually calling process.exit(). Node's own docs say resuming normal
 * operation after an uncaughtException is unsafe, so exiting (and relying on launchd's
 * KeepAlive - see deploy/launchd/ - to restart) is the correct response, not a fallback.
 *
 * The one real subtlety: winston's file writes are async, so calling exit() immediately after
 * logger.error() risks losing the very message this function exists to preserve, if the
 * process dies before the write flushes. This waits for winston's own per-call callback
 * (fires once every transport has written the message) before exiting - with a timeout
 * fallback so a hung/failing write (e.g. a full disk - see this file's own transport-error
 * handling above) can't prevent the process from ever actually exiting and being restarted.
 *
 * @param {{ error: Function }} logger
 * @param {string} label
 * @param {string} message
 * @param {{ exit?: Function, timeoutMs?: number }} [options] - exit is injectable for tests
 */
function logFatalAndExit(
  logger,
  label,
  message,
  { exit = () => process.exit(1), timeoutMs = DEFAULT_FATAL_LOG_TIMEOUT_MS } = {}
) {
  let exited = false;
  const exitOnce = () => {
    if (exited) return;
    exited = true;
    exit();
  };

  const timer = setTimeout(exitOnce, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  logger.error(`${label}: ${message}`, () => {
    clearTimeout(timer);
    exitOnce();
  });
}

module.exports = { createAppLogger, attachAppLogger, logFatalAndExit };

'use strict';

const EventEmitter = require('events');

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
const DEFAULT_MISS_THRESHOLD = 2;
const DISCONNECT_ADDRESS_SUFFIX = '/disconnect';

/**
 * Tracks whether QLab is alive and responding, using a /thump heartbeat (with a reply we
 * can actually wait on) alongside /udpKeepAlive (fire-and-forget, prevents QLab dropping
 * our UDP registration after 61s idle - see test/fixtures/qlab-osc-findings.md).
 *
 * Also listens for the /updates push feed's explicit `/update/workspace/{id}/disconnect`
 * message, which is an immediate hard signal - no need to wait out the miss threshold for
 * a clean QLab shutdown.
 *
 * isArmed() is the single thing the scheduler should check before firing anything - this
 * is the "stay disarmed until QLab is confirmed live" startup gate from the plan.
 */
class HealthMonitor extends EventEmitter {
  /**
   * @param {object} qlabProtocol
   * @param {object} oscClient
   * @param {object} [options]
   * @param {number} [options.heartbeatIntervalMs]
   * @param {number} [options.missThreshold]
   * @param {{ warn: Function }} [options.log] - optional, e.g. config.appLogger('healthMonitor')
   *   (see lib/index.js) - purely diagnostic, the monitor's own state-machine behavior never
   *   depends on it being present.
   */
  constructor(
    qlabProtocol,
    oscClient,
    {
      heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
      missThreshold = DEFAULT_MISS_THRESHOLD,
      log
    } = {}
  ) {
    super();
    this._protocol = qlabProtocol;
    this._client = oscClient;
    this._heartbeatIntervalMs = heartbeatIntervalMs;
    this._missThreshold = missThreshold;
    this._log = log;

    this._state = 'unknown';
    this._consecutiveMisses = 0;
    this._timer = null;

    this._onMessage = (msg) => {
      if (msg.address.endsWith(DISCONNECT_ADDRESS_SUFFIX)) {
        this._transitionTo('disconnected');
      }
    };
  }

  async start() {
    this._client.on('message', this._onMessage);
    try {
      await this._protocol.subscribeUpdates();
    } catch (err) {
      // subscribing failing is itself a liveness signal, not fatal - the heartbeat loop
      // will keep retrying and will surface it via the normal miss-threshold path. Still
      // worth a durable trace though - previously this was silently thrown away with no
      // logging anywhere at all, found via a real robustness review.
      this._log?.warn(`subscribeUpdates failed at startup: ${err.message}`);
    }
    this._timer = setInterval(() => this._tick(), this._heartbeatIntervalMs);
    this._tick();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._client.removeListener('message', this._onMessage);
  }

  getState() {
    return this._state;
  }

  isArmed() {
    return this._state === 'connected';
  }

  async _tick() {
    this._protocol.keepAlive();

    try {
      await this._protocol.thump();
      this._consecutiveMisses = 0;
      this._transitionTo('connected');
    } catch {
      this._consecutiveMisses += 1;
      if (this._consecutiveMisses >= this._missThreshold) {
        this._transitionTo('disconnected');
      }
    }
  }

  _transitionTo(newState) {
    if (this._state === newState) return;
    const previousState = this._state;
    this._state = newState;
    this.emit('stateChange', { from: previousState, to: newState });
    this.emit(newState);
  }
}

module.exports = { HealthMonitor };

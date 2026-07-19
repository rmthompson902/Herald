'use strict';

const osc = require('osc');
const EventEmitter = require('events');

const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Thin OSC-over-UDP transport with request/response correlation. QLab replies to a query
 * sent to address X on `/reply` + X (see test/fixtures/qlab-osc-findings.md), so pending
 * requests are tracked per reply-address in FIFO order - if two requests to the same
 * address are in flight at once, replies are matched oldest-first (QLab processes and
 * replies to a given address in order in every case observed during Phase 0).
 *
 * Emits 'message' for every inbound OSC message (including push-only ones like /update/...
 * that no request() call is waiting on), so callers can also just listen for pushes.
 */
class OscClient extends EventEmitter {
  constructor({ localAddress = '0.0.0.0', localPort, remoteAddress, remotePort }) {
    super();
    this._pending = new Map(); // replyAddress -> array of {resolve, reject, timer}
    this._port = new osc.UDPPort({
      localAddress,
      localPort,
      remoteAddress,
      remotePort,
      metadata: true
    });

    this._port.on('message', (msg) => this._handleMessage(msg));
    this._port.on('error', (err) => this.emit('error', err));
  }

  open() {
    return new Promise((resolve) => {
      this._port.on('ready', resolve);
      this._port.open();
    });
  }

  close() {
    this._port.close();
  }

  /** Fire-and-forget send; no reply is awaited (e.g. /thump, /udpKeepAlive, /updates). */
  send(address, args = []) {
    this._port.send({ address, args });
  }

  /**
   * Sends `address` and waits for a reply on `/reply` + address, parsing QLab's
   * JSON-string reply envelope. Rejects on timeout or a non-"ok" status.
   *
   * Only use this for QUERY addresses (duration, levels, uniqueID, cueLists, thump,
   * /updates subscribe) - QLab always replies to those, confirmed in Phase 0/2. Do NOT use
   * this for cue control (start/stop): confirmed empirically that QLab only replies to
   * those on DENIAL - a successful start/stop plays/stops the cue silently with no reply
   * at all, which would make this method time out despite success. Use
   * requestOptionalReply() for those instead.
   */
  request(address, args = [], { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return this._registerPending(address, args, timeoutMs, (reject, replyAddress) => {
      reject(new Error(`OSC request timed out waiting for ${replyAddress}`));
    });
  }

  /**
   * Like request(), but silence within the timeout window resolves with `undefined`
   * instead of rejecting - for control addresses (cue start/stop) where QLab only sends
   * an explicit reply on denial, and success is silent (see request() doc above). An
   * explicit denied reply arriving within the window still rejects, so misconfiguration
   * (e.g. OSC control permissions not enabled) is still caught.
   */
  requestOptionalReply(address, args = [], { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return this._registerPending(address, args, timeoutMs, (_reject, _replyAddress, resolve) => {
      resolve(undefined);
    });
  }

  _registerPending(address, args, timeoutMs, onTimeout) {
    const replyAddress = `/reply${address}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const queue = this._pending.get(replyAddress);
        if (queue) {
          const index = queue.findIndex((entry) => entry.timer === timer);
          if (index !== -1) queue.splice(index, 1);
        }
        onTimeout(reject, replyAddress, resolve);
      }, timeoutMs);

      const entry = { resolve, reject, timer };
      if (!this._pending.has(replyAddress)) this._pending.set(replyAddress, []);
      this._pending.get(replyAddress).push(entry);

      this._port.send({ address, args });
    });
  }

  _handleMessage(msg) {
    this.emit('message', msg);

    const queue = this._pending.get(msg.address);
    if (!queue || queue.length === 0) return;

    const { resolve, reject, timer } = queue.shift();
    clearTimeout(timer);

    try {
      const envelope = JSON.parse(msg.args[0].value);
      if (envelope.status === 'ok') {
        resolve(envelope.data);
      } else {
        reject(new Error(`QLab denied ${msg.address}: ${JSON.stringify(envelope)}`));
      }
    } catch (err) {
      reject(new Error(`Failed to parse OSC reply envelope from ${msg.address}: ${err.message}`));
    }
  }
}

module.exports = { OscClient };

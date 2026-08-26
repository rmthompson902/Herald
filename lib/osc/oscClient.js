'use strict';

const osc = require('osc');
const EventEmitter = require('events');

const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Thin OSC transport with request/response correlation. QLab replies to a query sent to
 * address X on `/reply` + X (see test/fixtures/qlab-osc-findings.md), so pending requests
 * are tracked per reply-address in FIFO order - if two requests to the same address are in
 * flight at once, replies are matched oldest-first (QLab processes and replies to a given
 * address in order in every case observed during Phase 0).
 *
 * Primarily UDP (request/requestOptionalReply/send, all sharing one long-lived port), plus
 * one dedicated TCP+SLIP escape hatch (requestOverTcp) for the one address whose reply can
 * exceed what a single UDP datagram can carry - see requestOverTcp()'s own doc and
 * docs/adr/0012-cuelists-tcp-transport.md.
 *
 * Emits 'message' for every inbound UDP OSC message (including push-only ones like
 * /update/... that no request() call is waiting on), so callers can also just listen for
 * pushes. requestOverTcp() deliberately does not emit on this shared channel - see its doc.
 */
class OscClient extends EventEmitter {
  constructor({ localAddress = '0.0.0.0', localPort, remoteAddress, remotePort }) {
    super();
    this._pending = new Map(); // replyAddress -> array of {resolve, reject, timer}
    // Retained for requestOverTcp() below, which opens its own one-off connection per call
    // rather than sharing this._port.
    this._remoteAddress = remoteAddress;
    this._remotePort = remotePort;
    this._port = new osc.UDPPort({
      localAddress,
      localPort,
      remoteAddress,
      remotePort,
      metadata: true
    });

    this._port.on('message', (msg) => this._handleMessage(msg));
    this._port.on('error', (err) => this.emit('error', err));

    // EventEmitter special-cases 'error': emitted with no listener attached, it throws
    // synchronously and crashes the whole process - found via a real review, not a report,
    // but a genuine gap (nothing anywhere was listening). A UDP transport error (port
    // conflict, ENETUNREACH, a permission blip) must never be able to take the entire app
    // down just because a caller forgot to attach its own listener. This baseline listener
    // guarantees at least one always exists; callers (see lib/index.js) can still attach
    // their own for routed/durable diagnostics - this one is deliberately last-resort and
    // dependency-free (console only), so it works even outside the Node-RED composition root.
    this.on('error', (err) => {
      console.error(`[oscClient] OSC transport error: ${err.message}`);
    });
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

  /**
   * Like request(), but over a brand-new, one-shot TCP+SLIP connection (osc.TCPSocketPort,
   * which extends SLIPPort and handles RFC 1055 framing automatically) instead of the
   * shared UDP port.
   *
   * Why: QLab's OSC-over-UDP replies are capped by UDP's practical ~65,507-byte datagram
   * ceiling. `/cueLists`' reply for a large workspace can be far bigger (confirmed against
   * a real "US Open 2026" show file: ~653,000 bytes) - QLab attempts to send it but it can
   * never arrive over UDP, at any timeout. The identical reply arrives over TCP+SLIP in
   * ~40ms. See docs/adr/0012-cuelists-tcp-transport.md and
   * test/fixtures/qlab-osc-findings.md.
   *
   * Opens a fresh TCPSocketPort to the same QLab host/port as the UDP transport, sends
   * exactly one message, resolves/rejects on the one reply (reusing _settleFromReply - the
   * same envelope-parsing/status-check logic as request()), and always closes the
   * connection afterward, success or failure. No persistent/reused connection, no reconnect
   * logic - each call is fully self-contained, which also means a QLab restart mid-show
   * needs no special handling here (the next call just reconnects).
   *
   * Deliberately does NOT go through this._pending/_handleMessage, and does NOT
   * this.emit('message', ...) on `this`: unlike the shared, multiplexed UDP port, this
   * connection carries exactly one request and one reply, so no reply-address correlation
   * is needed, and getCueLists() (the only caller) runs on every schedule
   * create/update/playNow/onDue and on every periodic cue-cache refresh sweep - emitting
   * (and having appLogger log) a ~653KB payload that often would be a real log-bloat
   * regression this surgical fix must not introduce.
   *
   * Use ONLY for addresses whose reply can plausibly exceed UDP's datagram ceiling
   * (currently just /cueLists, via qlabProtocol.getCueLists()). Every other address stays
   * on the shared UDP request()/requestOptionalReply()/send() path.
   */
  requestOverTcp(address, args = [], { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      const port = new osc.TCPSocketPort({
        address: this._remoteAddress,
        port: this._remotePort,
        metadata: true
      });

      let settled = false;
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          port.close();
        } catch {
          // already closing/closed/never opened - never let cleanup mask the real outcome
        }
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => reject(new Error(`OSC TCP request timed out waiting for /reply${address}`)));
      }, timeoutMs);

      port.on('error', (err) => finish(() => reject(err)));
      port.on('ready', () => port.send({ address, args }));
      port.on('message', (msg) => {
        this._settleFromReply(
          msg,
          (data) => finish(() => resolve(data)),
          (err) => finish(() => reject(err))
        );
      });

      port.open();
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
    this._settleFromReply(msg, resolve, reject);
  }

  /**
   * Shared QLab reply-envelope parsing: resolves with envelope.data on status "ok", rejects
   * on denial or a malformed envelope. Used by both the UDP pending-queue path
   * (_handleMessage) and requestOverTcp()'s one-shot TCP reply.
   */
  _settleFromReply(msg, resolve, reject) {
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

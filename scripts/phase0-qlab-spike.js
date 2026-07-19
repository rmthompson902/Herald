#!/usr/bin/env node
// Phase 0 spike: validate our assumptions about QLab's OSC behavior against a REAL,
// running QLab instance (see docs/adr and the implementation plan for context). This is
// deliberately a standalone script with no Node-RED/lib/ dependency — its only job is to
// confirm facts before lib/osc/qlabProtocol.js is written against them.
//
// Usage:
//   QLAB_CUE=1 node scripts/phase0-qlab-spike.js
//   (QLAB_CUE should be a real cue number/id that exists in your open QLab workspace)
//
// Env vars:
//   QLAB_OSC_HOST   default 127.0.0.1
//   QLAB_OSC_PORT   default 53000   (QLab's OSC listening port)
//   LOCAL_OSC_PORT  default 53001   (port this script listens on for replies)
//   QLAB_CUE        cue number/id to test duration/levels/uniqueID queries against
//   LISTEN_SECONDS  default 60      (how long to listen for /updates events after subscribing)
//
// Everything received is logged to stdout AND appended as JSON lines to
// test/fixtures/qlab-spike-capture.jsonl, so raw payloads are preserved for later reference
// while building lib/osc/qlabProtocol.js.

const osc = require('osc');
const fs = require('fs');
const path = require('path');

const HOST = process.env.QLAB_OSC_HOST || '127.0.0.1';
const PORT = Number(process.env.QLAB_OSC_PORT || 53000);
const LOCAL_PORT = Number(process.env.LOCAL_OSC_PORT || 53001);
const CUE = process.env.QLAB_CUE || null;
const LISTEN_SECONDS = Number(process.env.LISTEN_SECONDS || 60);

const fixturePath = path.join(__dirname, '..', 'test', 'fixtures', 'qlab-spike-capture.jsonl');
fs.mkdirSync(path.dirname(fixturePath), { recursive: true });

function record(direction, address, args) {
  const entry = { t: new Date().toISOString(), direction, address, args };
  console.log(`[${entry.t}] ${direction} ${address}`, JSON.stringify(args));
  fs.appendFileSync(fixturePath, JSON.stringify(entry) + '\n');
}

const port = new osc.UDPPort({
  localAddress: '0.0.0.0',
  localPort: LOCAL_PORT,
  remoteAddress: HOST,
  remotePort: PORT,
  metadata: true
});

function send(address, args = []) {
  record('SEND', address, args);
  port.send({ address, args });
}

port.on('error', (err) => {
  console.error('OSC port error:', err.message);
});

port.on('message', (msg) => {
  record('RECV', msg.address, msg.args);
});

port.on('ready', async () => {
  console.log(`\n== Phase 0 QLab OSC spike ==`);
  console.log(`Listening on 0.0.0.0:${LOCAL_PORT}, talking to QLab at ${HOST}:${PORT}`);
  console.log(`Capturing all traffic to ${fixturePath}\n`);

  // 1. Heartbeat check
  console.log('--- Step 1: /thump heartbeat ---');
  send('/thump');

  await sleep(500);

  // 2. UDP keep-alive — QLab drops idle UDP OSC clients after 61s otherwise.
  console.log('\n--- Step 2: /udpKeepAlive ---');
  send('/udpKeepAlive', [{ type: 'T', value: true }]); // OSC boolean-true argument

  await sleep(500);

  // 3. Cue list enumeration — try the documented candidate addresses.
  console.log('\n--- Step 3: cue list enumeration (trying candidate addresses) ---');
  send('/cueLists');
  await sleep(300);
  send('/workspaces');
  await sleep(300);

  // 4. Per-cue queries, if a cue number was provided.
  if (CUE) {
    console.log(`\n--- Step 4: per-cue queries for cue "${CUE}" ---`);
    send(`/cue/${CUE}/duration`);
    await sleep(300);
    send(`/cue/${CUE}/levels`);
    await sleep(300);
    send(`/cue/${CUE}/uniqueID`);
    await sleep(300);
    send(`/cue/${CUE}/valuesForKeys`, [{ type: 's', value: JSON.stringify(['duration', 'uniqueID']) }]);
    await sleep(300);
  } else {
    console.log('\n--- Step 4 skipped: set QLAB_CUE=<a real cue number> to test duration/levels/uniqueID ---');
  }

  // 5. Subscribe to the push-update feed and just listen.
  console.log(`\n--- Step 5: subscribing to /updates for ${LISTEN_SECONDS}s ---`);
  console.log('While this runs: manually play/stop a cue in QLab\'s own UI and watch for /update/... messages below.');
  send('/updates', [{ type: 'i', value: 1 }]);

  await sleep(LISTEN_SECONDS * 1000);

  console.log('\n--- Step 6: unsubscribing, done ---');
  send('/updates', [{ type: 'i', value: 0 }]);
  await sleep(300);

  console.log(`\nCapture complete. Raw payloads saved to ${fixturePath}`);
  console.log('Review the RECV lines above against the plan\'s Open Items before writing lib/osc/qlabProtocol.js.');
  port.close();
  process.exit(0);
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

port.open();

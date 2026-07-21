#!/usr/bin/env node
// Patch-rework spike: validate our assumptions about QLab's Audio Patch OSC surface against
// a REAL, running QLab instance, now that the workspace uses one dedicated Messaging Audio
// Patch per zone instead of a single shared crosspoint matrix (see the current plan file /
// docs/adr/0001-zone-queue-tiebreak-policy.md for context). Deliberately standalone, no
// Node-RED/lib/ dependency — mirrors scripts/phase0-qlab-spike.js's shape/discipline so
// findings can be transcribed into test/fixtures/qlab-osc-findings.md the same way.
//
// Usage:
//   QLAB_PATCH_CUES='{"Zone 1":"201","Zone 2":"202"}' node scripts/phase-patch-qlab-spike.js
//   (each value should be a real, currently-patch-assigned Audio cue number in that zone)
//
// Optional:
//   QLAB_GROUP_CUE=<cue number>   a Group/Cart cue with per-zone children, if one exists yet
//
// Env vars (same defaults as phase0-qlab-spike.js):
//   QLAB_OSC_HOST   default 127.0.0.1
//   QLAB_OSC_PORT   default 53000
//   LOCAL_OSC_PORT  default 53002   (different from phase0's 53001 so both can coexist)
//
// Everything received is logged to stdout AND appended as JSON lines to
// test/fixtures/qlab-patch-spike-capture.jsonl.

const osc = require('osc');
const fs = require('fs');
const path = require('path');

const HOST = process.env.QLAB_OSC_HOST || '127.0.0.1';
const PORT = Number(process.env.QLAB_OSC_PORT || 53000);
const LOCAL_PORT = Number(process.env.LOCAL_OSC_PORT || 53002);
const GROUP_CUE = process.env.QLAB_GROUP_CUE || null;

let patchCues = {};
if (process.env.QLAB_PATCH_CUES) {
  try {
    patchCues = JSON.parse(process.env.QLAB_PATCH_CUES);
  } catch (err) {
    console.error(`Failed to parse QLAB_PATCH_CUES as JSON: ${err.message}`);
    process.exit(1);
  }
}

const fixturePath = path.join(__dirname, '..', 'test', 'fixtures', 'qlab-patch-spike-capture.jsonl');
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
  console.log(`\n== Patch-rework QLab OSC spike ==`);
  console.log(`Listening on 0.0.0.0:${LOCAL_PORT}, talking to QLab at ${HOST}:${PORT}`);
  console.log(`Capturing all traffic to ${fixturePath}\n`);

  console.log('--- Step 1: /thump heartbeat (liveness check) ---');
  send('/thump');
  await sleep(500);

  console.log('\n--- Step 2: workspace Audio Patch enumeration (trying candidate addresses) ---');
  send('/settings/audio/patchList');
  await sleep(300);
  send('/settings/audio/audioPatches');
  await sleep(300);

  const cueEntries = Object.entries(patchCues);
  if (cueEntries.length > 0) {
    for (const [zone, cueNumber] of cueEntries) {
      console.log(`\n--- Step 3: per-cue patch queries for ${zone}'s test cue "${cueNumber}" ---`);
      send(`/cue/${cueNumber}/patch`);
      await sleep(300);
      send(`/cue/${cueNumber}/valuesForKeys`, [{ type: 's', value: JSON.stringify(['patch', 'duration', 'uniqueID', 'type']) }]);
      await sleep(300);
      send(`/cue/${cueNumber}/levels`);
      await sleep(300);
      send(`/cue/${cueNumber}/type`);
      await sleep(300);
    }
  } else {
    console.log('\n--- Step 3 skipped: set QLAB_PATCH_CUES=\'{"Zone 1":"<cue>","Zone 2":"<cue>"}\' with real, patch-assigned cue numbers ---');
  }

  console.log('\n--- Step 4: /cueLists (confirm Group/Cart nesting shape is unchanged) ---');
  send('/cueLists');
  await sleep(500);

  if (GROUP_CUE) {
    console.log(`\n--- Step 5: Group/Cart cue "${GROUP_CUE}" queries ---`);
    send(`/cue/${GROUP_CUE}/type`);
    await sleep(300);
    send(`/cue/${GROUP_CUE}/valuesForKeys`, [{ type: 's', value: JSON.stringify(['type', 'cues']) }]);
    await sleep(300);
  } else {
    console.log('\n--- Step 5 skipped: set QLAB_GROUP_CUE=<cue number> if a multi-zone Group/Cart cue exists yet ---');
  }

  console.log(`\nCapture complete. Raw payloads saved to ${fixturePath}`);
  console.log('Review the RECV lines above, then transcribe confirmed facts into test/fixtures/qlab-osc-findings.md.');
  port.close();
  process.exit(0);
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

port.open();

#!/usr/bin/env node
// Live smoke test for the real lib/osc/* + lib/health/* classes against a running QLab
// instance - not mocks, not fixtures. Run manually: node scripts/phase2-live-smoketest.js
// (requires QLab open with OSC control permissions enabled, and a cue "101" to exist).

const { OscClient } = require('../lib/osc/oscClient');
const { QlabProtocol } = require('../lib/osc/qlabProtocol');
const { HealthMonitor } = require('../lib/health/healthMonitor');

const CUE = process.env.QLAB_CUE || '101';

async function main() {
  const client = new OscClient({ localPort: 53001, remoteAddress: '127.0.0.1', remotePort: 53000 });
  await client.open();
  const protocol = new QlabProtocol(client);

  console.log('thump():', await protocol.thump());
  console.log(`getDuration('${CUE}'):`, await protocol.getDuration(CUE));
  console.log(`getLevels('${CUE}'):`, JSON.stringify(await protocol.getLevels(CUE)));
  console.log(`getUniqueId('${CUE}'):`, await protocol.getUniqueId(CUE));

  const cues = await protocol.listCues();
  console.log(`listCues(): ${cues.length} cues found, numbers =`, cues.map((c) => c.number));

  const monitor = new HealthMonitor(protocol, client, { heartbeatIntervalMs: 2000, missThreshold: 2 });
  monitor.on('stateChange', ({ from, to }) => console.log(`healthMonitor: ${from} -> ${to}`));
  await monitor.start();
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log('healthMonitor.isArmed():', monitor.isArmed());

  console.log(`playCue('${CUE}')`);
  await protocol.playCue(CUE);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  console.log(`stopCue('${CUE}')`);
  await protocol.stopCue(CUE);

  monitor.stop();
  client.close();
  console.log('\nAll live calls completed without error.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Live smoke test FAILED:', err);
  process.exit(1);
});

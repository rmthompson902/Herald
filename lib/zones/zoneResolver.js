'use strict';

// Silence floor for QLab's OSC level values. QLab represents "-inf" (fully muted) as -60dB
// in these payloads, not a literal -Infinity — see test/fixtures/qlab-osc-findings.md.
// Using a threshold rather than an exact -60 match tolerates minor floating-point/version
// variance (real captures show values like -3.9999997170243584, not exactly -4).
const SILENCE_FLOOR_DB = -59;

/**
 * Determines which real output channels a cue's level matrix routes audible signal to.
 *
 * The matrix has two independent, cascading gain stages (confirmed against real QLab 5.6.2
 * data, see test/fixtures/qlab-osc-findings.md):
 *   - matrix[0][X]  = input channel X's own level fader (row 0 doubles as each channel's
 *                     direct gain, not a routing destination)
 *   - matrix[Y][X]  = the crosspoint routing gain from input channel X to real output
 *                     channel Y (Y >= 1)
 * Both are in dB, so they cascade: a signal only reaches output Y through input X if
 * NEITHER stage is at the silence floor. Checking the crosspoint cell alone is not
 * sufficient - an input channel muted at its own fader stays silent everywhere it's
 * routed, regardless of how "open" the crosspoint itself looks.
 *
 * The master bus (matrix[0][0]) is deliberately NOT checked as a third gate here -
 * confirmed with the project owner that it will always be left open (0dB, used only for
 * relative trim between cues), never used to fully silence a cue.
 *
 * @param {number[][]} matrix - the raw [outputChannel][inputChannel] matrix from /cue/{n}/levels
 * @returns {Set<number>} the set of real (1-indexed) output channel numbers this cue is audible on
 */
function parseLevelsMatrix(matrix) {
  const activeOutputChannels = new Set();

  for (let outCh = 1; outCh < matrix.length; outCh++) {
    const row = matrix[outCh];
    for (let inCh = 1; inCh < row.length; inCh++) {
      const inputFaderOpen = matrix[0][inCh] > SILENCE_FLOOR_DB;
      const crosspointOpen = row[inCh] > SILENCE_FLOOR_DB;
      if (inputFaderOpen && crosspointOpen) {
        activeOutputChannels.add(outCh);
        break;
      }
    }
  }

  return activeOutputChannels;
}

/**
 * Composes a live /cue/{n}/levels query with parseLevelsMatrix and the channel->zone map
 * to determine which zones a cue is actually audible in.
 *
 * @param {object} qlabProtocol - object exposing getLevels(cueNumber) -> Promise<number[][]>
 * @param {Map<number,string>} zoneMap - Dante output channel number -> zone name
 * @param {string} cueNumber
 * @returns {Promise<string[]>} deduplicated zone names, in zone-map iteration order
 */
async function resolveZonesForCue(qlabProtocol, zoneMap, cueNumber) {
  const matrix = await qlabProtocol.getLevels(cueNumber);
  const activeChannels = parseLevelsMatrix(matrix);

  const zones = new Set();
  for (const channel of activeChannels) {
    const zoneName = zoneMap.get(channel);
    if (zoneName) zones.add(zoneName);
  }

  return Array.from(zones);
}

module.exports = { parseLevelsMatrix, resolveZonesForCue, SILENCE_FLOOR_DB };

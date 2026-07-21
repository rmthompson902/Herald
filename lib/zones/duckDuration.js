'use strict';

/**
 * Plays a cue and waits out its own live-queried duration before resolving - used to make
 * duck/unduck genuinely block the surrounding message/zone-free sequence (see
 * zoneQueueEngine.js's onZoneTransition: the message cue doesn't fire until its zone's duck
 * cue resolves this way, and a zone isn't considered free again until its unduck cue does).
 * Best-effort: a failed duration query resolves immediately after the play call rather than
 * blocking forever on an unknown wait time.
 *
 * @param {object} qlabProtocol - exposes playCue(cueNumber), getDuration(cueNumber)
 * @param {string} cueNumber
 * @param {object} [options]
 * @param {(fn: Function, delayMs: number) => any} [options.setTimer] - injectable for tests
 * @returns {Promise<void>}
 */
async function playCueAndWaitForDuration(qlabProtocol, cueNumber, options = {}) {
  const setTimer = options.setTimer || ((fn, delayMs) => setTimeout(fn, delayMs));

  await Promise.resolve(qlabProtocol.playCue(cueNumber)).catch(() => {});

  let durationSeconds;
  try {
    durationSeconds = await qlabProtocol.getDuration(cueNumber);
  } catch {
    return; // can't confirm a wait time - the cue still played, just don't block on it
  }

  if (typeof durationSeconds !== 'number' || Number.isNaN(durationSeconds) || durationSeconds <= 0) return;

  await new Promise((resolve) => setTimer(resolve, durationSeconds * 1000));
}

module.exports = { playCueAndWaitForDuration };

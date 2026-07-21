'use strict';

/**
 * Plays a cue and waits out its own live-queried duration before resolving - used to make
 * duck/unduck genuinely block the surrounding message/zone-free sequence (see
 * zoneQueueEngine.js's onZoneTransition: the message cue doesn't fire until its zone's duck
 * cue resolves this way, and a zone isn't considered free again until its unduck cue does).
 * Best-effort: a failed duration query resolves immediately after the play call rather than
 * blocking forever on an unknown wait time.
 *
 * Deliberately does NOT await playCue() before starting the clock: QLab is silent on a
 * SUCCESSFUL /start (only replies on denial), so qlabProtocol.playCue() always takes its
 * full ~500ms optional-reply timeout to resolve on the normal/success path - the cue itself
 * actually starts playing near-instantly when the OSC message is sent, well before that
 * promise resolves. Blocking on it first (the original implementation) padded every
 * duck/unduck wait by that ~500ms on top of the real audio length - live-testing surfaced
 * this as an audible gap between the duck cue finishing and the message starting. Firing
 * playCue and querying getDuration concurrently, then counting the wait down from when the
 * play command was actually sent (subtracting whatever's already elapsed by the time
 * getDuration's own round trip resolves), keeps the wait matched to the real audio length.
 *
 * @param {object} qlabProtocol - exposes playCue(cueNumber), getDuration(cueNumber)
 * @param {string} cueNumber
 * @param {object} [options]
 * @param {(fn: Function, delayMs: number) => any} [options.setTimer] - injectable for tests
 * @param {() => number} [options.now] - injectable for tests
 * @returns {Promise<void>}
 */
async function playCueAndWaitForDuration(qlabProtocol, cueNumber, options = {}) {
  const setTimer = options.setTimer || ((fn, delayMs) => setTimeout(fn, delayMs));
  const now = options.now || (() => Date.now());

  const startedAt = now();
  Promise.resolve(qlabProtocol.playCue(cueNumber)).catch(() => {});

  let durationSeconds;
  try {
    durationSeconds = await qlabProtocol.getDuration(cueNumber);
  } catch {
    return; // can't confirm a wait time - the cue still played, just don't block on it
  }

  if (typeof durationSeconds !== 'number' || Number.isNaN(durationSeconds) || durationSeconds <= 0) return;

  const remainingMs = durationSeconds * 1000 - (now() - startedAt);
  if (remainingMs <= 0) return;

  await new Promise((resolve) => setTimer(resolve, remainingMs));
}

module.exports = { playCueAndWaitForDuration };

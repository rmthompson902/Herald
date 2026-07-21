'use strict';

// VOG (Voice of God): stop everything currently playing in a VOG cue's own auto-derived
// zone scope, duck that scope's background music immediately, then play the VOG cue into
// that same scope - see plan's VOG section and docs/adr/0001-zone-queue-tiebreak-policy.md
// decision 9. Anything interrupted (including still-queued, not-yet-fired entries) is
// dropped outright, never resumed.
//
// zoneQueueEngine.preemptZones() only clears the engine's own occupancy/queue bookkeeping -
// it deliberately does not touch QLab itself, so this handler is what issues the actual OSC
// stop to whatever was confirmed playing before preempting. A zone whose occupant is still
// mid-admission (reserved but not yet confirmed - see zoneQueueEngine's `confirmed` flag)
// hasn't actually been told to play yet, so there's nothing to stop there; preemptZones()
// still clears the reservation so that entry never fires into a zone VOG just silenced.
//
// Ducking here bypasses the queue engine's own batched duck-on-first-occupant logic
// entirely (see zoneQueueEngine.js) - VOG's urgency means it ducks immediately, not after
// any settle window. queueEngine.markDucked() tells the engine this zone is already ducked
// (from VOG's own direct call, not the engine's), so there's still exactly one UNDUCK
// decision path: the engine's own idle-check, once the VOG cue's own occupancy frees.

/**
 * @param {object} deps
 * @param {object} deps.qlabProtocol - exposes stopCue(cueNumber), getDuration(cueNumber), getUniqueId(cueNumber)
 * @param {(cueNumber: string) => Promise<string[]>} deps.resolveZonesForCue - live zone lookup for the VOG cue itself
 * @param {(cueNumber: string) => Promise<Object<string,number>>} deps.resolveDurationSecondsByZone -
 *   each zone's OWN discrete duration (matters if the VOG cue is ever a multi-zone Group -
 *   see zoneResolver.js)
 * @param {object} deps.queueEngine - the ZoneQueueEngine instance (getState/preemptZones/enqueue/markDucked)
 * @param {(zoneName: string) => Promise<void>} deps.duckImmediately - plays the given zone's duck cue directly, best-effort
 * @param {object} vogMessage - { id, name, qlabCueNumber }
 * @returns {Promise<{ fired: boolean, zones: string[] }>}
 */
async function triggerVog(deps, vogMessage) {
  const { qlabProtocol, resolveZonesForCue, resolveDurationSecondsByZone, queueEngine, duckImmediately } = deps;

  const zones = await resolveZonesForCue(vogMessage.qlabCueNumber);

  if (zones.length > 0) {
    const state = queueEngine.getState();
    const cueNumbersToStop = new Set();
    for (const zone of zones) {
      const occ = state.occupancy[zone];
      if (occ && occ.confirmed) {
        cueNumbersToStop.add(occ.entry.cueNumber);
      }
    }

    await Promise.all(
      Array.from(cueNumbersToStop).map((cueNumber) => Promise.resolve(qlabProtocol.stopCue(cueNumber)).catch(() => {}))
    );

    queueEngine.preemptZones(zones);

    await Promise.all(zones.map((zone) => Promise.resolve(duckImmediately(zone)).catch(() => {})));
    queueEngine.markDucked(zones);
  }

  const [durationSeconds, qlabInternalId, durationSecondsByZone] = await Promise.all([
    qlabProtocol.getDuration(vogMessage.qlabCueNumber),
    qlabProtocol.getUniqueId(vogMessage.qlabCueNumber),
    resolveDurationSecondsByZone(vogMessage.qlabCueNumber)
  ]);

  const { fired } = await queueEngine.enqueue({
    id: `vog-${vogMessage.id}-${Date.now()}`,
    cueNumber: vogMessage.qlabCueNumber,
    qlabInternalId,
    zones,
    durationSeconds,
    durationSecondsByZone,
    dueAt: Date.now(),
    name: vogMessage.name,
    source: 'vog'
  });

  return { fired, zones };
}

module.exports = { triggerVog };

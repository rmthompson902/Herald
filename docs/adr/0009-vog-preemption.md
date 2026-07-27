# ADR 0009: VOG preemption

## Status

Accepted (Phase 9); a preempt-vs-reserve race fixed later via live testing.

## Context

A VOG (Voice-of-God) trigger must stop whatever is playing in its target zones and take them over
immediately, dropping anything it interrupted rather than resuming it afterward.

## Decision

`preemptZones()` clears occupancy (confirmed or still mid-confirm) and drops every waiting entry for
the target zones outright, no requeue — consistent with VOG's "anything it interrupted is dropped
afterward, not resumed" behavior.

The engine only clears its own bookkeeping; issuing the actual OSC stop to the interrupted cue is
`vogInterruptHandler`'s job (`lib/vog/vogInterruptHandler.js`), not the queue engine's. It
live-resolves the VOG cue's own zone scope, `stopCue`s every distinct confirmed occupant across
those zones, calls `preemptZones`, then `enqueue`s the VOG cue itself through the same engine (so it
gets the same confirm-before-fire/occupancy tracking as everything else — the settle window's flat
~75ms delay is accepted here too, per the [ADR 0005](0005-same-second-tie-break-and-settle-window.md)
tradeoff).

### Amendment — a preempt-vs-reserve race (caught via live testing, not a unit-test guess)

An entry can be reserved into a zone (settle window just closed, `_tryAdvance` set its occupancy
with `confirmed: false`, its confirm-before-fire chain now running) a moment before a VOG trigger's
`preemptZones()` reclaims that same zone. The original `preemptZones` only deleted the occupancy map
entry — it didn't stop the reserved entry's own in-flight `_confirmClearAndFire` chain, which would
complete obliviously and call `_fire()` anyway, physically sending `playCue` into a zone VOG had
just claimed for its own message. Reproduced live: a play-now reserved into Zone 1 a fraction of a
second before a single-zone VOG trigger's preempt ran still fired afterward, racing the VOG cue for
the same zone.

Fixed by having `preemptZones` mark the reserved entry `_preempted = true` when clearing its
occupancy slot, and `_confirmClearAndFire` checking that flag both before waiting on anything further
and again immediately before calling `_fire` — if set, it emits `preempted_before_fire` and abandons
the fire instead. A dedicated unit test reproduces this deterministically (a controlled pending
`getIsRunningByUniqueId` promise held open while `preemptZones` runs, then resolved), since
real-world timing can't be relied on to hit this window on demand.

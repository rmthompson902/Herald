# ADR 0010: Music ducking

## Status

Accepted (post-Phase-11); revised by three amendments found via live testing.

## Context

The venue moved to one dedicated Messaging Audio Patch per zone (see
`test/fixtures/qlab-osc-findings.md`'s patch-based spike), replacing the earlier crosspoint-matrix
zone derivation, and added continuous per-zone background music that must be ducked while a message
plays.

An earlier attempt modeled ducking entirely inside QLab (a Fade cue that ducks music, then
auto-follows into the message cue) and was abandoned: it broke the fired cue's own zone/duration
signal (a Fade cue targets *another* cue's level, not its own) and broke the "the cue we fired is
the cue whose `/updates`/`isRunning` state we track" identity this whole engine is built on.

## Decision

Message cues keep their own real cue numbers and are fired directly (no change to any cue-identity
tracking). Ducking becomes two static, reusable per-zone QLab cues (`config/audio-patch-map.json`'s
`duckCueNumber`/`unduckCueNumber`), fired via the exact same `playCue()` mechanism as any other cue,
but orchestrated by this engine rather than by QLab's own follow-chain.

- **Batching, not per-message duck/unduck.** Duck fires once when a zone transitions from empty to
  occupied for the first time in a burst; unduck fires once only after that zone's queue is confirmed
  fully drained — not around every individual message, which would produce an audible
  duck/unduck/duck flicker between back-to-back queued messages in the same zone. New
  `onZoneTransition('duck'|'unduck', zone)` hook, kept deliberately separate from the existing
  `onEvent` hook: `onEvent`'s contract is explicitly passive logging (see its own JSDoc), and
  overloading it to also carry a required real OSC side effect would make ducking silently depend on
  whatever the caller happens to wire `onEvent` to — a fragile implicit coupling, not a clean
  contract.

- **Duck fires from `_tryAdvance`'s admission loop** (the one reliable chokepoint where a zone's
  occupancy actually transitions from absent to present), checked *before* the `_occupancy.set()`
  call for that zone, guarded by a `_ducked` Set for idempotency.

- **Unduck fires from `_isZoneFullyIdle`**, checked only from the two places a transition to idle
  could have just genuinely completed: `_freeZone` (after its own `_tryAdvance()` call — which, if a
  sibling was already waiting in that zone, has already re-admitted it into `_occupancy` by the time
  the idle check runs) and the settle-window's own timer callback (after *its* `_tryAdvance()` call,
  for the case where the window closes with nothing left to admit). This ordering — always let
  `_tryAdvance()` have its shot at re-admitting before checking idleness — is what actually prevents
  the flicker: a genuinely back-to-back message is never seen as "the zone went idle," because it's
  already sitting in `_occupancy` by the time anyone asks.

- **Duck and unduck genuinely block the surrounding sequence, they aren't overlapping side effects**
  (revised — see the first amendment below): the burst-starting message doesn't fire until its zone's
  duck cue is confirmed done (`onZoneTransition('duck', zone)` is awaited in `_beginAdmission`, before
  `_confirmClearAndFire` ever runs), and a zone isn't truly available for a new admission until its
  unduck cue is confirmed done either. The caller's `onZoneTransition` implementation (`lib/index.js`,
  via `lib/zones/duckDuration.js`'s `playCueAndWaitForDuration`) plays the cue and then waits out its
  own live-queried duration before resolving — the engine just awaits whatever promise it gets back,
  it has no opinion on HOW the wait is implemented.

- **Unduck is enforced via a synthetic occupancy entry, not by the caller waiting around.**
  `_maybeUnduck` reserves the zone with a placeholder occupancy record (`entry: { id: null,
  cueNumber: null, name: 'Unducking', ..., qlabInternalId: null }`) the instant it decides to unduck
  — synchronously, before awaiting anything — so nothing else can be admitted into the zone while the
  unduck cue plays, and a genuinely back-to-back new arrival just queues behind it instead of racing
  in. Once the awaited `onZoneTransition('unduck', ...)` resolves, the placeholder is removed (only
  if it's still the same one — a preempt mid-wait may have already cleared it) and `_tryAdvance()`
  runs again to pick up anything that queued during the wait. The placeholder's `qlabInternalId:
  null` deliberately never matches any real message's uniqueId, so `/updates`-push handling
  (`_isConfirmedOccupyingAnyZone`/`_confirmStopped`) correctly ignores it.

- **Modeled as a direct side-channel hook, not as queue entries admitted through the normal path.**
  Considered and rejected pushing duck/unduck through `_findReadyEntry`/the settle
  window/`qlabInternalId`-based confirm-before-fire, since none of that machinery means anything for
  a toggle-style duck/unduck cue (no meaningful "isRunning" to poll, no `dedupeKey`/stale-drop
  semantics, no real "due time"), and forcing it through anyway risked reopening the exact class of
  race this engine has already hit and fixed twice (the settle-window race — see
  [ADR 0005](0005-same-second-tie-break-and-settle-window.md) — and the `_preempted` race — see
  [ADR 0009](0009-vog-preemption.md)). A duck/unduck is a zone-lifecycle side effect the engine
  already fully knows the timing of; it doesn't need to compete for the zone.

- **`preemptZones()` does not itself trigger unduck** — by construction, since it never routes
  through `_freeZone`/the settle-window callback, the only two places `_maybeUnduck` is ever checked.
  This is intentional: VOG owns that zone's ducking state for the VOG's own duration, not the preempt
  itself.

- **VOG ducks immediately, bypassing the settle window entirely** given its existing
  urgency/preemption behavior ([ADR 0009](0009-vog-preemption.md)) — it calls a `duckImmediately(zone)`
  dep directly (the same `playCue()` mechanism, just invoked straight from `vogInterruptHandler`
  rather than through `onZoneTransition`), then calls a new `queueEngine.markDucked(zones)` so the
  engine's own `_ducked` bookkeeping reflects reality. This keeps exactly ONE unduck *decision* path
  total (the engine's own `_isZoneFullyIdle` check) while letting VOG own duck's *timing* — the
  alternative (VOG tracking its own separate idleness/unduck logic) would duplicate that check and
  risk the two paths disagreeing about whether a zone is really done.

## Amendments

### First amendment — genuine block-on-completion (found via live testing the first version)

The original implementation let the message cue start immediately/overlapping with duck (matching
what the operator initially observed and liked), and separately tried to account for the duck cue's
own live-queried duration by padding the *fallback* duration timer (`entry.durationSeconds +
duckDurationSeconds`) so the zone would stay "busy" a bit longer. Live testing immediately showed
this had **no real effect**: the zone almost always frees via the *primary* mechanism (a real
`/updates` push confirming the message cue itself stopped — see
[ADR 0002](0002-zone-free-detection.md)), which fires the instant QLab reports the message done,
entirely independent of whatever the fallback timer says. The padding only ever would have mattered
in the rare case the fallback timer is what actually frees the zone — not the common path, and not
what was wanted. Per the operator's own steer ("treat the duck like a message audio cue... the
message cue has to wait until the duck finishes AND the zone is not freed until the unduck cue
finishes"), replaced entirely with the genuine block-on-completion model described above, which
doesn't depend on guessing at durations at all — it awaits real completion the same way the
message's own confirm-before-fire already does.

Live-verified end-to-end: a real play-now on cue 1101 showed `duck_wait` at the admission moment,
then `fired` roughly 2.5s later (the real duration of Zone 1's duck cue, not an instant overlap) —
confirming the message genuinely waited. `zone_freed`/`unduck_wait` fired together once the message
ended, and a subsequent play-now correctly re-ducked and waited again once the zone was truly clear.
Also exercised via 20 deterministic unit tests across
`zoneQueueEngine.test.js`/`vogInterruptHandler.test.js`/`duckDuration.test.js` (duck genuinely blocks
the message; a rejected duck hook doesn't block firing; preemption mid-duck-wait and mid-unduck-wait
are both handled cleanly; the back-to-back-no-flicker regression still holds under the new model; a
settle-window race still ducks exactly once).

### Second amendment — per-zone duration for multi-zone Group cues (found via live testing)

A multi-zone entry (a Group cue whose children are scoped to different zones — see `zoneResolver.js`)
shares ONE `durationSeconds` across every zone it occupies, sourced from the group's own OSC-reported
duration — which QLab sets to its LONGEST child's duration, not any individual zone's. Live testing
showed this held a SHORT zone busy (and ducked) for as long as its longest sibling, and delayed
anything else queued behind it in that short zone until the whole group cleared — reproduced exactly:
both zones of a real 2-child group freed at the identical timestamp regardless of each child's real
length, and a Zone-1-only message queued behind the group wasn't fired until Zone 2 (the longer
child) also cleared.

Fixed by resolving each zone to its OWN discrete duration rather than one shared value:
`zoneResolver.js`'s traversal (shared by `resolveZonesForCue`) now also tracks, per zone, which
specific leaf cue provides it (`resolveZoneInfoForCue`), and a new `resolveDurationSecondsByZone`
queries THAT cue's own `/duration` per zone rather than the group's. The caller
(`fn_on_due`/`fn_play_now`/`vogInterruptHandler`) resolves this alongside the existing
zones/duration/uniqueId and passes it as `entry.durationSecondsByZone`; `_fire()` now computes each
zone's timer duration inside its per-zone loop (`durationSecondsByZone[zone] ?? durationSeconds ??
fallback`) instead of once, shared, outside it — a plain leaf cue is completely unaffected (falls
through to the same `durationSeconds` value either way). No change needed to the
early-`/updates`-confirm path: since a short zone's own accurate per-zone timer now always resolves
before the group's own (longer) real completion could ever confirm it, the existing "whichever comes
first" race ([ADR 0002](0002-zone-free-detection.md)) naturally does the right thing without needing
per-zone `qlabInternalId` tracking too.

Live-verified: the same 2-child group's zones now free ~2.5s apart (matching each child's real
duration), and a Zone-1-only message queued behind it fires immediately once Zone 1 alone clears —
correctly still recognized as part of the same continuous burst (no premature unduck/flicker) rather
than needing to wait for Zone 2. 5 new unit tests across `zoneResolver.test.js` (per-zone
cue-number/duration resolution, a failed per-zone query omitted rather than throwing) and
`zoneQueueEngine.test.js` (each zone of a multi-zone entry frees on its own duration; a queued
single-zone entry admits without waiting for a longer sibling zone).

### Third amendment — removing a ~500ms duck-to-message gap

The operator reported an audible ~half-second gap between a duck cue's audio actually finishing and
the message cue starting, even under the genuine block-on-completion model above. Root cause:
`qlabProtocol.playCue()` uses `requestOptionalReply` with a 500ms timeout, because QLab is silent on
a SUCCESSFUL `/cue/{n}/start` (only replies on denial) — so a successful `playCue()` call always
takes its full 500ms to resolve. `duckDuration.js`'s `playCueAndWaitForDuration` originally awaited
that 500ms call before even querying the duck cue's duration and starting the wait countdown — the
duck audio itself started playing near-instantly when the OSC message was sent, but the code didn't
start counting its duration down until ~500ms + a getDuration round trip later, padding every duck
(and unduck) wait by that amount beyond the cue's real length.

Fixed by no longer awaiting `playCue()` before querying duration: `playCue` is fired and
`getDuration` queried concurrently, and the wait is computed as the real duration minus however much
time already elapsed since the play command was actually sent (`remainingMs = durationSeconds*1000 -
(now() - startedAt)`), rather than a flat `durationSeconds*1000` added on top of both round trips. 2
new unit tests in `duckDuration.test.js` (a slow-resolving `playCue` doesn't pad the wait; a slow
`getDuration` round trip that already exceeds the real duration resolves immediately with no extra
wait). All 146 unit tests pass. Live-verified against the real running instance: the
duck_wait-to-fired gap for cue 1101/Zone 1 dropped from a consistent ~2.508s (multiple pre-fix
samples) to a consistent ~2.004s (multiple post-fix samples) — a ~504ms reduction, matching the
removed 500ms tax almost exactly.

# ADR 0001: Zone Queue Tie-Break Policy

## Status

Accepted (Phase 8).

## Context

Collision handling is queue-and-wait, per zone (see `docs/claude-plan.md`'s Confirmed
Decisions) - never skip, never overlap. `lib/queue/zoneQueueEngine.js` implements this as an
in-memory, per-zone FIFO. This ADR records the tie-break/edge-case rules that aren't
self-evident from "queue and wait," plus the multi-zone admission rule the plan didn't spell
out.

## Decisions

1. One FIFO wait queue per zone, ordered by due time (see decision 5 for the tie-break).
2. A zone frees via whichever comes first: a live `/updates` push confirming the occupying
   cue actually stopped (`qlabProtocol.getIsRunningByUniqueId`, keyed by QLab's internal
   uniqueID - see `test/fixtures/qlab-osc-findings.md`), or a duration-based fallback timer
   (`cue_cache`'s live-refreshed `durationSeconds`, falling back to 30s if unknown). The
   fallback timer is the safety net for a missed/ignored `/updates` push, not the primary
   mechanism.
   - **A fourth way, added during the Phase 11 edge-case audit**: an immediate free if the
     real OSC `/start` itself came back denied or otherwise failed (e.g. OSC control
     permissions toggled off mid-session, or the cue was deleted/renamed in QLab between the
     `cue_cache` refresh and this fire - a narrower race than "any bad cue number," since a
     wholly nonexistent cue number fails `refreshCueCache` earlier and never reaches
     `enqueue()` at all). Before this fix, `_fire()` claimed occupancy for the cue's full
     assumed duration *before* even calling `playCue()`, and a rejection only logged an
     `error` event - nothing freed the zone, so a denied start still held it hostage for the
     rest of that window (bounded, never forever, but wasted: up to the 30s fallback, or the
     cue's real cached duration otherwise) for a cue that never made a sound. Fixed by
     freeing every one of the entry's zones immediately in the `playCue()` rejection handler,
     tagged with a distinct `start_failed_zone_freed` event (rather than the normal
     `zone_freed`) so the event log/history page can tell "burned its slot without playing"
     apart from a normal completed playback.
3. **Always confirm live before actually firing, never trust the timer alone** (added after
   a real bug: a schedule fire followed shortly by a play-now on the *same* cue - a very
   common real operator action - resulted in the queued play-now never audibly playing a
   second time). Root cause: `cue_cache`'s cached duration can be a hair shorter than QLab's
   true wall-clock playback (fade tails, rounding), so the fallback timer could fire and
   trigger a retrigger of the same cue number *while QLab was still finishing the previous
   instance* - which QLab appears to silently ignore (no denial, no error, just no second
   audible play - confirmed by isolated OSC spike testing against the real workspace). Fix:
   before ever sending the real OSC `/start`, the engine always live-queries
   `getIsRunningByUniqueId` for the candidate's own cue and only fires once it comes back
   false, retrying every ~150ms up to ~20 attempts (~3s) if it's still reported running, and
   firing anyway past that cap as a last-resort safety net (a persistently-looping cue
   shouldn't block a safety message forever - see decision on "never skip" below). This
   applies uniformly to every admission, not just retriggers of the same cue, since it's
   cheap (one query) and removes an entire class of bookkeeping-vs-reality drift (e.g. after
   a restart, or a cue started manually in QLab outside this system).
4. ~~**Multi-zone admission**: a cue occupying more than one zone (e.g. a VOG message scoped
   to "all zones") only fires once it is simultaneously free to enter *every* one of its
   target zones - i.e. every target zone is unoccupied. A multi-zone entry can therefore be
   held behind an unrelated single-zone entry that's ready to go first in one of its zones -
   this is intentional ("wait your turn in every zone you need"), not a bug, and is the main
   reason the engine is not simply N independent per-zone FIFOs.~~ **Superseded - see the
   amendment below.** (Sub-bullet kept as history: the original "must be at every zone's
   queue front" bug and its `_findReadyEntry` scan-past-not-ready fix, both since removed
   along with the multi-zone-entry concept itself.)
   - **The reverse must NOT hold, and originally did (a real bug)**: admission required an
     entry to be literally at index 0 - the front - of *every* one of its zones' queue
     arrays. A multi-zone entry sitting at the front of one zone's queue while blocked by a
     *different*, busy zone therefore head-of-line-blocked every single-zone entry behind it
     in that first zone's queue, even ones that had nothing to do with whichever zone it was
     actually stuck on. Caught from a real report: a cue routed to Zone 1+2 sorted ahead of a
     Zone-2-only cue in Zone 2's queue purely because its cue number was lower, and the
     Zone-2-only cue - whose own zone was completely free the whole time - was stuck waiting
     for the Zone 1+2 cue to become admittable on *both* zones before it ever got a turn.
     Fixed (at the time) in `_findReadyEntry` by scanning each free zone's queue for the
     first entry whose *every* zone is currently free, rather than requiring literal
     front-of-queue position in each one.
   - **Amendment - decomposed into genuinely N independent per-zone FIFOs (post-Phase-12,
     driven by a real operator report)**: triggering a multi-zone Group cue (e.g. cue 9900,
     Zone 1 + Zone 2 children of different lengths) while single-zone messages were already
     independently playing in both of its target zones caused it to wait for the *slower* of
     the two before starting at all. Reproduced live: firing cue 1102 (Zone 1) and 2102
     (Zone 2) concurrently, then triggering 9900 while both were still playing, showed 9900
     waiting for whichever of the two took longer - correct *given* the old admission rule
     above, but the operator's explicit direction was that the rule itself was wrong: "the
     schedule start time... has nothing to do with playout time given the FIFO queue
     design... when the multi-zone cue is triggered, and audio is already playing in the
     zones it targets, those [zone-specific tracks] get added to the zones' FIFO queues, and
     the tracks can play immediately when the existing audio in that zone is done." The
     operator also flagged that this engine had been amended piecemeal several times
     (decisions 5, 9, 10 and their own amendments) and asked for one uniform pass rather than
     another incremental patch.

     Fixed by removing the multi-zone-entry concept from the engine entirely:
     `enqueue()` now decomposes any cue spanning N zones into N independent per-zone
     sub-entries at enqueue time - each carrying that zone's OWN specific child cue number,
     duration, and QLab internal uniqueId (`zoneResolver.resolveZoneDetailsForCue`,
     replacing the separate `resolveZonesForCue`/`resolveDurationSecondsByZone` that each
     re-walked the cue tree on their own). Each sub-entry lives in *only* its own zone's
     queue and is admitted, ducked, confirmed, fired, and freed entirely independently -
     firing the zone's own child cue directly (e.g. `/cue/990101/start` for Zone 1) rather
     than the parent group's number. This is the literal, structural meaning of "N
     independent per-zone FIFOs" that decision 4's original text explicitly said the engine
     was NOT - it now is, for every trigger type (schedule fire, play-now, VOG) and every
     zone count uniformly, since a single-zone entry is simply the N=1 case of the exact same
     decomposition path, not a separate code path. `_findReadyEntry`'s cross-zone
     scan-past-not-ready machinery (the fix described just above) is removed entirely, since
     the head-of-line-blocking problem it solved is now structurally impossible - no entry
     ever needs more than one zone, so there is no cross-zone readiness to check; each zone's
     front-of-queue entry is simply admitted once that zone is free.

     `vogInterruptHandler.js`'s zone-occupancy stop-dedup logic needed no change - it already
     deduped by `cueNumber` value, not entry identity, so it continues to work correctly (and
     more accurately: each zone's occupant now genuinely carries its own real leaf cue number
     instead of always the parent group's).

     Tests: removed the two tests directly encoding the old "every zone must be free, front
     of every queue" rule (`only admits a multi-zone entry once every one of its zones is
     free...`, `does not head-of-line-block a single-zone entry behind an unrelated
     multi-zone entry...` - the scenario the second one guarded against became structurally
     impossible). Added tests confirming each zone of a multi-zone entry admits/fires
     independently of the other, including a direct reproduction of the operator's exact
     report (two unrelated single-zone occupants of different durations already playing in
     a multi-zone entry's target zones; each zone's portion fires the instant that zone
     alone frees). All 148 unit tests pass. Live-verified with the exact reproduction that
     surfaced the bug: cue 1102 (Zone 1) and 2102 (Zone 2) fired concurrently, then cue 9900
     triggered 2s later while both were still playing - the event log shows 9900 decomposed
     into `9901` (Zone 1's own child) and `9902` (Zone 2's own child), with 9901 firing the
     instant Zone 1's occupant (1102) cleared and 9902 firing independently ~4.7s later, the
     instant Zone 2's occupant (2102) cleared - neither waited on the other.
5. **Same-second collision tie-break: cue number ascending, backed by a short admission
   settle window** (changed from the original "exact ties broken by schedule id" - in
   practice that meant whichever cron-plus job happened to be processed first internally,
   not anything an operator could reason about or control, and a real report from the user
   showed it consistently favoring the *wrong* cue). Two entries due within the same
   wall-clock second (`Math.floor(dueAt / 1000)` equal, not requiring exact-millisecond
   equality) are ordered by cue number ascending - lower cue number plays first. **This
   alone was not sufficient and shipped as a real (caught-in-production) bug**: two
   schedules "due at the same moment" don't actually reach `enqueue()` in the same instant -
   cron-plus dispatches them a few ms apart - so whichever arrived first into a free zone
   was admitted immediately, before the other one even existed to be compared against.
   Fixed by having admission into a newly-free zone always wait out a short settle window
   (`admissionSettleMs`, default 75ms) before picking a winner, so a near-simultaneous
   sibling has a chance to arrive and be sorted in first. This adds a small fixed delay to
   *every* fire through this zone, not just contested ones (there's no way to know in
   advance whether a collision is imminent) - accepted as negligible for both routine
   announcements and future VOG triggers (Phase 9) given cue playback durations are
   measured in seconds. Entries due in different seconds are unaffected and still order
   strictly by due time regardless of cue number; none of this affects genuinely single-zone,
   uncontested fires beyond the flat settle delay.
6. **Stale-drop, schedule fires only**: if a recurring schedule's next occurrence comes due
   while a prior instance of that *same schedule* is still waiting (not yet fired) in a
   zone's queue, the stale waiting entry is dropped and replaced by the new one. This is
   keyed on an explicit `dedupeKey` set only on schedule-fired entries (e.g.
   `schedule-{id}`) - play-now and VOG entries never carry one, so they never stale-drop
   anything and are never stale-dropped themselves. An entry already *occupying* a zone
   (already fired, or reserved and mid-confirm) is never preempted by stale-drop, only
   *waiting* entries are.
7. **Overflow cap**: 5 waiting entries per zone. Beyond that, the oldest (front-of-queue)
   waiting entry is dropped and logged - a safety net against a stuck/unresponsive QLab
   letting a zone's queue grow unbounded, not a normal-operation path. Dropping the oldest
   (rather than refusing the newest) reflects that if the cap is being hit at all, the front
   entry has likely been waiting on a QLab that isn't confirming completions; give up on it
   rather than blocking everything behind it indefinitely.
8. **Play-now** submits through this exact same engine and queue, never bypassing it - a UI
   convenience button isn't allowed to be the one thing that can overlap audio. It reports
   `queued: true` back to the operator (surfaced as a toast) if it doesn't fire immediately -
   and if the eventual real fire happens well after that response went out, the recent-events
   ring buffer (`getRecentEvents`) lets the webapp notice and send a follow-up notification
   rather than the operator never learning whether the queued message actually played.
9. **VOG preemption** (Phase 9): `preemptZones()` clears occupancy (confirmed or still
   mid-confirm) and drops every waiting entry for the target zones outright, no requeue -
   consistent with VOG's "anything it interrupted is dropped afterward, not resumed"
   behavior from the plan. The engine only clears its own bookkeeping; issuing the actual
   OSC stop to the interrupted cue is `vogInterruptHandler`'s job (`lib/vog/vogInterruptHandler.js`),
   not the queue engine's - it live-resolves the VOG cue's own zone scope, `stopCue`s every
   distinct confirmed occupant across those zones, calls `preemptZones`, then `enqueue`s the
   VOG cue itself through the same engine (so it gets the same confirm-before-fire/occupancy
   tracking as everything else - the settle-window's flat ~75ms delay is accepted here too,
   per the original decision 5 tradeoff).
   - **A real race caught via live testing, not a unit test guess**: an entry can be
     reserved into a zone (settle window just closed, `_tryAdvance` set its occupancy with
     `confirmed: false`, its confirm-before-fire chain now running) a moment before a VOG
     trigger's `preemptZones()` reclaims that same zone. The original `preemptZones` only
     deleted the occupancy map entry - it didn't stop the reserved entry's own in-flight
     `_confirmClearAndFire` chain, which would complete obliviously and call `_fire()`
     anyway, physically sending `playCue` into a zone VOG had just claimed for its own
     message. Reproduced live: a play-now reserved into Zone 1 a fraction of a second before
     a single-zone VOG trigger's preempt ran still fired afterward, racing the VOG cue for
     the same zone. Fixed by having `preemptZones` mark the reserved entry `_preempted =
     true` when clearing its occupancy slot, and `_confirmClearAndFire` checking that flag
     both before waiting on anything further and again immediately before calling `_fire` -
     if set, it emits `preempted_before_fire` and abandons the fire instead. A dedicated
     unit test reproduces this deterministically (a controlled pending
     `getIsRunningByUniqueId` promise held open while `preemptZones` runs, then resolved),
     since real-world timing can't be relied on to hit this window on demand.

10. **Music ducking (post-Phase-11 rework)**: the venue moved to one dedicated Messaging
    Audio Patch per zone (see `test/fixtures/qlab-osc-findings.md`'s patch-based spike),
    replacing the earlier crosspoint-matrix zone derivation, and added continuous
    per-zone background music that must be ducked while a message plays. An earlier
    attempt modeled ducking entirely inside QLab (a Fade cue that ducks music, then
    auto-follows into the message cue) and was abandoned: it broke the fired cue's own
    zone/duration signal (a Fade cue targets *another* cue's level, not its own) and broke
    the "the cue we fired is the cue whose `/updates`/`isRunning` state we track" identity
    this whole engine is built on. Settled instead on: message cues keep their own real
    cue numbers and are fired directly (no change to any cue-identity tracking above);
    ducking becomes two static, reusable per-zone QLab cues (`config/audio-patch-map.json`'s
    `duckCueNumber`/`unduckCueNumber`), fired via the exact same `playCue()` mechanism as
    any other cue, but orchestrated by this engine rather than by QLab's own follow-chain.
    - **Batching, not per-message duck/unduck**: duck fires once when a zone transitions
      from empty to occupied for the first time in a burst; unduck fires once only after
      that zone's queue is confirmed fully drained - not around every individual message,
      which would produce an audible duck/unduck/duck flicker between back-to-back queued
      messages in the same zone. New `onZoneTransition('duck'|'unduck', zone)` hook, kept
      deliberately separate from the existing `onEvent` hook: `onEvent`'s contract is
      explicitly passive logging (see its own JSDoc), and overloading it to also carry a
      required real OSC side effect would make ducking silently depend on whatever the
      caller happens to wire `onEvent` to - a fragile implicit coupling, not a clean
      contract.
    - **Duck fires from `_tryAdvance`'s admission loop** (the one reliable chokepoint where
      a zone's occupancy actually transitions from absent to present), checked *before* the
      `_occupancy.set()` call for that zone, guarded by a `_ducked` Set for idempotency.
    - **Unduck fires from `_isZoneFullyIdle`**, checked only from the two places a
      transition to idle could have just genuinely completed: `_freeZone` (after its own
      `_tryAdvance()` call - which, if a sibling was already waiting in that zone, has
      already re-admitted it into `_occupancy` by the time the idle check runs) and the
      settle-window's own timer callback (after *its* `_tryAdvance()` call, for the case
      where the window closes with nothing left to admit). This ordering - always let
      `_tryAdvance()` have its shot at re-admitting before checking idleness - is what
      actually prevents the flicker: a genuinely back-to-back message is never seen as "the
      zone went idle," because it's already sitting in `_occupancy` by the time anyone asks.
    - **Duck and unduck genuinely block the surrounding sequence, they aren't overlapping
      side effects** (revised after live testing - see the amendment below): the
      burst-starting message doesn't fire until its zone's duck cue is confirmed done
      (`onZoneTransition('duck', zone)` is awaited in `_beginAdmission`, before
      `_confirmClearAndFire` ever runs), and a zone isn't truly available for a new
      admission until its unduck cue is confirmed done either. The caller's
      `onZoneTransition` implementation (`lib/index.js`, via
      `lib/zones/duckDuration.js`'s `playCueAndWaitForDuration`) plays the cue and then
      waits out its own live-queried duration before resolving - the engine just awaits
      whatever promise it gets back, it has no opinion on HOW the wait is implemented.
    - **Unduck is enforced via a synthetic occupancy entry, not by the caller waiting
      around**: `_maybeUnduck` reserves the zone with a placeholder occupancy record
      (`entry: { id: null, cueNumber: null, name: 'Unducking', ..., qlabInternalId: null }`)
      the instant it decides to unduck - synchronously, before awaiting anything - so
      nothing else can be admitted into the zone while the unduck cue plays, and a
      genuinely back-to-back new arrival just queues behind it instead of racing in. Once
      the awaited `onZoneTransition('unduck', ...)` resolves, the placeholder is removed
      (only if it's still the same one - a preempt mid-wait may have already cleared it)
      and `_tryAdvance()` runs again to pick up anything that queued during the wait. The
      placeholder's `qlabInternalId: null` deliberately never matches any real message's
      uniqueId, so `/updates`-push handling (`_isConfirmedOccupyingAnyZone`/`_confirmStopped`)
      correctly ignores it.
    - **Modeled as a direct side-channel hook, not as queue entries admitted through the
      normal path** - considered and rejected pushing duck/unduck through
      `_findReadyEntry`/the settle window/`qlabInternalId`-based confirm-before-fire, since
      none of that machinery means anything for a toggle-style duck/unduck cue (no
      meaningful "isRunning" to poll, no `dedupeKey`/stale-drop semantics, no real "due
      time"), and forcing it through anyway risked reopening the exact class of race this
      engine has already hit and fixed twice (the settle-window race, the `_preempted`
      race - see decisions 5 and 9). A duck/unduck is a zone-lifecycle side effect the
      engine already fully knows the timing of; it doesn't need to compete for the zone.
    - **`preemptZones()` does not itself trigger unduck** - by construction, since it never
      routes through `_freeZone`/the settle-window callback, the only two places `_maybeUnduck`
      is ever checked. This is intentional: VOG owns that zone's ducking state for the
      VOG's own duration (see below), not the preempt itself.
    - **VOG ducks immediately, bypassing the settle window entirely** given its existing
      urgency/preemption behavior (decision 9) - it calls a `duckImmediately(zone)` dep
      directly (the same `playCue()` mechanism, just invoked straight from
      `vogInterruptHandler` rather than through `onZoneTransition`), then calls a new
      `queueEngine.markDucked(zones)` so the engine's own `_ducked` bookkeeping reflects
      reality. This keeps exactly ONE unduck *decision* path total (the engine's own
      `_isZoneFullyIdle` check) while letting VOG own duck's *timing* - the alternative
      (VOG tracking its own separate idleness/unduck logic) would duplicate that check
      and risk the two paths disagreeing about whether a zone is really done.
    - **Amendment, found via live testing the very first version of this feature**: the
      original implementation let the message cue start immediately/overlapping with duck
      (matching what the operator initially observed and liked), and separately tried to
      account for the duck cue's own live-queried duration by padding the *fallback*
      duration timer (`entry.durationSeconds + duckDurationSeconds`) so the zone would stay
      "busy" a bit longer. Live testing immediately showed this had **no real effect**: the
      zone almost always frees via the *primary* mechanism (a real `/updates` push
      confirming the message cue itself stopped - decision 2), which fires the instant QLab
      reports the message done, entirely independent of whatever the fallback timer says.
      The padding only ever would have mattered in the rare case the fallback timer is what
      actually frees the zone - not the common path, and not what was actually wanted. Per
      the operator's own explicit steer ("treat the duck like a message audio cue... the
      message cue has to wait until the duck finishes AND the zone is not freed until the
      unduck cue finishes"), replaced entirely with the genuine block-on-completion model
      described above, which doesn't depend on guessing at durations at all - it awaits
      real completion the same way the message's own confirm-before-fire already does.
    - Live-verified end-to-end after the amendment: a real play-now on cue 1101 showed
      `duck_wait` at the admission moment, then `fired` roughly 2.5s later (the real
      duration of Zone 1's duck cue, not an instant overlap) - confirming the message
      genuinely waited. `zone_freed`/`unduck_wait` fired together once the message ended,
      and a subsequent play-now correctly re-ducked and waited again once the zone was
      truly clear. Also exercised via 20 deterministic unit tests across
      `zoneQueueEngine.test.js`/`vogInterruptHandler.test.js`/`duckDuration.test.js` (duck
      genuinely blocks the message; a rejected duck hook doesn't block firing;
      preemption mid-duck-wait and mid-unduck-wait are both handled cleanly; the
      back-to-back-no-flicker regression still holds under the new model; a settle-window
      race still ducks exactly once).
    - **Second amendment, again found via live testing (the multi-zone Group case)**: a
      multi-zone entry (a Group cue whose children are scoped to different zones - see
      `zoneResolver.js`) shares ONE `durationSeconds` across every zone it occupies, sourced
      from the group's own OSC-reported duration - which QLab sets to its LONGEST child's
      duration, not any individual zone's. Live testing showed this held a SHORT zone busy
      (and ducked) for as long as its longest sibling, and delayed anything else queued
      behind it in that short zone until the whole group cleared - reproduced exactly: both
      zones of a real 2-child group freed at the identical timestamp regardless of each
      child's real length, and a Zone-1-only message queued behind the group wasn't fired
      until Zone 2 (the longer child) also cleared. Fixed by resolving each zone to its OWN
      discrete duration rather than one shared value: `zoneResolver.js`'s traversal (shared
      by `resolveZonesForCue`) now also tracks, per zone, which specific leaf cue provides
      it (`resolveZoneInfoForCue`), and a new `resolveDurationSecondsByZone` queries THAT
      cue's own `/duration` per zone rather than the group's. The caller (`fn_on_due`/
      `fn_play_now`/`vogInterruptHandler`) resolves this alongside the existing zones/
      duration/uniqueId and passes it as `entry.durationSecondsByZone`; `_fire()` now
      computes each zone's timer duration inside its per-zone loop (`durationSecondsByZone[zone]
      ?? durationSeconds ?? fallback`) instead of once, shared, outside it - a plain leaf
      cue is completely unaffected (falls through to the same `durationSeconds` value either
      way). No change needed to the early-`/updates`-confirm path: since a short zone's own
      accurate per-zone timer now always resolves before the group's own (longer) real
      completion could ever confirm it, the existing "whichever comes first" race (decision
      2) naturally does the right thing without needing per-zone `qlabInternalId` tracking
      too. Live-verified: the same 2-child group's zones now free ~2.5s apart (matching each
      child's real duration), and a Zone-1-only message queued behind it fires immediately
      once Zone 1 alone clears - correctly still recognized as part of the same continuous
      burst (no premature unduck/flicker) rather than needing to wait for Zone 2. 5 new unit
      tests across `zoneResolver.test.js` (per-zone cue-number/duration resolution, a failed
      per-zone query omitted rather than throwing) and `zoneQueueEngine.test.js` (each zone
      of a multi-zone entry frees on its own duration; a queued single-zone entry admits
      without waiting for a longer sibling zone).
    - **Third amendment**: the operator reported an audible ~half-second gap between a duck
      cue's audio actually finishing and the message cue starting, even under the genuine
      block-on-completion model above. Root cause: `qlabProtocol.playCue()` uses
      `requestOptionalReply` with a 500ms timeout, because QLab is silent on a SUCCESSFUL
      `/cue/{n}/start` (only replies on denial) - so a successful `playCue()` call always
      takes its full 500ms to resolve. `duckDuration.js`'s `playCueAndWaitForDuration`
      originally awaited that 500ms call before even querying the duck cue's duration and
      starting the wait countdown - the duck audio itself started playing near-instantly
      when the OSC message was sent, but the code didn't start counting its duration down
      until ~500ms + a getDuration round trip later, padding every duck (and unduck) wait by
      that amount beyond the cue's real length. Fixed by no longer awaiting `playCue()`
      before querying duration: `playCue` is fired and `getDuration` queried concurrently,
      and the wait is computed as the real duration minus however much time already elapsed
      since the play command was actually sent (`remainingMs = durationSeconds*1000 -
      (now() - startedAt)`), rather than a flat `durationSeconds*1000` added on top of both
      round trips. 2 new unit tests in `duckDuration.test.js` (a slow-resolving `playCue`
      doesn't pad the wait; a slow `getDuration` round trip that already exceeds the real
      duration resolves immediately with no extra wait). All 146 unit tests pass.
      Live-verified against the real running instance: the duck_wait-to-fired gap for cue
      1101/Zone 1 dropped from a consistent ~2.508s (multiple pre-fix samples) to a
      consistent ~2.004s (multiple post-fix samples) - a ~504ms reduction, matching the
      removed 500ms tax almost exactly.

11. **Critical bug: concurrently-due schedules beyond the first were silently dropped (or,
    for play-now, hung the HTTP response forever)** - reported by the operator after every
    schedule was deliberately aligned to the same trigger moment: only one message fired;
    the rest never appeared in the queue at all. Root cause was unrelated to ducking or to
    decision 10's genuine block-on-completion model - it was in `resolveDurationSecondsByZone`
    (`zoneResolver.js`, added by decision 10's second amendment for per-zone Group duration),
    called directly and *without any error handling* by `fn_on_due`/`fn_play_now`/
    `vogInterruptHandler`. Its first step re-fetches the whole cue tree via
    `qlabProtocol.getCueLists()` - a query with no cue-number-specific address, so every
    concurrently-firing schedule issues an identical-address OSC query at once. Live-tested
    (5 concurrent play-now calls, mirroring the reported alignment): QLab answers only ONE of
    several simultaneous identical-address queries; the rest sit unanswered until the
    client's own 3000ms timeout fires and rejects with "OSC request timed out waiting for
    /reply/cueLists". `refreshCueCache` already wraps its own equivalent query in a
    try/catch (degrading gracefully to a skip-with-warning), but the later, separate
    `resolveDurationSecondsByZone` call was not wrapped anywhere - the rejection propagated
    uncaught out of `fn_on_due`'s async handler (silently dropping that schedule's fire
    before `enqueue()` is ever called - no `queued` event, nothing) or out of `fn_play_now`'s
    (Node-RED logs the rejection internally but never sends an HTTP response, so the request
    hangs indefinitely - reproduced live: `curl` hung past 2+ minutes on 4 of 5 concurrent
    play-now calls, confirmed via Node-RED's own log showing
    `[function:play-now (via zoneQueueEngine)] Error: OSC request timed out waiting for
    /reply/cueLists` for each dropped one). Fixed at the single source rather than patching
    every call site: `resolveDurationSecondsByZone` now catches a failure of the initial
    tree-fetch/zone-resolution step and returns `{}` - exactly the same best-effort tolerance
    it already had for a single per-zone duration query failing, just extended to cover the
    whole-cue resolution failing too. This is safe specifically because the function's
    return value is only ever an *optional per-zone duration override* on top of an entry's
    already-resolved `zones`/`durationSeconds` (from `refreshCueCache`, which independently
    and correctly still skips/warns on ITS OWN resolution failure) - a caller getting `{}`
    back just falls through to the entry's shared `durationSeconds`, i.e. the exact
    pre-decision-10-second-amendment behavior, never a dropped or duplicated fire. Extending
    the same tolerance to `resolveZonesForCue`/`resolveZoneInfoForCue` themselves was
    deliberately ruled out - those functions' output determines real zone-safety, and
    silently returning empty zones on a transient OSC failure would make a genuinely-failed
    resolution indistinguishable from a legitimately zero-zone (unrouted) cue, which fires
    immediately with no collision protection at all. 1 new unit test in
    `zoneResolver.test.js`. All 147 unit tests pass. Live-verified: restarted Node-RED,
    re-ran the exact 5-concurrent-play-now reproduction - all 5 returned real HTTP 200s
    (no hangs), all 5 logged `queued`, and all 5 fired/freed cleanly in FIFO order over the
    following ~45s with no drops.
    - **Follow-up, found immediately by the operator's own further testing**: with decision
      11's fix in place (losers of the `/cueLists` race degrade gracefully instead of
      hanging), the operator noticed a DIFFERENT symptom when two schedules in two
      completely unrelated, independent zones aligned (e.g. Zone 1's cue 1101 and Zone 2's
      cue 2101): Zone 1 ducked and started its message, and only once Zone 1's message was
      already playing did Zone 2 even start ducking - despite the two zones having nothing
      to do with each other. Root cause, confirmed via exact log timestamps: "gracefully
      degrading instead of hanging" still means the losing schedule's `resolveDurationSecondsByZone`
      call burns the FULL 3000ms OSC request timeout before it resolves (to `{}`) and lets
      that schedule's fire proceed - one schedule got queued immediately (won the race),
      the other three/four all got queued ~3.0s later, confirmed via the `queued` event
      timestamps in `logs/events-*.log`. Since a duck cue's own real duration (~2s) is
      shorter than that 3s penalty, the "losing" zone's whole duck+fire cycle hadn't even
      STARTED by the time the "winning" zone's message was already playing - reading as
      "Zone 2 waits for Zone 1", when what was actually happening was "Zone 2's admission
      is stuck waiting out an OSC timeout that has nothing to do with Zone 1 at all."
      Fixed the actual race rather than continuing to degrade after losing it:
      `qlabProtocol.js`'s `getCueLists()` now de-dupes concurrent in-flight calls into a
      single shared OSC round trip - `/cueLists` is a single, cue-number-agnostic address
      that every zone/duration resolution needs regardless of which specific cue it's after,
      so every concurrent caller within the same in-flight window gets the exact same real
      tree back from ONE query instead of each issuing (and mostly losing) their own. This
      eliminates the race entirely rather than just softening its failure mode - correct
      because the tree contents are identical for every caller in that instant, nothing
      about `/cueLists` is per-cue. 3 new unit tests in `qlabProtocol.test.js` (concurrent
      calls share one request; a call starting after the previous one already resolved gets
      its own fresh request; a call starting after a prior one REJECTED also gets its own
      fresh request, not permanently stuck sharing a failure). All 150 unit tests pass.
      Live-verified: restarted Node-RED, re-ran the exact two-independent-zone reproduction
      (cues 1101/Zone 1 and 2101/Zone 2 via concurrent play-now) - both `queued` within 1ms
      of each other, both `duck_wait` within 1ms of each other, both `fired` within 4ms of
      each other; re-ran the full 5-concurrent-schedule reproduction from decision 11 as
      well - all 5 `queued` within 2ms of each other now (previously one immediate + four
      ~3.0s later), all still fire/free cleanly with no drops.

## Consequences

- The engine is in-memory only, by design - a restart drops all occupancy/queue state
  cleanly, consistent with cron-plus jobs being fully rebuilt from `schedules` on boot rather
  than resuming any in-flight queue (see plan: "losing in-flight queue state on restart is
  correct given the skip, don't replay principle").
- A pathological case remains theoretically possible: two entries permanently blocking each
  other by both waiting on the other's zone first (e.g. entry A wants zones [1,2] and is
  front of zone 1's queue behind nothing, entry B wants zones [2,1] and is front of zone 2's
  queue). In practice this can't arise from real schedules/VOG messages, since admission
  order within a zone is always due-time FIFO and zone membership per cue is static - noted
  here rather than defended against in code.

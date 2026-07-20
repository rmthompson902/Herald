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
4. **Multi-zone admission**: a cue occupying more than one zone (e.g. a VOG message scoped
   to "all zones") only fires once it is simultaneously free to enter *every* one of its
   target zones - i.e. every target zone is unoccupied. A multi-zone entry can therefore be
   held behind an unrelated single-zone entry that's ready to go first in one of its zones -
   this is intentional ("wait your turn in every zone you need"), not a bug, and is the main
   reason the engine is not simply N independent per-zone FIFOs.
   - **The reverse must NOT hold, and originally did (a real bug)**: admission required an
     entry to be literally at index 0 - the front - of *every* one of its zones' queue
     arrays. A multi-zone entry sitting at the front of one zone's queue while blocked by a
     *different*, busy zone therefore head-of-line-blocked every single-zone entry behind it
     in that first zone's queue, even ones that had nothing to do with whichever zone it was
     actually stuck on. Caught from a real report: a cue routed to Zone 1+2 sorted ahead of a
     Zone-2-only cue in Zone 2's queue purely because its cue number was lower, and the
     Zone-2-only cue - whose own zone was completely free the whole time - was stuck waiting
     for the Zone 1+2 cue to become admittable on *both* zones before it ever got a turn.
     Fixed in `_findReadyEntry` by scanning each free zone's queue for the first entry whose
     *every* zone is currently free, rather than requiring literal front-of-queue position in
     each one - this still preserves FIFO/cue-number order among entries genuinely competing
     for the same zone (the first ready entry in sorted order is always returned), it just no
     longer lets an entry that can't actually proceed yet block ones behind it that could.
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
   OSC stop to the interrupted cue is `vogInterruptHandler`'s job, not the queue engine's.

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

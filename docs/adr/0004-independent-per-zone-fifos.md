# ADR 0004: Independent per-zone FIFOs

## Status

Accepted (post-Phase-12). **Supersedes** the original multi-zone admission rule (below).

## Context

The original design treated a cue spanning several zones as a single **multi-zone entry**, and the
admission rule around it went through two bugs before being replaced wholesale. This record captures
the current model and keeps the superseded rule as history.

### Superseded — the original multi-zone admission rule

> A cue occupying more than one zone (e.g. a VOG message scoped to "all zones") only fires once it
> is simultaneously free to enter *every* one of its target zones. A multi-zone entry can therefore
> be held behind an unrelated single-zone entry that's ready to go first in one of its zones — "wait
> your turn in every zone you need."

- **A head-of-line-blocking bug (fixed at the time, since removed):** admission required an entry to
  be literally at index 0 — the front — of *every* one of its zones' queue arrays. A multi-zone
  entry sitting at the front of one zone's queue while blocked by a *different*, busy zone
  head-of-line-blocked every single-zone entry behind it in that first zone's queue, even ones with
  nothing to do with whichever zone it was actually stuck on. Caught from a real report: a cue routed
  to Zone 1+2 sorted ahead of a Zone-2-only cue in Zone 2's queue purely because its cue number was
  lower, and the Zone-2-only cue — whose own zone was completely free the whole time — was stuck
  waiting for the Zone 1+2 cue to become admittable on *both* zones. Fixed at the time in
  `_findReadyEntry` by scanning each free zone's queue for the first entry whose *every* zone is
  currently free, rather than requiring literal front-of-queue position in each one.

## Decision

**Decompose into genuinely N independent per-zone FIFOs** (post-Phase-12, driven by a real operator
report): triggering a multi-zone Group cue (e.g. cue 9900, Zone 1 + Zone 2 children of different
lengths) while single-zone messages were already independently playing in both of its target zones
caused it to wait for the *slower* of the two before starting at all. Reproduced live: firing cue
1102 (Zone 1) and 2102 (Zone 2) concurrently, then triggering 9900 while both were still playing,
showed 9900 waiting for whichever of the two took longer — correct *given* the old admission rule,
but the operator's explicit direction was that the rule itself was wrong: "the schedule start
time... has nothing to do with playout time given the FIFO queue design... when the multi-zone cue
is triggered, and audio is already playing in the zones it targets, those [zone-specific tracks] get
added to the zones' FIFO queues, and the tracks can play immediately when the existing audio in that
zone is done." The operator also flagged that this engine had been amended piecemeal several times
(see ADRs [0005](0005-same-second-tie-break-and-settle-window.md),
[0009](0009-vog-preemption.md), [0010](0010-music-ducking.md)) and asked for one uniform pass rather
than another incremental patch.

Fixed by removing the multi-zone-entry concept from the engine entirely. `enqueue()` now decomposes
any cue spanning N zones into N independent per-zone sub-entries at enqueue time — each carrying that
zone's OWN specific child cue number, duration, and QLab internal uniqueId
(`zoneResolver.resolveZoneDetailsForCue`, replacing the separate
`resolveZonesForCue`/`resolveDurationSecondsByZone` that each re-walked the cue tree on their own).
Each sub-entry lives in *only* its own zone's queue and is admitted, ducked, confirmed, fired, and
freed entirely independently — firing the zone's own child cue directly (e.g. `/cue/990101/start`
for Zone 1) rather than the parent group's number.

This is the literal, structural meaning of "N independent per-zone FIFOs" — for every trigger type
(schedule fire, play-now, VOG) and every zone count uniformly, since a single-zone entry is simply
the N=1 case of the exact same decomposition path, not a separate code path. `_findReadyEntry`'s
cross-zone scan-past-not-ready machinery (the fix above) is removed entirely, since the
head-of-line-blocking problem it solved is now structurally impossible — no entry ever needs more
than one zone, so there is no cross-zone readiness to check; each zone's front-of-queue entry is
simply admitted once that zone is free.

`vogInterruptHandler.js`'s zone-occupancy stop-dedup logic needed no change — it already deduped by
`cueNumber` value, not entry identity, so it continues to work correctly (and more accurately: each
zone's occupant now genuinely carries its own real leaf cue number instead of always the parent
group's).

## Consequences

- **A theoretical multi-zone deadlock is now structurally impossible.** The old model admitted a
  case where two entries could permanently block each other by each waiting on the other's zone first
  (entry A wants zones [1,2] at the front of zone 1; entry B wants [2,1] at the front of zone 2).
  With no entry ever spanning more than one zone, there is no cross-zone wait to deadlock on.

- **Tests:** removed the two tests encoding the old "every zone must be free, front of every queue"
  rule (`only admits a multi-zone entry once every one of its zones is free...`, `does not
  head-of-line-block a single-zone entry behind an unrelated multi-zone entry...` — the scenario the
  second guarded against became structurally impossible). Added tests confirming each zone of a
  multi-zone entry admits/fires independently of the other, including a direct reproduction of the
  operator's exact report. All 148 unit tests pass. Live-verified: cue 1102 (Zone 1) and 2102 (Zone
  2) fired concurrently, then cue 9900 triggered 2s later while both were still playing — the event
  log shows 9900 decomposed into `9901` (Zone 1's child) and `9902` (Zone 2's child), with 9901
  firing the instant Zone 1's occupant (1102) cleared and 9902 firing independently ~4.7s later, the
  instant Zone 2's occupant (2102) cleared — neither waited on the other.

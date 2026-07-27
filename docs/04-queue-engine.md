# 04 · Queue engine

[`lib/queue/zoneQueueEngine.js`](../lib/queue/zoneQueueEngine.js) enforces the central rule:
**nothing overlaps within a zone, and unrelated zones are fully independent.** This chapter
summarizes how it behaves today; the full decision history and edge-case rationale is in
[ADR 0001](adr/0001-zone-queue-tiebreak-policy.md).

## The model

- **N independent per-zone FIFOs.** Every trigger — a schedule fire, a play-now, or a VOG — is
  decomposed at enqueue time into one sub-entry *per zone it targets*, each carrying that zone's own
  child cue number, duration, and QLab internal id. Each sub-entry lives in only its own zone's
  queue and is admitted, ducked, fired, and freed entirely on its own. A single-zone cue is just the
  N = 1 case of the same path — there is no separate code path and no cross-zone coordination.

- **Confirm before firing, always.** Before sending the real OSC `/start`, the engine live-queries
  QLab to confirm that cue isn't already playing (`getIsRunningByUniqueId`), retrying briefly if so.
  This closes a real class of bugs where a cached duration was a hair short and a retrigger landed
  while QLab was still finishing the previous instance (which QLab silently ignores). It never
  trusts a timer alone.

- **A zone frees** on whichever comes first: a live `/updates` push confirming the cue stopped, a
  duration-based fallback timer, or an immediate free if the `/start` itself was denied/failed.

## Contention rules

- **Settle window + tie-break.** Admission into a newly-free zone waits out a short settle window
  (`admissionSettleMs`, default 75 ms) so near-simultaneous arrivals can be compared. Entries due
  within the same wall-clock second are ordered by **cue number ascending**; entries in different
  seconds order strictly by due time.

- **Stale-drop (schedule fires only).** If a recurring schedule's next occurrence comes due while a
  prior instance of the *same schedule* is still waiting (not yet fired) in a zone, the stale
  waiting entry is dropped and replaced. Play-now and VOG never stale-drop or get stale-dropped. An
  entry that's already occupying a zone is never preempted this way.

- **Overflow cap.** Five waiting entries per zone; beyond that the oldest waiting entry is dropped
  and logged — a safety net against an unresponsive QLab letting a queue grow unbounded, not a
  normal path.

- **Play-now uses the same queue.** The test button goes through this exact engine — it can't be
  the one thing allowed to overlap audio. It reports back if it had to wait behind something.

- **VOG preemption.** A VOG trigger clears occupancy and drops every waiting entry for its target
  zones (no requeue), then enqueues the VOG cue through the same engine so it still gets
  confirm-before-fire. `vogInterruptHandler` issues the actual OSC stops; the engine only clears its
  own bookkeeping.

## Ducking, integrated

Ducking is driven from the engine's zone-lifecycle transitions, not modeled as queue entries:

- **Duck** fires once when a zone transitions from empty to occupied, guarded for idempotency. The
  burst-starting message doesn't fire until its zone's duck cue is confirmed done.
- **Unduck** fires once when a zone's queue is confirmed fully drained, enforced via a synthetic
  placeholder occupancy so nothing races in mid-unduck. A genuinely back-to-back arrival queues
  behind the placeholder rather than triggering a flicker.
- **VOG ducks immediately**, bypassing the settle window, and hands its `_ducked` bookkeeping back
  to the engine so there's exactly one unduck decision path.

## Suspected playback failure

If a cue is confirmed stopped implausibly early versus its known duration — a likely sign of a dead
Audio Patch output — the engine emits a distinct `suspected_playback_failure` event, surfaced as its
own browser toast rather than being silently treated as a normal completion.

## Design consequences

The engine is **in-memory only**: a restart drops all occupancy/queue state cleanly, which is
correct given cron-plus jobs are fully rebuilt from `schedules` on boot and the "skip, don't replay"
rule. Nothing about live queue state is meant to survive a restart.

---

**Full decision history and edge-case rationale:**
[ADR 0001 — Zone Queue Tie-Break Policy](adr/0001-zone-queue-tiebreak-policy.md).

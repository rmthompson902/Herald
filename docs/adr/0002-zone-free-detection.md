# ADR 0002: Zone-free detection

## Status

Accepted (Phase 8); a fourth free path added in the Phase 11 edge-case audit.

## Context

A zone stays occupied while its cue plays; the engine must decide when that cue is done and the
zone can admit the next entry. Relying on a blind timer alone is unsafe (durations drift), and
relying only on a live confirmation is unsafe too (a push can be missed).

## Decision

A zone frees via whichever comes first:

- a live `/updates` push confirming the occupying cue actually stopped
  (`qlabProtocol.getIsRunningByUniqueId`, keyed by QLab's internal uniqueID — see
  `test/fixtures/qlab-osc-findings.md`), or
- a duration-based fallback timer (`cue_cache`'s live-refreshed `durationSeconds`, falling back to
  30s if unknown).

The fallback timer is the safety net for a missed/ignored `/updates` push, not the primary
mechanism.

### Amendment — a fourth way (Phase 11 edge-case audit)

An immediate free if the real OSC `/start` itself came back denied or otherwise failed (e.g. OSC
control permissions toggled off mid-session, or the cue was deleted/renamed in QLab between the
`cue_cache` refresh and this fire — a narrower race than "any bad cue number," since a wholly
nonexistent cue number fails `refreshCueCache` earlier and never reaches `enqueue()` at all).

Before this fix, `_fire()` claimed occupancy for the cue's full assumed duration *before* even
calling `playCue()`, and a rejection only logged an `error` event — nothing freed the zone, so a
denied start still held it hostage for the rest of that window (bounded, never forever, but wasted:
up to the 30s fallback, or the cue's real cached duration otherwise) for a cue that never made a
sound. Fixed by freeing every one of the entry's zones immediately in the `playCue()` rejection
handler, tagged with a distinct `start_failed_zone_freed` event (rather than the normal
`zone_freed`) so the event log/history page can tell "burned its slot without playing" apart from a
normal completed playback.

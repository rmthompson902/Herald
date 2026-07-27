# ADR 0006: Stale-drop for repeated schedule fires

## Status

Accepted (Phase 8).

## Context

A recurring schedule can come due again while its previous occurrence is still waiting in a zone's
queue (the zone was busy). Firing both would violate the brief's "skip missed events, don't replay
in bulk" principle.

## Decision

**Stale-drop, schedule fires only.** If a recurring schedule's next occurrence comes due while a
prior instance of that *same schedule* is still waiting (not yet fired) in a zone's queue, the stale
waiting entry is dropped and replaced by the new one.

This is keyed on an explicit `dedupeKey` set only on schedule-fired entries (e.g. `schedule-{id}`)
— play-now and VOG entries never carry one, so they never stale-drop anything and are never
stale-dropped themselves. An entry already *occupying* a zone (already fired, or reserved and
mid-confirm) is never preempted by stale-drop; only *waiting* entries are.

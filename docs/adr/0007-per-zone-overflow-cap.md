# ADR 0007: Per-zone overflow cap

## Status

Accepted (Phase 8).

## Context

An unresponsive QLab that never confirms completions could let a zone's wait queue grow without
bound. The engine needs a hard ceiling as a safety net.

## Decision

**Five waiting entries per zone.** Beyond that, the oldest (front-of-queue) waiting entry is dropped
and logged — a safety net against a stuck/unresponsive QLab, not a normal-operation path.

Dropping the oldest (rather than refusing the newest) reflects that if the cap is being hit at all,
the front entry has likely been waiting on a QLab that isn't confirming completions; give up on it
rather than blocking everything behind it indefinitely.

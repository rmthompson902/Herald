# ADR 0001: Per-zone FIFO queue model

## Status

Accepted (Phase 8).

## Context

Collision handling is queue-and-wait, per zone (see [04 · Queue engine](../04-queue-engine.md)) —
never skip, never overlap. `lib/queue/zoneQueueEngine.js` implements this as an in-memory, per-zone
FIFO. This record fixes the base structure; the admission, tie-break, and ducking rules that build
on it are their own ADRs (see the [index](README.md)).

## Decision

One FIFO wait queue per zone, ordered by due time. (Same-second collisions are broken by
[ADR 0005](0005-same-second-tie-break-and-settle-window.md).)

## Consequences

- The engine is in-memory only, by design — a restart drops all occupancy/queue state cleanly,
  consistent with cron-plus jobs being fully rebuilt from `schedules` on boot rather than resuming
  any in-flight queue ("losing in-flight queue state on restart is correct given the skip, don't
  replay principle").

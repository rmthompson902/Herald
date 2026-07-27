# ADR 0008: Play-now goes through the queue

## Status

Accepted (Phase 8).

## Context

The webapp's "play now" test button is a UI convenience. It would be tempting to let it fire
directly, but "nothing overlaps within a zone" is a hard requirement — a convenience button can't be
the one exception.

## Decision

**Play-now submits through this exact same engine and queue, never bypassing it.** It reports
`queued: true` back to the operator (surfaced as a toast) if it doesn't fire immediately — and if
the eventual real fire happens well after that response went out, the recent-events ring buffer
(`getRecentEvents`) lets the webapp notice and send a follow-up notification, rather than the
operator never learning whether the queued message actually played.

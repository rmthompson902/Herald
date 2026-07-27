# ADR 0003: Confirm live before firing

## Status

Accepted (Phase 8; hardened after a production bug).

## Context

Added after a real bug: a schedule fire followed shortly by a play-now on the *same* cue — a very
common real operator action — resulted in the queued play-now never audibly playing a second time.
Root cause: `cue_cache`'s cached duration can be a hair shorter than QLab's true wall-clock playback
(fade tails, rounding), so the fallback timer could fire and trigger a retrigger of the same cue
number *while QLab was still finishing the previous instance* — which QLab appears to silently
ignore (no denial, no error, just no second audible play — confirmed by isolated OSC spike testing
against the real workspace).

## Decision

**Always confirm live before actually firing; never trust the timer alone.** Before ever sending
the real OSC `/start`, the engine live-queries `getIsRunningByUniqueId` for the candidate's own cue
and only fires once it comes back false, retrying every ~150ms up to ~20 attempts (~3s) if it's
still reported running, and firing anyway past that cap as a last-resort safety net (a
persistently-looping cue shouldn't block a safety message forever — the "never skip" principle).

This applies uniformly to every admission, not just retriggers of the same cue, since it's cheap
(one query) and removes an entire class of bookkeeping-vs-reality drift (e.g. after a restart, or a
cue started manually in QLab outside this system).

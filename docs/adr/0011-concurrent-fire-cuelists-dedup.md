# ADR 0011: Concurrent-fire `/cueLists` de-duplication

## Status

Accepted. Fixes a critical bug in concurrently-due schedules; extended by a follow-up (below).

## Context

Reported by the operator after every schedule was deliberately aligned to the same trigger moment:
only one message fired; the rest never appeared in the queue at all (and for play-now, the HTTP
response hung forever).

Root cause was unrelated to ducking ([ADR 0010](0010-music-ducking.md)) — it was in
`resolveDurationSecondsByZone` (`zoneResolver.js`, added by ADR 0010's second amendment for per-zone
Group duration), called directly and *without any error handling* by
`fn_on_due`/`fn_play_now`/`vogInterruptHandler`. Its first step re-fetches the whole cue tree via
`qlabProtocol.getCueLists()` — a query with no cue-number-specific address, so every
concurrently-firing schedule issues an identical-address OSC query at once. Live-tested (5 concurrent
play-now calls, mirroring the reported alignment): QLab answers only ONE of several simultaneous
identical-address queries; the rest sit unanswered until the client's own 3000ms timeout fires and
rejects with "OSC request timed out waiting for /reply/cueLists".

`refreshCueCache` already wraps its own equivalent query in a try/catch (degrading gracefully to a
skip-with-warning), but the later, separate `resolveDurationSecondsByZone` call was not wrapped
anywhere — the rejection propagated uncaught out of `fn_on_due`'s async handler (silently dropping
that schedule's fire before `enqueue()` is ever called — no `queued` event, nothing) or out of
`fn_play_now`'s (Node-RED logs the rejection internally but never sends an HTTP response, so the
request hangs indefinitely — reproduced live: `curl` hung past 2+ minutes on 4 of 5 concurrent
play-now calls).

## Decision

**Fix at the single source rather than patching every call site:** `resolveDurationSecondsByZone`
now catches a failure of the initial tree-fetch/zone-resolution step and returns `{}` — exactly the
same best-effort tolerance it already had for a single per-zone duration query failing, extended to
cover the whole-cue resolution failing too.

This is safe specifically because the function's return value is only ever an *optional per-zone
duration override* on top of an entry's already-resolved `zones`/`durationSeconds` (from
`refreshCueCache`, which independently and correctly still skips/warns on ITS OWN resolution
failure) — a caller getting `{}` back just falls through to the entry's shared `durationSeconds`,
i.e. the exact pre-ADR-0010-second-amendment behavior, never a dropped or duplicated fire.

Extending the same tolerance to `resolveZonesForCue`/`resolveZoneInfoForCue` themselves was
deliberately ruled out — those functions' output determines real zone-safety, and silently returning
empty zones on a transient OSC failure would make a genuinely-failed resolution indistinguishable
from a legitimately zero-zone (unrouted) cue, which fires immediately with no collision protection at
all.

1 new unit test in `zoneResolver.test.js`. All 147 unit tests pass. Live-verified: restarted
Node-RED, re-ran the exact 5-concurrent-play-now reproduction — all 5 returned real HTTP 200s (no
hangs), all 5 logged `queued`, and all 5 fired/freed cleanly in FIFO order over the following ~45s
with no drops.

## Follow-up — de-dupe the query itself (found immediately by further operator testing)

With the fix above in place (losers of the `/cueLists` race degrade gracefully instead of hanging),
the operator noticed a DIFFERENT symptom when two schedules in two completely unrelated, independent
zones aligned (e.g. Zone 1's cue 1101 and Zone 2's cue 2101): Zone 1 ducked and started its message,
and only once Zone 1's message was already playing did Zone 2 even start ducking — despite the two
zones having nothing to do with each other.

Root cause, confirmed via exact log timestamps: "gracefully degrading instead of hanging" still means
the losing schedule's `resolveDurationSecondsByZone` call burns the FULL 3000ms OSC request timeout
before it resolves (to `{}`) and lets that schedule's fire proceed — one schedule got queued
immediately (won the race), the others ~3.0s later. Since a duck cue's own real duration (~2s) is
shorter than that 3s penalty, the "losing" zone's whole duck+fire cycle hadn't even STARTED by the
time the "winning" zone's message was already playing — reading as "Zone 2 waits for Zone 1," when
what was actually happening was "Zone 2's admission is stuck waiting out an OSC timeout that has
nothing to do with Zone 1 at all."

Fixed the actual race rather than continuing to degrade after losing it: `qlabProtocol.js`'s
`getCueLists()` now de-dupes concurrent in-flight calls into a single shared OSC round trip —
`/cueLists` is a single, cue-number-agnostic address that every zone/duration resolution needs
regardless of which specific cue it's after, so every concurrent caller within the same in-flight
window gets the exact same real tree back from ONE query instead of each issuing (and mostly losing)
their own. This eliminates the race entirely rather than just softening its failure mode — correct
because the tree contents are identical for every caller in that instant, nothing about `/cueLists`
is per-cue.

3 new unit tests in `qlabProtocol.test.js` (concurrent calls share one request; a call starting
after the previous one already resolved gets its own fresh request; a call starting after a prior one
REJECTED also gets its own fresh request, not permanently stuck sharing a failure). All 150 unit
tests pass. Live-verified: re-ran the two-independent-zone reproduction (cues 1101/Zone 1 and
2101/Zone 2 via concurrent play-now) — both `queued` within 1ms of each other, both `duck_wait`
within 1ms, both `fired` within 4ms; re-ran the full 5-concurrent-schedule reproduction as well — all
5 `queued` within 2ms of each other now (previously one immediate + four ~3.0s later), all still
fire/free cleanly with no drops.

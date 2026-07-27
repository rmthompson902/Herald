# 03 · Domain concepts

The vocabulary the whole system is built around.

## Zones

A **zone** is an independent audio area of the venue (e.g. Zone 1 = lobby). Each zone has its own
queue and its own background-music ducking, and zones play fully independently of one another.

Zones are **derived, not tagged**. Each QLab cue is routed to a **Messaging Audio Patch**, and
[`config/audio-patch-map.json`](../config/audio-patch-map.json) maps each patch to a zone name plus
that zone's duck/unduck cue numbers. This file is the **only manual zone configuration in the
system** — it reflects fixed physical wiring. Given a cue, the system asks QLab which patch it uses
(`resolveZoneDetailsForCue` in [`lib/zones/zoneResolver.js`](../lib/zones/zoneResolver.js)) and maps
that to zones automatically. The map is hot-reloaded (`core.zones.reload()`) when edited through the
webapp's Zones admin — no Node-RED restart.

A cue can span multiple zones (a group cue with children on different patches). Each zone's portion
is queued, ducked, fired, and freed **independently** — a slow zone never holds up a fast one.

## Schedules

A **schedule** is a cue played on a recurring interval, with optional constraints:

- `intervalSeconds` — how often it fires.
- `startTime` / `endTime` — an active window within the day (`HH:MM`, DST-safe).
- `weekdays` — which days (1 = Monday … 7 = Sunday).
- `dateRangeStart` / `dateRangeEnd` — an overall active date range.
- `enabled` — the on/off toggle.

Validation and normalization live in [`lib/scheduling/scheduleModel.js`](../lib/scheduling/scheduleModel.js);
next-occurrence math and the cron-plus job spec live in
[`occurrenceCalculator.js`](../lib/scheduling/occurrenceCalculator.js). Enabled schedules are
compiled into cron-plus jobs; the set is rebuilt from SQLite on every boot, so in-flight timing
state never needs to survive a restart.

## VOG (Voice-of-God)

A **VOG message** is a single emergency priority tier: a manually-triggered cue (never scheduled),
deliberately with no timing fields. Triggering one — gated on QLab being armed — resolves the VOG
cue's own zone scope, **stops every active cue in those zones**, plays the VOG message through the
same queue engine, and drops anything it interrupted (including queued entries). Interrupted
messages are **not resumed** afterward. See
[`lib/vog/vogInterruptHandler.js`](../lib/vog/vogInterruptHandler.js).

## Cues & the cue cache

Operators build the actual audio **cues** in QLab under a stable numbering convention and this
system only triggers/queries them by number. A cue's **duration** and **zones** are sourced live
from QLab (never entered by hand) and cached in the `cue_cache` table so pages render without a
round trip. The cache is **never authoritative** — it's a performance convenience, refreshed on a
schedule and on demand ("Refresh Cue Data"). See
[`lib/db/repositories/cueCacheRepo.js`](../lib/db/repositories/cueCacheRepo.js) and
[`node-red/lib/refreshCueCache.js`](../node-red/lib/refreshCueCache.js).

## Ducking

Background music in a zone is **ducked** (lowered) while a message plays and restored afterward.
Ducking is two static per-zone QLab cues (`duckCueNumber` / `unduckCueNumber` in the patch map),
fired by the queue engine like any other cue. It is **batched, not per-message**: a zone ducks once
when it goes from empty to occupied, and unducks once only after its queue is fully drained — so
back-to-back messages don't produce an audible duck/unduck flicker. The message genuinely waits for
its zone's duck cue to finish before firing, and the zone isn't free again until the unduck cue
finishes. See [`lib/zones/duckDuration.js`](../lib/zones/duckDuration.js) and
[04 · Queue engine](04-queue-engine.md).

## Health & the arm gate

The system subscribes to QLab's `/updates` feed and keeps the UDP OSC registration alive with a
periodic `/thump` (QLab drops idle clients after ~61s). A few consecutive missed heartbeats flip the
state to **disconnected**. That same connectivity state is the **arm gate**: the scheduler stays
**disarmed** — firing nothing — until QLab is confirmed live, and disarms immediately if the link
drops. This satisfies the "never fire into a dead QLab" rule and the startup gate in one mechanism.
See [`lib/health/healthMonitor.js`](../lib/health/healthMonitor.js).

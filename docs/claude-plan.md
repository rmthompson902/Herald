# QLab Scheduled Audio Messaging System — Implementation Plan

## Context

`project-brief.md` lays out a scheduling layer for QLab: operators need recurring/time-boxed audio messages (safety announcements, closing messages, etc.) triggered across "zones" of a venue's audio system, without hand-building every playback event in QLab. The brief proposed Node-RED + cron-plus + SQLite + OSC as the stack, with QLab remaining the sole owner of playback/audio-routing.

This is a **greenfield project** — the repo currently contains only the brief. Before writing any code, we ran an extensive design interview to resolve every open architectural fork in the brief (platform choice, licensing constraints, zone modeling, collision handling, emergency messaging, health monitoring, auth). Those decisions are final and drive everything below; this plan is the concrete build-out of them.

Two decisions from that interview are worth calling out because they overturned the brief's original framing:
- **Zones have no manual configuration.** The venue routes every QLab cue to the same Dante Virtual Soundcard; "zone" is defined entirely by which output channels a cue's QLab-side level is set to 0dB vs. -inf. We discovered QLab's OSC dictionary exposes this per-cue (`/cue/{id}/levels`), so the system derives zone membership automatically instead of operators tagging it in the dashboard.
- **Health monitoring/feedback, initially considered a "later phase" feature** (out of concern that it needed the paid QLab license we don't have on the dev machine yet), **turned out to be fully buildable now** — QLab 5's official docs confirm OSC remote control, Network cues, and update feeds are all available on the free/unlicensed tier. So it's pulled into v1 in full, along with a `/thump`-heartbeat-driven connectivity monitor and a queue-and-wait collision engine backed by real QLab confirmation (not just timers).

## Confirmed Decisions (do not re-litigate during implementation)

- **Hosting:** Node-RED, self-hosted on the same Mac as QLab, communicating over local OSC. No FlowFuse cloud/platform — dashboard via the free `@flowfuse/node-red-dashboard` module only.
- **Auth:** none. Access is gated entirely by KVM + a locked-down LAN/firewall perimeter.
- **Design split:** Node-RED hosts the dashboard UI, cron-plus triggering, and OSC/SQLite plumbing. All non-trivial logic (collision engine, VOG, health monitor, zone derivation) lives in plain, unit-testable JS modules that Function nodes call into — not sprawling flow wiring.
- **QLab licensing:** dev machine is currently unlicensed; production machine gets a purchased QLab Audio license eventually. Verified (docs) that OSC control/query/update-feed functionality works on the free tier, so real hands-on testing is expected to work now — no mock QLab responder needed. This should be the very first thing validated (Phase 0 below), since everything else depends on it.
- **Cues:** pre-built by the operator in QLab under a stable naming convention (e.g. `MSG.LOBBY.SAFETY`, `MSG.ALL.EMERGENCY`). Node-RED only triggers/queries cues by name — it never creates or edits them.
- **Duration:** sourced live from QLab via `/cue/{id}/duration` (accounts for trim/repeat). Never entered manually.
- **Zones:** derived automatically from `/cue/{id}/levels` (per-cue output-channel level matrix) cross-referenced against one small manual file, `config/zone-map.json` (Dante channel number → zone name — the *only* manual config in the system, since it reflects fixed physical wiring). Dashboard shows the derived zone(s) back to the operator, read-only.
- **Collision handling:** queue-and-wait, per zone — never skip, never overlap. A newly-due cue waits for the zone's current occupant to finish (tracked via QLab-sourced duration **and** live `/updates` confirmation, not a blind timer alone). If a schedule's own next occurrence comes due while a prior instance of the *same* schedule is still queued, the stale one is dropped (consistent with the brief's existing "skip missed events, don't replay in bulk" principle). Cross-schedule ordering in the same zone: FIFO by due time. "Play-now" (the dashboard test button) goes through this exact same queue rather than bypassing it — since "nothing should overlap" is a hard requirement, a UI convenience button isn't allowed to be the one exception. It surfaces a toast if it ends up waiting behind something already playing.
- **VOG (Voice of God):** a single emergency priority tier — one or more dashboard-only, manually-triggered cues (never scheduled). Triggering one stops every active cue within that VOG cue's own auto-derived zone scope (one zone, several, or all — same derivation mechanism as any other cue), then plays the VOG message. Anything it interrupted (including queued entries) is dropped afterward, not resumed.
- **Health monitoring (in v1, not deferred):** subscribe to QLab's `/updates` feed for real-time cue-state/disconnect events; keep the UDP registration alive via periodic `/thump` + `/udpKeepAlive true` (QLab drops idle UDP OSC clients after 61s); a few consecutive missed heartbeats flips a "disconnected" state. Dashboard shows a visual/toast alarm — no external paging. This same connectivity state gates the scheduler: it stays disarmed until QLab is confirmed live (satisfies the brief's startup-gate requirement). No workspace-identity matching is needed on top of this — only one workspace file will ever run on the deployed machine, so "any QLab is responding" is sufficient; there's no "wrong show file open" case to guard against.

## Stack (verified against the npm registry)

| Package | Version | Role |
|---|---|---|
| `node-red-contrib-cron-plus` | 2.2.4 | recurring/time-based scheduling engine |
| `@flowfuse/node-red-dashboard` | 1.30.2 | free, self-hosted dashboard UI (confirmed OSS, not the paid FlowFuse platform) |
| `osc` | 2.4.5 | OSC-over-UDP library, used directly in a custom client rather than a generic Node-RED OSC node — needed for request/response correlation on QLab's query-style addresses |
| `better-sqlite3` | 12.11.1 | sync SQLite driver — fits Function nodes cleanly, no async ceremony for simple CRUD |
| `winston` | 3.19.0 | app-diagnostic logging — direct equivalent of Python's `logging` module |
| `winston-daily-rotate-file` | 5.0.0 | midnight-rotating log files with retention — equivalent of `TimedRotatingFileHandler` |

## Repo Structure

```
lib/                        # plain, testable JS — no Node-RED coupling except at two edges
├── index.js                 # composition root; facade exposed to Node-RED via functionGlobalContext
├── osc/
│   ├── oscClient.js          # raw UDP transport + request/response correlation + timeouts
│   └── qlabProtocol.js       # QLab verbs: getDuration, getLevels, playCue, stopCue, listCues, subscribeUpdates, thump
├── zones/
│   ├── zoneMap.js            # loads/validates config/zone-map.json
│   └── zoneResolver.js       # parseLevelsMatrix (pure) + resolveZonesForCue (composed w/ IO)
├── scheduling/
│   ├── scheduleModel.js      # pure validation/normalization of schedule input
│   ├── occurrenceCalculator.js  # pure: next-occurrence math, cron-plus job-spec builder, DST-safe active-window check
│   └── cronSync.js           # diffs SQLite schedules vs. cron-plus job specs
├── queue/
│   └── zoneQueueEngine.js    # per-zone occupancy + FIFO wait queue + stale-drop + VOG preempt (pure/in-memory)
├── vog/
│   └── vogInterruptHandler.js
├── health/
│   └── healthMonitor.js      # heartbeat state machine, /updates lifecycle, scheduler-arm gate
├── log/
│   ├── appLogger.js          # winston + winston-daily-rotate-file; mirrors the user's reference Python setup
│   │                         #   (console + file, "name - level - message", midnight rotation, 30-day retention)
│   └── eventLogger.js        # separate daily-rotating plain-text log, one line per business event
│                              #   (fired/queued/dropped_stale/vog_interrupt/vog_fired/play_now/health_*),
│                              #   30-day retention — feeds the dashboard's Event History view
└── db/
    ├── database.js
    ├── migrations/001_init.sql (+ runner.js)
    └── repositories/{schedulesRepo,vogMessagesRepo,cueCacheRepo}.js

node-red/                   # Node-RED userDir (flows.json, settings.js wiring functionGlobalContext.core = require('../lib'))
config/zone-map.json        # the one manual config file
config/env.example           # QLAB_OSC_HOST, QLAB_OSC_PORT, DB_PATH, DASHBOARD_PORT
data/schedule.db            # gitignored, created by migration runner
logs/                       # gitignored; app-YYYY-MM-DD.log + events-YYYY-MM-DD.log, both 30-day auto-pruned
test/unit/                  # jest, mirrors lib/ structure
test/fixtures/              # real captured OSC payloads from the Phase 0 spike
test/integration/INTEGRATION_CHECKLIST.md   # hands-on checklist against real QLab
docs/adr/0001-zone-queue-tiebreak-policy.md
```

## SQLite Schema

- **`schedules`** — name, `qlab_cue_number`, interval, start/end time, weekdays (JSON), date range, enabled flag.
- **`vog_messages`** — name, `qlab_cue_number`, enabled flag. Deliberately no timing fields (manual-trigger only).
- **`cue_cache`** — cached-only (never authoritative): duration, derived zones (JSON), QLab's internal cue id (needed to reconcile `/updates` events, which are keyed by internal id, not cue number — confirm the lookup OSC address, likely `/cue/{number}/uniqueID`, during Phase 0), refreshed_at.

There is no `event_log` table — business event history lives in `logs/events-YYYY-MM-DD.log` instead (see Logging below), not SQLite. This keeps the schema to exactly the durable configuration the operator actually edits through the dashboard.

Explicitly **not** persisted in SQLite: connectivity state and the live zone-occupancy queue. Both reset cleanly on restart by design — cron-plus jobs are fully rebuilt from `schedules` on boot, and losing in-flight queue state on restart is correct given the "skip, don't replay" principle. SQLite + `zone-map.json` are the only real sources of truth for durable configuration.

## Logging

Two separate daily-rotating plain-text logs, both via `winston` + `winston-daily-rotate-file`, both in `logs/`, both with 30-day auto-prune (mirroring the retention/rotation style of the user's reference Python `TimedRotatingFileHandler` setup, adapted to Node's idioms — a per-module logger name substitutes for Python's `%(funcName)s:%(lineno)d`, which isn't cheaply available in Node without stack-trace parsing):

- **`app-YYYY-MM-DD.log`** (`lib/log/appLogger.js`) — general application diagnostics for troubleshooting the system itself: console (configurable level, default INFO) + file (DEBUG, detailed format), one named child logger per `lib/` module.
- **`events-YYYY-MM-DD.log`** (`lib/log/eventLogger.js`) — the business/operator-facing history: one consistent plain-text line per domain event (`fired` / `queued` / `dropped_stale` / `vog_interrupt` / `vog_fired` / `play_now` / `error` / `health_disconnect` / `health_reconnect`), human-readable directly in a text editor and simple enough for the dashboard's Event History view to parse. This is what the dashboard tails/reads for "event history"; older days are just older files, which the operator manages (archives/deletes) directly on disk — no in-app retention UI.

## Dashboard Features (v1 scope, consolidated from the brief)

- Schedule list with enabled status; create/edit/enable/disable.
- Cue selection by browsing QLab's live cue list (not manual entry) — requires the `listCues()` OSC query.
- Repeat interval, start/end time, active weekdays, date range.
- After save: read-only display of the cue's derived zone(s) and duration (both sourced live from QLab, never entered manually).
- Next scheduled playback time (via `occurrenceCalculator`, independent of cron-plus's internal state).
- Play-now testing (queues like a real occurrence per the collision policy above; toasts if it has to wait).
- Event history (tails `logs/events-YYYY-MM-DD.log`; see Logging).
- QLab connection status, with a visual/toast alarm on disconnect (see health monitoring above).
- VOG trigger buttons — one per configured VOG message, manual-only, no timing UI.

Explicitly **not** in v1: dashboard authentication, manual zone tagging, configurable per-schedule overlap policy (the brief's original "skip / queue / interrupt" options) — collision handling is a single fixed queue-and-wait behavior, and VOG is the only interrupt mechanism, full stop.

## Reference documentation

Research for this plan was done against **QLab 5** docs specifically — confirm this matches the actual QLab version in use (see Open Items below):
- OSC dictionary: https://qlab.app/docs/v5/scripting/osc-dictionary-v5/
- OSC queries: https://qlab.app/docs/v5/scripting/osc-queries/
- Using OSC with QLab: https://qlab.app/docs/v5/networking/using-osc/
- Features by license type: https://qlab.app/docs/v5/general/features/

## Zone-Queue Tie-Break Policy (judgment call — recorded as `docs/adr/0001-zone-queue-tiebreak-policy.md`)

1. One FIFO queue per zone.
2. Zone frees (via `/updates` confirmation or expected-end fallback timer) → pop and fire the front entry.
3. Enqueuing a schedule that already has an entry waiting in that zone → drop the old entry, treat this as the live occurrence (stale-drop, not double-stack).
4. Cross-schedule ordering: FIFO by due time; exact ties broken by schedule id.
5. Defensive cap of ~5 queued entries per zone (oldest dropped + logged beyond that) as a safety net against a stuck QLab — cheap insurance, not explicitly requested.

VOG preemption clears zone occupancy and drops all waiting entries outright for its target zones — no requeue.

## Build Phases

0. **QLab OSC spike** (scratch script, no Node-RED yet) — validate on the real free-tier dev QLab: `/cue/{n}/duration` and `/cue/{n}/levels` responses (capture as fixtures), the `-inf` wire representation, cue-list enumeration, `/updates 1` behavior and its cue-id keying, `/thump` + `/udpKeepAlive` past the 61s UDP timeout, and whether an unlicensed-QLab nag dialog could block unattended auto-start. This phase exists specifically to confirm the free-tier assumption before investing further.
1. **Skeleton + persistence** — migrations, repos (tested against real temp SQLite files), `zone-map.json` + loader.
2. **OSC transport + protocol layer** — `oscClient` + `qlabProtocol` built from Phase 0 findings; `healthMonitor` state machine with fake-timer tests.
3. **Node-RED shell + first end-to-end schedule** — one hardcoded schedule through cron-plus → real QLab playback; then dashboard basics (list, create/edit, enable/disable, play-now, cue browse) with restart-safe `cronSync`.
4. **Zone derivation** — live `zoneResolver`, `cue_cache` wiring, dashboard shows derived read-only zones.
5. **Queue/collision engine** — `zoneQueueEngine` end-to-end; manually verify FIFO/stale-drop with overlapping schedules.
6. **VOG** — CRUD + `vogInterruptHandler`; verify stop+play+drop-not-resume for both single-zone and all-zone VOG cues.
7. **Health monitoring + dashboard polish** — connection status/toast, startup-gate verification (kill/relaunch QLab mid-run), event history view.
8. **Soak/reliability pass** — multi-day soak, restart-recovery checks, launchd auto-start for both apps, full integration checklist run before the production QLab Audio license purchase.

## Verification

- **Unit tests (Jest, `lib/` only, no live QLab):** `occurrenceCalculator` (interval/weekday/date-range/DST edge cases), `zoneResolver`'s pure matrix parser (fixture-driven), `zoneQueueEngine` (fake-timer: free-fires-immediately, occupied-queues, same-schedule stale-drop, cross-schedule FIFO, VOG preempt), `healthMonitor` (missed-heartbeat threshold, explicit disconnect, reconnect), `cronSync`, `scheduleModel`, repositories.
- **Integration checklist (hands-on against real dev-machine QLab, not automatable):** confirm QLab's Workspace Settings → Network → OSC Controls has read/edit/control permissions enabled with no passcode (Phase 0 found this denies *every* OSC command, including basic cue triggering, when left at QLab's default — easy to forget on the production machine's workspace); OSC connectivity + keepalive past 61s; duration/levels accuracy on real cues; live cue-list enumeration; wall-clock single-schedule firing; same-zone collision via both the duration-timer path and a manually-killed cue's `/updates` path; VOG stop+play+non-resume; health-monitor disconnect/reconnect and scheduler disarm/rearm; Node-RED restart correctness (no duplicate/missing cron-plus jobs); launchd unattended auto-start with correct disarmed-until-confirmed behavior; and the free-tier nag-dialog risk from Phase 0.

## Confirmed: QLab version and queue cap

- **Target is QLab 5** — matches all OSC research/citations in this plan; no re-verification needed going into Phase 0.
- **Zone-queue overflow cap stays at 5 entries per zone** (oldest dropped + logged beyond that), as specified in the Zone-Queue Tie-Break Policy above.

### Critical files
- `lib/index.js`
- `lib/queue/zoneQueueEngine.js`
- `lib/osc/qlabProtocol.js`
- `lib/zones/zoneResolver.js`
- `lib/scheduling/cronSync.js`
- `lib/db/migrations/001_init.sql`
- `node-red/settings.js`

# QLab Scheduled Audio Messaging System — Implementation Plan

## Context

`project-brief.md` lays out a scheduling layer for QLab: operators need recurring/time-boxed audio messages (safety announcements, closing messages, etc.) triggered across "zones" of a venue's audio system, without hand-building every playback event in QLab. The brief proposed Node-RED + cron-plus + SQLite + OSC as the stack, with QLab remaining the sole owner of playback/audio-routing.

This is a **greenfield project** — the repo currently contains only the brief. Before writing any code, we ran an extensive design interview to resolve every open architectural fork in the brief (platform choice, licensing constraints, zone modeling, collision handling, emergency messaging, health monitoring, auth). Those decisions are final and drive everything below; this plan is the concrete build-out of them.

Two decisions from that interview are worth calling out because they overturned the brief's original framing:
- **Zones have no manual configuration.** The venue routes every QLab cue to the same Dante Virtual Soundcard; "zone" is defined entirely by which output channels a cue's QLab-side level is set to 0dB vs. -inf. We discovered QLab's OSC dictionary exposes this per-cue (`/cue/{id}/levels`), so the system derives zone membership automatically instead of operators tagging it in the dashboard.
- **Health monitoring/feedback, initially considered a "later phase" feature** (out of concern that it needed the paid QLab license we don't have on the dev machine yet), **turned out to be fully buildable now** — QLab 5's official docs confirm OSC remote control, Network cues, and update feeds are all available on the free/unlicensed tier. So it's pulled into v1 in full, along with a `/thump`-heartbeat-driven connectivity monitor and a queue-and-wait collision engine backed by real QLab confirmation (not just timers).

## Frontend Pivot: Dashboard 2.0 → FastAPI (mid-implementation, after Phase 3)

Phases 0-2 and the non-UI half of Phase 3 (Node-RED scheduling engine, live-validated against real QLab) went smoothly and are solid. Building the operator dashboard in `@flowfuse/node-red-dashboard` (Dashboard 2.0) did not: every widget's dynamic-update behavior had to be reverse-engineered from the compiled frontend bundle (no way to use Dashboard 2.0's own visual editor or see a browser from here), producing repeated rounds of guess → user tests in a real browser → wrong guess → fix, including a framework-level bug (no `<base href>`, breaking any page refresh except the bare dashboard root) that isn't fixable from our side at all.

**Decision: drop Dashboard 2.0 entirely. Node-RED becomes a headless scheduling/OSC engine with a small internal JSON API (plain `http-in`/`http-response` nodes, not a UI framework). A new, separate Python/FastAPI web application is the actual operator-facing multi-page frontend**, modeled on an existing app the user has built and reused repeatedly (`/Users/ryanthompson/Documents/_dev/UPS-Mgmt/`: Flask + Jinja2 server-rendered templates, vendored Bootstrap 5 + Font Awesome, a shared `base.html` shell with `{% block %}` extension points, Jinja2 macros for reusable components, vanilla ES6 JS "manager" utility classes, a standardized JSON API envelope).

This is a UI-layer swap only. **None of the `lib/` business logic changes** — every module in the Repo Structure below is unchanged and still runs inside Node-RED exactly as built and validated. See "Frontend Architecture" below for the concrete split.

**Nothing from Phases 0-3 is discarded.** All code, tests, and fixtures from those phases stay exactly as built — this pivot only removes the `@flowfuse/node-red-dashboard` flow nodes (never the engine nodes) and adds a new `webapp/` directory alongside, it doesn't touch `lib/`, `test/`, or the proven `fn_startup`/`cronplus1`/`fn_on_due` flow. The Build Phases section below keeps Phases 0-3 listed with their original detail, marked done, specifically so that history stays referenceable rather than being summarized away.

**Archiving the Dashboard 2.0 attempt, not deleting it.** Before stripping `node-red/flows.json` down to its engine-only content (Phase 5), copy the current full file to `_old/node-red-flows-dashboard2-attempt.json` (a new gitignored `_old/` directory at repo root — add it to `.gitignore`). This preserves the widget configuration we reverse-engineered (schema quirks, working `selectionType`/`ui_update` shapes, etc.) as a local reference in case anything is useful later, without it cluttering the tracked repo or implying it's still in use. Same treatment for anything else in this pivot worth keeping-but-not-tracking as it comes up.

## Confirmed Decisions (do not re-litigate during implementation)

- **Hosting:** Node-RED, self-hosted on the same Mac as QLab, communicating over local OSC. No FlowFuse cloud/platform. Node-RED is now **headless** (no dashboard UI of its own) — see Frontend Architecture below. Its HTTP API binds to `127.0.0.1` only, since nothing but the co-located FastAPI app needs to reach it.
- **Auth:** none, anywhere (Node-RED's API, FastAPI's pages/API). Access is gated entirely by KVM + a locked-down LAN/firewall perimeter.
- **Design split:** Node-RED hosts cron-plus triggering and OSC/SQLite plumbing; FastAPI hosts the operator-facing multi-page UI and browser-facing API. All non-trivial logic (collision engine, VOG, health monitor, zone derivation, schedule validation, cron-plus sync) lives in plain, unit-testable JS modules in `lib/` that Node-RED Function nodes call into — not sprawling flow wiring, and never reimplemented in Python.
- **QLab licensing:** dev machine is currently unlicensed; production machine gets a purchased QLab Audio license eventually. Verified (docs) that OSC control/query/update-feed functionality works on the free tier, so real hands-on testing is expected to work now — no mock QLab responder needed. This should be the very first thing validated (Phase 0 below), since everything else depends on it.
- **Cues:** pre-built by the operator in QLab under a stable naming convention (e.g. `MSG.LOBBY.SAFETY`, `MSG.ALL.EMERGENCY`). Node-RED only triggers/queries cues by name — it never creates or edits them.
- **Duration:** sourced live from QLab via `/cue/{id}/duration` (accounts for trim/repeat). Never entered manually.
- **Zones:** derived automatically from `/cue/{id}/levels` (per-cue output-channel level matrix) cross-referenced against one small manual file, `config/zone-map.json` (Dante channel number → zone name — the *only* manual config in the system, since it reflects fixed physical wiring). The webapp shows the derived zone(s) back to the operator, read-only.
- **Collision handling:** queue-and-wait, per zone — never skip, never overlap. A newly-due cue waits for the zone's current occupant to finish (tracked via QLab-sourced duration **and** live `/updates` confirmation, not a blind timer alone). If a schedule's own next occurrence comes due while a prior instance of the *same* schedule is still queued, the stale one is dropped (consistent with the brief's existing "skip missed events, don't replay in bulk" principle). Cross-schedule ordering in the same zone: FIFO by due time. "Play-now" (the webapp's test button) goes through this exact same queue rather than bypassing it — since "nothing should overlap" is a hard requirement, a UI convenience button isn't allowed to be the one exception. It surfaces a toast if it ends up waiting behind something already playing.
- **VOG (Voice of God):** a single emergency priority tier — one or more webapp-only, manually-triggered cues (never scheduled). Triggering one stops every active cue within that VOG cue's own auto-derived zone scope (one zone, several, or all — same derivation mechanism as any other cue), then plays the VOG message. Anything it interrupted (including queued entries) is dropped afterward, not resumed.
- **Health monitoring (in v1, not deferred):** subscribe to QLab's `/updates` feed for real-time cue-state/disconnect events; keep the UDP registration alive via periodic `/thump` + `/udpKeepAlive true` (QLab drops idle UDP OSC clients after 61s); a few consecutive missed heartbeats flips a "disconnected" state. The webapp's Status page shows a visual alarm — no external paging. This same connectivity state gates the scheduler: it stays disarmed until QLab is confirmed live (satisfies the brief's startup-gate requirement). No workspace-identity matching is needed on top of this — only one workspace file will ever run on the deployed machine, so "any QLab is responding" is sufficient; there's no "wrong show file open" case to guard against.

## Stack (verified against the npm registry)

| Package | Version | Role |
|---|---|---|
| `node-red-contrib-cron-plus` | 2.2.4 | recurring/time-based scheduling engine |
| `osc` | 2.4.5 | OSC-over-UDP library, used directly in a custom client rather than a generic Node-RED OSC node — needed for request/response correlation on QLab's query-style addresses |
| `better-sqlite3` | 12.11.1 | sync SQLite driver — fits Function nodes cleanly, no async ceremony for simple CRUD |
| `winston` | 3.19.0 | app-diagnostic logging — direct equivalent of Python's `logging` module |
| `winston-daily-rotate-file` | 5.0.0 | midnight-rotating log files with retention — equivalent of `TimedRotatingFileHandler` |

`@flowfuse/node-red-dashboard` is removed (see Frontend Pivot above) — uninstall it and delete its flow nodes.

**New: `webapp/` Python stack** (versions to be pinned in `webapp/requirements.txt` when scaffolded — check current versions at that time rather than trusting these as final):

| Package | Role |
|---|---|
| `fastapi` | web framework — pages (via `Jinja2Templates`) + browser-facing JSON API |
| `uvicorn[standard]` | ASGI server |
| `jinja2` | server-rendered templates, same pattern as the UPS-Mgmt reference app |
| `pydantic` (bundled with FastAPI) | request/response models for the API |
| `httpx` | async HTTP client for FastAPI → Node-RED proxy calls |
| `python-multipart` | required by FastAPI for HTML form submissions |
| `python-socketio` | real-time push to the browser — a background thread polls Node-RED's `/api/health` (~2s interval, mirroring UPS-Mgmt's own daemon-thread polling pattern) and re-broadcasts state changes; the browser never talks to Node-RED directly |

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
                              #   headless: no dashboard UI, just the scheduling engine + a small internal HTTP API
                              #   (uiHost bound to 127.0.0.1 - see Frontend Architecture)
config/zone-map.json        # the one manual config file
config/env.example           # QLAB_OSC_HOST, QLAB_OSC_PORT, DB_PATH, NODE_RED_API_PORT
data/schedule.db            # gitignored, created by migration runner - shared by Node-RED (read/write) and
                              #   webapp/ (read-only), safe under SQLite's WAL mode (already enabled)
logs/                       # gitignored; app-YYYY-MM-DD.log + events-YYYY-MM-DD.log, both 30-day auto-pruned
                              #   - shared: webapp/'s History page tails events-*.log directly, no proxy needed
test/unit/                  # jest, mirrors lib/ structure
test/fixtures/              # real captured OSC payloads from the Phase 0 spike
test/integration/INTEGRATION_CHECKLIST.md   # hands-on checklist against real QLab
docs/adr/0001-zone-queue-tiebreak-policy.md
_old/                       # gitignored: archived Dashboard 2.0 flows.json (see Frontend Pivot) and anything
                              #   else worth keeping locally but not tracking - never referenced by running code

webapp/                     # NEW: the actual operator-facing frontend (FastAPI). See Frontend Architecture below.
├── requirements.txt
├── .env.example             # NODE_RED_API_BASE, DB_PATH, PORT
├── app/
│   ├── main.py               # FastAPI() app, routers, StaticFiles, Jinja2Templates
│   ├── config.py             # pydantic-settings, mirrors lib's env-var pattern
│   ├── node_red_client.py     # thin wrapper around httpx calls to Node-RED's internal API - the ONE place
│   │                          #   that knows Node-RED's endpoint shapes; handles connect-refused gracefully
│   ├── db/queries.py          # read-only sqlite3 SELECT helpers mirroring schedulesRepo/vogMessagesRepo/
│   │                          #   cueCacheRepo's read shapes - no writes ever happen from here
│   ├── models/{schedule,vog}.py   # Pydantic request/response models (client-side UX validation only -
│   │                          #   Node-RED's validateSchedule remains the actual authority on every write)
│   └── routers/{pages,schedules_api,vog_api,cues_api,status_api}.py
├── templates/
│   ├── base.html              # shared shell, ported from UPS-Mgmt's base.html pattern
│   ├── schedules/{list,form}.html
│   ├── vog/{list,form}.html
│   ├── history.html, status.html
│   └── partials/components/{status_badge,action_button,modal_base}.html   # ported macros
└── static/
    ├── vendor/{bootstrap,fontawesome}/   # copied from UPS-Mgmt/static/vendor/
    ├── css/style.css
    └── js/
        ├── utils/{api-client,modal-manager,button-state-manager}.js   # ported as-is from UPS-Mgmt
        └── {schedules_list,schedule_form,vog_list,vog_form,status}.js
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
- **`events-YYYY-MM-DD.log`** (`lib/log/eventLogger.js`) — the business/operator-facing history: one consistent plain-text line per domain event (`fired` / `queued` / `dropped_stale` / `vog_interrupt` / `vog_fired` / `play_now` / `error` / `health_disconnect` / `health_reconnect`), human-readable directly in a text editor and simple enough for the webapp's Event History page to parse. This is what the webapp tails/reads for "event history"; older days are just older files, which the operator manages (archives/deletes) directly on disk — no in-app retention UI.

## Frontend Architecture: FastAPI ↔ Node-RED split

**Rule: FastAPI reads SQLite directly (read-only) for everything displayable. Every write to `schedules` or `vog_messages`, and everything requiring the live OSC connection, proxies to Node-RED.** This keeps `validateSchedule` and `cronSync.syncOne` single-sourced in `lib/` (the whole point of the pivot) while not making simple page-load reads depend on a second process being up.

| Operation | Path |
|---|---|
| List/get schedules, VOG messages, cue_cache | FastAPI → SQLite directly (read-only connection; WAL mode already enabled makes this safe alongside Node-RED's writes) |
| Create/update/delete/toggle-enabled schedule or VOG message | FastAPI → proxy to Node-RED (`validateSchedule` + `cronSync.syncOne` must run there) |
| Cue browsing (`listCues`), play-now, VOG trigger, connection health | FastAPI → proxy to Node-RED (owns the live OSC socket) |
| Next-occurrence display | FastAPI → proxy to a bulk Node-RED endpoint (pure `occurrenceCalculator` math, but DST-safe logic must not be reimplemented in Python) — best-effort, page never blocks on it |
| Event history | FastAPI reads `logs/events-YYYY-MM-DD.log` directly — plain text, no proxy needed |

Pydantic models in `webapp/app/models/` mirror `scheduleModel.js`'s field rules (HH:MM regex, weekdays 1-7, etc.) for instant client-side feedback only — this is UX duplication, not business-logic duplication. Node-RED's `validateSchedule` still runs on every write and remains the actual authority; a passing Pydantic check never skips the proxy call.

**Node-RED's internal HTTP API** (`http-in`/`http-response` nodes only — plain, well-documented, not a UI framework; bound to `127.0.0.1`):

| Method | Path | Backing call |
|---|---|---|
| `POST` | `/api/schedules` | `validateSchedule` → `schedulesRepo.create` → `cronSync.syncOne` → apply to `cronplus1` |
| `PUT` | `/api/schedules/:id` | same, via `schedulesRepo.update` |
| `DELETE` | `/api/schedules/:id` | `cronSync.toRemoveCommand` applied → `schedulesRepo.remove` |
| `POST` | `/api/schedules/:id/toggle` | `schedulesRepo.setEnabled` → `cronSync.syncOne` → apply |
| `GET` | `/api/schedules/next-occurrences` | loops `schedulesRepo.listEnabled` through `occurrenceCalculator` (~48h window) |
| `POST` / `PUT` / `DELETE` / `.../toggle` | `/api/vog-messages[/:id]` | mirrors schedule CRUD via `vogMessagesRepo` (no cron-plus sync — VOG has no timing) |
| `POST` | `/api/vog-messages/:id/trigger` | gated on `core.health.isArmed()`; calls `vogInterruptHandler` once Phase 6 lands, `qlabProtocol.playCue` as an interim stub until then — **contract is stable now, internals upgrade in place later** |
| `GET` | `/api/cues` | `qlabProtocol.listCues()` live |
| `POST` | `/api/schedules/:id/play-now` | same interim-stub note — upgrades to go through `zoneQueueEngine` once Phase 5 lands |
| `GET` | `/api/health` | `core.health.getState()` / `isArmed()` |

Each write endpoint needs the same "turn a `cronSync` directive into a real `cronplus` control message" translation currently inline in `fn_startup` — extract it into one shared helper (e.g. `node-red/lib/flows/applyCronSyncDirectives.js`) so `fn_startup`'s `rebuildAll` path and the new per-endpoint `syncOne` calls share identical logic instead of two slightly-different copies.

**Multi-page breakdown** (mirrors the UPS-Mgmt "list page + separate add/edit page" pattern):

1. `GET /schedules` — list: name, cue, timing summary, derived zones/duration (from `cue_cache`), enabled toggle, next-occurrence, row actions (Edit/Play Now/Delete/Enable-Disable).
2. `GET /schedules/new` and `GET /schedules/{id}/edit` — one shared form template (`schedule=None` vs. populated), cue-picker backed by `GET /api/cues`.
3. `GET /vog` — same list pattern, with a "Trigger" action instead of timing fields.
4. `GET /vog/new` / `GET /vog/{id}/edit` — same form pattern, no timing/weekday/date-range fields.
5. `GET /history` — tails `logs/events-YYYY-MM-DD.log`.
6. `GET /status` — QLab connection state/armed flag, updated in real time via the SocketIO relay (see below).

Nav in `base.html`: Schedules / VOG Messages / Event History / Connection Status.

**Files to port from UPS-Mgmt verbatim, then adapt** (mirror its feel/style directly, not just its structural pattern — copy these into `webapp/` and edit in place, don't rewrite from scratch):

| Source (`/Users/ryanthompson/Documents/_dev/UPS-Mgmt/`) | Destination (`webapp/`) | Adaptation needed |
|---|---|---|
| `templates/base.html` | `templates/base.html` | Swap nav items (Dashboard/Devices/Settings → Schedules/VOG/History/Status), swap branding strings, keep the `{% block title/additional_css/content/scripts %}` shell, toast system, and `socket = io()` connection as-is (real-time push is confirmed, not dropped — see below) |
| `templates/components/action_button.html`, `templates/partials/components/{modal_base,modal_wrapper,page_header,status_badge}.html` | `templates/partials/components/` | Mostly copy as-is; `status_badge` needs new status→color/icon mappings for schedule-enabled/connection-state instead of device/battery status |
| `static/css/style.css` | `static/css/style.css` | Copy the design-token system (dark theme CSS custom properties) as-is; this is exactly "mirror the feel/style" |
| `static/vendor/bootstrap/`, `static/vendor/fontawesome/` | `static/vendor/` | Copy verbatim, no changes — same offline-capable vendoring approach |
| `static/js/utils/api-client.js` | `static/js/utils/api-client.js` | Copy the base `APIClient` class as-is; replace `DeviceAPI`/`ProfileAPI`/`SystemAPI` subclasses with `ScheduleAPI`/`VogAPI`/`CueAPI`/`StatusAPI` hitting this app's own `/api/*` routes |
| `static/js/utils/modal-manager.js`, `button-state-manager.js`, `tooltip-manager.js`, `constants.js` | `static/js/utils/` | Copy as-is; `constants.js`'s `window.AppConstants` object gets this app's own modal IDs/event names/messages |
| `src/utils/response_helpers.py` | `app/responses.py` | Copy the `success_response()`/`error_response()` JSON envelope convention as-is |
| `src/config.py`'s `get_env()` pattern | `app/config.py` | Same typed env-var helper pattern, new var names (`NODE_RED_API_BASE`, `DB_PATH`, `PORT`) |

**Not** porting: `Flask-SocketIO`/the live `socket = io()` connection in `base.html`, `src/custom_html.py`/`src/custom_css.py` (operator-configurable branding-override system — real feature for a multi-deployment product, not needed for this single-venue tool), the domain-specific `src/ups/*` logic and its templates/JS (obviously), and the `old/` legacy-reference folder within UPS-Mgmt itself (not relevant here).

**Real-time push (confirmed, not polling):** FastAPI runs `python-socketio` and a background thread mirroring UPS-Mgmt's own daemon-thread polling pattern — it polls Node-RED's `GET /api/health` internally (every ~2s) and re-broadcasts state changes to connected browsers over its own socket, exactly like `base.html`'s `socket = io()` connection in the reference app. The browser never talks to Node-RED directly; FastAPI is the only relay.

**Landing page:** `GET /` and `GET /schedules` render the same content — the schedule list *is* the landing page (no separate summary/overview page). Whether the template file is literally named `dashboard.html` or `schedules.html` doesn't matter.

**Template generalization approach (confirmed):** no separate up-front "extract an abstract template" project. Generalize in place while porting each file from UPS-Mgmt into `webapp/` — rename any UPS/battery-specific identifiers to generic ones as they're copied, rather than leaving domain-specific names hacked to fit. The result (this app's `base.html`/macros/CSS/JS utils) becomes the reusable template for future projects, proven across two real apps instead of designed abstractly.

Explicitly **not** in v1: any authentication, manual zone tagging, configurable per-schedule overlap policy (the brief's original "skip / queue / interrupt" options) — collision handling is a single fixed queue-and-wait behavior, and VOG is the only interrupt mechanism, full stop.

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

**Phases 0-2 are complete** — see status notes inline. Phase 3 is split: its engine half (0-2's natural continuation) is done and live-validated; its original dashboard half is replaced by the phases below per the Frontend Pivot.

0. ✅ **QLab OSC spike** — done. Validated on real free-tier dev QLab: reply envelope shape, `-inf` = -60dB, cue-list enumeration, `/updates` push behavior + cue-id keying (not cue number — needs `cue_cache.qlab_internal_id`), `/thump` + `/udpKeepAlive` past the 61s timeout, no unlicensed-tier nag dialog. Findings captured in `test/fixtures/qlab-osc-findings.md`.
1. ✅ **Skeleton + persistence** — done. Migrations, repos, `zone-map.json` + loader, all tested against real temp SQLite files.
2. ✅ **OSC transport + protocol layer** — done. `oscClient` + `qlabProtocol` built from Phase 0 findings and live-validated; caught and fixed a real bug (`/cue/.../start`/`stop` only reply on denial, success is silent — `requestOptionalReply()`). `healthMonitor` state machine tested with fake timers and live-validated (heartbeat, keepalive, disconnect detection).
3. ✅ **Node-RED scheduling engine** — done and live-validated repeatedly: `scheduleModel`, `occurrenceCalculator` (including a real DST-collapse dedup bug found and fixed), `cronSync` (built against cron-plus's actual source — uses `expressionType: "dates"` with a computed window of upcoming timestamps, not a hand-built cron expression, since arbitrary-second intervals can't be represented in cron syntax), and `lib/index.js`'s composition root. A seeded schedule has fired repeatedly through cron-plus → real QLab playback, unattended.
4. **Zone derivation** — largely done: `zoneResolver.parseLevelsMatrix` implements the confirmed two-stage gating logic (input-fader × crosspoint), live-validated against real QLab data including the gated case. Remaining: wire `cue_cache` population into the Node-RED startup/schedule-save flow so FastAPI's read-only queries have real zone/duration data to display.
5. ✅ **Node-RED internal HTTP API** — done. Archived the pre-pivot `flows.json` to `_old/node-red-flows-dashboard2-attempt.json` (gitignored). All 13 endpoints (`schedules` CRUD+toggle+next-occurrences, `vog-messages` CRUD+toggle+trigger, `cues`, `play-now`, `health`) built as `http-in → function → http-response` chains in a new `tab_api` tab, sharing `node-red/lib/applyCronSyncDirectives.js` with the startup rebuild path. `@flowfuse/node-red-dashboard` uninstalled. `settings.js` binds `uiHost: '127.0.0.1'` (confirmed via `lsof`: loopback only). Every endpoint verified live via `curl` — full CRUD round-trips, 400/404 error paths, VOG trigger and play-now both actually played audio on QLab, and the engine's own 30s recurring fire kept working unaffected throughout.
6. **FastAPI webapp scaffold** *(new)* — `webapp/` directory per Repo Structure; `app/main.py`, `config.py`, `db/queries.py`, `node_red_client.py`; copy every file in the "Files to port from UPS-Mgmt" table above verbatim, then adapt per its notes. Verification: both processes running, `/schedules` renders an empty-state list from direct SQLite reads with Node-RED not even running yet (proving the "reads never depend on Node-RED" design point).
7. **Schedules + VOG pages** *(new)* — list/add/edit pages for both, wired to the API split above; play-now and toggle-enabled buttons. Verification: create/edit/delete/toggle round-trips correctly update SQLite *and* the live cron-plus job (confirm via Node-RED's log, same technique used throughout Phases 0-3).
8. **Queue/collision engine** — `zoneQueueEngine` end-to-end; manually verify FIFO/stale-drop with overlapping schedules; play-now and the Node-RED API's play-now endpoint both upgrade to go through it.
9. **VOG** — `vogInterruptHandler`; verify stop+play+drop-not-resume for both single-zone and all-zone VOG cues; VOG trigger endpoint upgrades from its interim stub.
10. **Health/history pages + polish** — `/status` page wired to the `python-socketio` relay (background thread polling Node-RED's `/api/health`, broadcasting to browsers), `/history` log tail, startup-gate verification (kill/relaunch QLab mid-run).
11. **Soak/reliability pass** — multi-day soak, restart-recovery checks, launchd auto-start for *both* processes (Node-RED and `uvicorn`), full integration checklist run before the production QLab Audio license purchase.

## Verification

- **Unit tests (Jest, `lib/` only, no live QLab):** `occurrenceCalculator` (interval/weekday/date-range/DST edge cases — done), `zoneResolver`'s pure matrix parser (fixture-driven — done), `zoneQueueEngine` (fake-timer: free-fires-immediately, occupied-queues, same-schedule stale-drop, cross-schedule FIFO, VOG preempt), `healthMonitor` (missed-heartbeat threshold, explicit disconnect, reconnect — done), `cronSync` (done), `scheduleModel` (done), repositories (done).
- **Node-RED internal API (hands-on via `curl`, same verification discipline used throughout Phases 0-3):** every endpoint in the Frontend Architecture table — confirm request/response shapes directly, confirm a write actually updates both SQLite and the live cron-plus job, confirm `127.0.0.1`-only binding (a request from the LAN-facing interface should fail).
- **FastAPI webapp:** unit/integration tests around `db/queries.py` (read shapes match `schedulesRepo`/etc.) and `node_red_client.py` (connect-refused → clean error envelope, not a crash); manual browser walkthrough of every page in Repo Structure's page list, since visual/UX correctness still needs a human — but with a much smaller, well-understood surface (plain Jinja2/Bootstrap/vanilla JS) than Dashboard 2.0's opaque widget internals.
- **Integration checklist (hands-on against real dev-machine QLab, not automatable):** confirm QLab's Workspace Settings → Network → OSC Controls has read/edit/control permissions enabled with no passcode (Phase 0 found this denies *every* OSC command, including basic cue triggering, when left at QLab's default — easy to forget on the production machine's workspace); OSC connectivity + keepalive past 61s; duration/levels accuracy on real cues; live cue-list enumeration; wall-clock single-schedule firing; same-zone collision via both the duration-timer path and a manually-killed cue's `/updates` path; VOG stop+play+non-resume; health-monitor disconnect/reconnect and scheduler disarm/rearm; Node-RED restart correctness (no duplicate/missing cron-plus jobs); launchd unattended auto-start for *both* processes with correct disarmed-until-confirmed behavior; and the free-tier nag-dialog risk from Phase 0.

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
- `node-red/settings.js` (add `uiHost: '127.0.0.1'`)
- `node-red/flows.json` (delete Dashboard 2.0 nodes, add the internal API tab)
- `webapp/app/main.py`, `webapp/app/node_red_client.py`, `webapp/app/db/queries.py`
- `webapp/templates/base.html`
- `/Users/ryanthompson/Documents/_dev/UPS-Mgmt/templates/base.html` and `static/js/utils/api-client.js` (reference/port source, not part of this repo)

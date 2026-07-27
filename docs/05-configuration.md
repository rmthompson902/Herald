# 05 · Configuration

Every knob in the system, in one place.

## Node-RED engine (`config/env.example`)

Copy to `.env` (or export directly). These configure the headless Node-RED engine — see
[`node-red/settings.js`](../node-red/settings.js).

| Variable | Default | Purpose |
|---|---|---|
| `QLAB_OSC_HOST` | `127.0.0.1` | QLab's OSC host |
| `QLAB_OSC_PORT` | `53000` | QLab's OSC port |
| `LOCAL_OSC_PORT` | `53001` | Local UDP port this app listens on for QLab's replies/updates |
| `DB_PATH` | `./data/schedule.db` | SQLite database file |
| `NODE_RED_API_PORT` | `1880` | Node-RED's loopback-only internal HTTP API (no dashboard UI) |

## FastAPI webapp (`webapp/.env.example`)

Typed settings via pydantic-settings, defaults in [`webapp/app/config.py`](../webapp/app/config.py).

| Variable | Default | Purpose |
|---|---|---|
| `NODE_RED_API_BASE` | `http://127.0.0.1:1880/api` | Base URL the webapp proxies writes/OSC actions to |
| `DB_PATH` | `../data/schedule.db` | SQLite file (read-only from here) |
| `EVENTS_LOG_DIR` | `../logs` | Where the event log is read from for the Settings history |
| `PORT` | `8000` | Webapp listen port |
| `LOG_LEVEL` | `INFO` | Webapp log level |
| `HEALTH_POLL_INTERVAL_SECONDS` | `2.0` | How often the health poller re-broadcasts QLab state |

The queue-visualizer poller (`queue_poll_interval_seconds`, default `0.5s`) is intentionally faster
than the health poll — connection state changes rarely, but the visualizer needs transitions
(duck, fire, free) to reach the browser fast enough to read as live. Both endpoints it backs are
cheap in-memory reads on the Node-RED side.

## Zone map (`config/audio-patch-map.json`)

The **only manual zone configuration** — it reflects fixed physical wiring, so edit it to match the
real venue before deployment. Each zone maps a QLab Messaging Audio Patch to its duck/unduck cues:

```json
{
  "zones": {
    "Zone 1": { "messagingPatchId": "1", "duckCueNumber": "1198", "unduckCueNumber": "1199" }
  }
}
```

- `messagingPatchId` — 1-based index into QLab's `/settings/audio/patchList` (matched against
  `/cue/{n}/patch`); this is what ties a cue to a zone.
- `duckCueNumber` / `unduckCueNumber` — the static per-zone QLab cues fired to duck/restore
  background music (see [03 · Domain concepts](03-domain-concepts.md#ducking)).

Edited live through the webapp's Zones admin and hot-reloaded via `core.zones.reload()` — no
Node-RED restart needed.

## SQLite schema

Created by [`lib/db/migrations/001_init.sql`](../lib/db/migrations/001_init.sql); WAL mode is on so
the webapp can read safely alongside Node-RED's writes.

- **`schedules`** — `name`, `qlab_cue_number`, `interval_seconds`, `start_time`/`end_time`,
  `weekdays` (JSON), `date_range_start`/`date_range_end`, `enabled`.
- **`vog_messages`** — `name`, `qlab_cue_number`, `enabled`. Deliberately no timing fields
  (manual-trigger only).
- **`cue_cache`** — `qlab_cue_number` (PK), `qlab_internal_id`, `cue_display_name`,
  `duration_seconds`, `zones` (JSON), `refreshed_at`. Cached-only, never authoritative.

There is **no `event_log` table** — business event history lives in `logs/events-*.log` instead
(below). The schema is exactly the durable configuration the operator edits. Live connectivity and
queue state are intentionally not persisted; both reset cleanly on restart by design.

## Logging

Two daily-rotating plain-text logs in `logs/`, both via `winston-daily-rotate-file` with **30-day**
retention (`YYYY-MM-DD` pattern):

- **`app-YYYY-MM-DD.log`** ([`lib/log/appLogger.js`](../lib/log/appLogger.js)) — application
  diagnostics for troubleshooting the system itself; one named child logger per `lib/` module.
- **`events-YYYY-MM-DD.log`** ([`lib/log/eventLogger.js`](../lib/log/eventLogger.js)) — the
  operator-facing business history: one plain-text line per domain event (`fired`, `queued`,
  `dropped_stale`, `vog_fired`, `duck_wait`, `health_disconnect`/`health_reconnect`, …). This is
  what the webapp's Settings event log reads. Both `logs/` and `data/` are gitignored.

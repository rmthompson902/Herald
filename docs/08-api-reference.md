# 08 · API reference

Two internal APIs, both loopback-only. Source of truth: the Node-RED handlers in
[`node-red/lib/handlers/`](../node-red/lib/handlers) and the webapp routers in
[`webapp/app/routers/`](../webapp/app/routers). All responses use a standard envelope
(`{ "status": "success" | "error", ... }`); the webapp's proxy passes Node-RED's HTTP status
through via an internal `_http_status`, and collapses any connection failure to a clean `503`.

## Node-RED internal API — `127.0.0.1:1880/api`

Only the webapp calls this. It handles **writes and everything needing the live OSC connection** —
there are deliberately no `GET` list endpoints for schedules/VOG here, because the webapp reads
those directly from SQLite.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | QLab connection state + `armed` flag |
| `GET` | `/cues` | Live cue list from QLab |
| `POST` | `/cues/refresh-all` | Refresh the `cue_cache` (duration/zones/display name) |
| `POST` | `/schedules` | Create (validate → store → cron sync) |
| `PUT` | `/schedules/:id` | Update |
| `DELETE` | `/schedules/:id` | Delete |
| `POST` | `/schedules/:id/toggle` | Enable/disable |
| `POST` | `/schedules/:id/play-now` | Test-fire through the queue engine |
| `POST` | `/schedules/bulk-set-enabled` | Enable/disable many at once |
| `GET` | `/schedules/next-occurrences` | Upcoming fire times (~48h window) |
| `POST` | `/vog-messages` | Create |
| `PUT` | `/vog-messages/:id` | Update |
| `DELETE` | `/vog-messages/:id` | Delete |
| `POST` | `/vog-messages/:id/toggle` | Enable/disable |
| `POST` | `/vog-messages/:id/trigger` | Fire the VOG message (armed-gated) |
| `POST` | `/vog-messages/bulk-set-enabled` | Enable/disable many at once |
| `GET` | `/zones` | List zones (from `audio-patch-map.json`) |
| `POST` | `/zones` | Add a zone |
| `PUT` | `/zones/:zoneName` | Update a zone |
| `DELETE` | `/zones/:zoneName` | Remove a zone |
| `GET` | `/zones/patches` | Available QLab Messaging Audio Patches |
| `GET` | `/zones/discover` | Suggest zone mapping from live QLab state |
| `GET` | `/queue/state` | Current per-zone occupancy + waiting entries |
| `GET` | `/queue/upcoming` | Upcoming per-zone occurrences |
| `GET` | `/queue/events` | Recent queue events (ring buffer) |

## FastAPI webapp — `127.0.0.1:8000`

**Pages** (Jinja2):

| Path | Page |
|---|---|
| `/`, `/schedules`, `/schedules/new`, `/schedules/{id}/edit` | Schedules |
| `/vog`, `/vog/new`, `/vog/{id}/edit` | VOG Messages |
| `/queues` | Zone Queue visualizer |
| `/settings`, `/zones/new`, `/zones/{zone_name}/edit` | Settings (event log, connection status, zones admin) |

**`/api/*`** — reads served straight from SQLite; writes and OSC actions proxied to Node-RED:

| Prefix | Notable routes |
|---|---|
| `/api/schedules` | `GET ""` (SQLite read), `/next-occurrences`, `POST ""`, `PUT/DELETE /{id}`, `/{id}/toggle`, `/{id}/play-now`, `/bulk-set-enabled` |
| `/api/vog-messages` | `GET ""` (SQLite read), `POST ""`, `PUT/DELETE /{id}`, `/{id}/toggle`, `/{id}/trigger`, `/bulk-set-enabled` |
| `/api/cues` | `GET ""`, `/refresh-all` |
| `/api/zones` | `GET ""`, `/patches`, `/discover`, `POST ""`, `PUT/DELETE /{zone_name}` |
| `/api/queue` | `/state`, `/upcoming` |
| `/api/history` | `/entries` (tails `events-*.log`) |

Real-time updates (health state, queue transitions, delayed-fire notifications) are **pushed over
SocketIO** by background pollers in [`webapp/app/main.py`](../webapp/app/main.py) — the browser never
talks to Node-RED directly.

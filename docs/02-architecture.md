# 02 · Architecture

The system is three cooperating processes on one Mac, all bound to loopback.

```mermaid
flowchart TB
    Browser["Operator browser"]

    subgraph Web["FastAPI webapp — 127.0.0.1:8000"]
        Pages["Pages (Jinja2) + /api proxy"]
        Poll["Background pollers → SocketIO push"]
    end

    subgraph NR["Node-RED (headless) — 127.0.0.1:1880"]
        Cron["cron-plus scheduler"]
        Engine["lib/ : queue engine, zone resolver,<br/>OSC client, health monitor"]
        API["Internal HTTP API (loopback)"]
    end

    DB[("SQLite — data/schedule.db (WAL)")]
    QLab["QLab — 127.0.0.1:53000 (OSC/UDP)"]

    Browser <-->|HTTP| Pages
    Browser <-->|SocketIO| Poll
    Pages -->|read-only| DB
    Pages -->|writes + live OSC| API
    Poll -->|poll health / queue| API
    Cron --> Engine
    API --> Engine
    Engine -->|read + write| DB
    Engine <-->|OSC| QLab
```

## Who owns what

| Process | Owns | Never does |
|---|---|---|
| **QLab** | All audio: media, cues, routing, fades, ducking cues | Scheduling, timing, collision logic |
| **Node-RED** (headless) | cron-plus scheduling, the per-zone queue engine, OSC to QLab, all SQLite **writes** | Serve any UI of its own |
| **FastAPI webapp** | The operator UI, SQLite **reads**, real-time push to the browser | Talk OSC to QLab; write to SQLite |

All non-trivial logic lives in plain, unit-testable JavaScript under [`lib/`](../lib) — the OSC
protocol, zone derivation, schedule validation, cron sync, the queue engine, VOG, and the health
monitor. Node-RED Function nodes are thin wrappers that call into it (see
[06 · Development](06-development.md) for the module map). This is the whole point of the design:
the hard logic is testable in isolation, not trapped in flow wiring.

## The read-direct / write-proxy rule

This one rule governs the FastAPI ↔ Node-RED split:

> **FastAPI reads SQLite directly (read-only) for everything displayable. Every write to
> `schedules`/`vog_messages`/zones, and everything needing the live OSC connection, is proxied to
> Node-RED.**

Reads (schedule lists, VOG lists, cached cue data) are plain read-only SQLite queries — safe
alongside Node-RED's writes thanks to WAL mode, and they don't require a second process to be up
just to render a page. Writes go through Node-RED so that schedule validation (`scheduleModel.js`)
and cron-plus synchronization (`cronSync.js`) are **single-sourced in `lib/`** and never
reimplemented in Python. Pydantic models in the webapp mirror the validation rules for instant
client-side feedback only — Node-RED remains the authority on every write.

The webapp's [`node_red_client.py`](../webapp/app/node_red_client.py) is the single place that knows
Node-RED's endpoint shapes; it collapses every connection failure to a clean 503 so a page never
hangs when Node-RED is down.

## Why headless Node-RED + a separate FastAPI app

The operator UI was originally built in Node-RED's own dashboard framework, which hit walls that
couldn't be fixed from this side. It was replaced by a **headless Node-RED engine with a small
internal JSON API** plus a separate FastAPI UI — a UI-layer swap only, with no change to any `lib/`
logic. That internal API is plain HTTP nodes bound to `127.0.0.1`, since only the co-located webapp
calls it.

## A scheduled fire, end to end

```mermaid
sequenceDiagram
    participant Cron as cron-plus
    participant NR as fn_on_due (Node-RED)
    participant H as healthMonitor
    participant Q as zoneQueueEngine
    participant QLab

    Cron->>NR: schedule due
    NR->>H: isArmed()?
    alt QLab not confirmed live
        H-->>NR: false → skip (no fire)
    else armed
        H-->>NR: true
        NR->>Q: enqueue(cue, zones, duration)
        Q->>QLab: duck zone's background music
        Q->>QLab: is this cue already running?
        QLab-->>Q: no
        Q->>QLab: /cue/{n}/start
        Note over Q,QLab: zone occupied until QLab confirms<br/>the cue stopped (or duration elapses)
        Q->>QLab: unduck once the zone's queue drains
    end
```

For the full collision/tie-break behavior behind `enqueue`, see
[04 · Queue engine](04-queue-engine.md).

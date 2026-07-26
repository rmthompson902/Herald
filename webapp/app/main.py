"""
FastAPI app entrypoint. Ties together the page routers, the JSON API
routers, static files, and the SocketIO relay that pushes QLab connection
health to every connected browser (see docs/claude-plan.md's Frontend
Architecture - "Real-time push" section).

Run with: uvicorn app.main:app --app-dir webapp --host 127.0.0.1 --port 8000
"""

import asyncio
import contextlib
import logging
from pathlib import Path

import socketio
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.node_red_client import NodeRedUnavailableError, node_red_client
from app.routers import cues_api, history_api, pages, schedules_api, status_api, vog_api, zones_api

log = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(title="Sitewide Audio Messaging")

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

app.include_router(pages.router)
app.include_router(schedules_api.router)
app.include_router(vog_api.router)
app.include_router(cues_api.router)
app.include_router(status_api.router)
app.include_router(history_api.router)
app.include_router(zones_api.router)

# SocketIO relay: the browser only ever talks to this server, never to
# Node-RED directly. Mounted at /socket.io, which is the client library's
# default connection path (see templates/base.html's `const socket = io()`).
sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins=[])
app.mount("/socket.io", socketio.ASGIApp(sio))

_last_health: dict | None = None
_poll_task: asyncio.Task | None = None
_queue_events_poll_task: asyncio.Task | None = None
_last_queue_event_at: str | None = None


async def _poll_and_broadcast_health() -> None:
    """Background poller mirroring UPS-Mgmt's daemon-thread health-polling
    pattern, adapted to an asyncio task since this app's whole I/O stack
    (httpx, SocketIO) is already async - a raw OS thread would just add a
    second event loop for no benefit here."""
    global _last_health
    while True:
        try:
            health = await node_red_client.get_health()
        except NodeRedUnavailableError:
            health = {"status": "error", "state": "disconnected", "armed": False}

        # Broad except, deliberately: only NodeRedUnavailableError (above) is an expected,
        # already-handled failure. Anything else here (a socketio hiccup, an unexpected
        # health shape) previously had nothing catching it - found via a real robustness
        # review, not a report - which silently and permanently kills this asyncio.Task the
        # first time it happens. That's not a crash launchd's KeepAlive would ever notice or
        # restart from; the process looks alive while real-time health push is just gone for
        # the rest of its life. Log and keep looping instead - never let this task die.
        try:
            if health != _last_health:
                _last_health = health
                await sio.emit("health_update", health)
        except Exception:
            log.exception("health poller: unexpected error broadcasting health_update")

        await asyncio.sleep(settings.health_poll_interval_seconds)


async def _poll_and_broadcast_queue_events() -> None:
    """A queued play-now/schedule fire reports 'queued' in its own HTTP response, but the
    actual fire can happen well after that response already went out - the operator would
    otherwise never learn whether it actually played. Polls zoneQueueEngine's recent-events
    buffer (GET /api/queue/events) and pushes a toast for:
      - any 'fired' event flagged afterQueue=true (see lib/queue/zoneQueueEngine.js), i.e.
        specifically the delayed-fire case, not every routine on-time schedule tick.
      - any 'suspected_playback_failure' event - a cue that reported "Playing" at request
        time but was confirmed stopped implausibly early relative to its own known duration
        (e.g. its Audio Patch has no live output device - QLab doesn't deny the OSC start in
        that case, so this can only be caught after the fact). This is the one case where the
        operator needs to be told something went WRONG, not just that a queued item played.
    """
    global _last_queue_event_at
    while True:
        try:
            result = await node_red_client.get_queue_events(_last_queue_event_at)
            events = result.get("events", []) if result.get("status") == "success" else []
        except NodeRedUnavailableError:
            events = []

        # Broad except per-event, deliberately: an unexpected/malformed single event (or a
        # socketio hiccup mid-emit) must not be able to permanently kill this task and take
        # the delayed-fire and playback-failure notifications down with it for the rest of
        # the process's life - same reasoning as _poll_and_broadcast_health above. One bad
        # event is skipped and logged; the loop (and every event after it) keeps going.
        for event in events:
            _last_queue_event_at = event["at"]
            try:
                entry = event["entry"]
                extra = event.get("extra") or {}

                if event["event"] == "fired" and extra.get("afterQueue"):
                    await sio.emit(
                        "queue_notification",
                        {
                            "message": f"{entry.get('name') or entry['cueNumber']} is now playing "
                            f"(cue {entry['cueNumber']}) - it was waiting for the zone to clear",
                        },
                    )
                elif event["event"] == "suspected_playback_failure":
                    elapsed_s = round(extra.get("elapsedMs", 0) / 1000, 1)
                    await sio.emit(
                        "playback_failure",
                        {
                            "message": f"{entry.get('name') or entry['cueNumber']} (cue {entry['cueNumber']}) "
                            f"in {extra.get('zone', 'its zone')} stopped after only {elapsed_s}s - it "
                            "likely did not actually play. Check that zone's audio output device.",
                        },
                    )
            except Exception:
                log.exception("queue events poller: unexpected error handling event %r", event)

        await asyncio.sleep(settings.health_poll_interval_seconds)


@app.on_event("startup")
async def start_health_poller() -> None:
    global _poll_task, _queue_events_poll_task
    _poll_task = asyncio.create_task(_poll_and_broadcast_health())
    _queue_events_poll_task = asyncio.create_task(_poll_and_broadcast_queue_events())


@app.on_event("shutdown")
async def stop_health_poller() -> None:
    for task in (_poll_task, _queue_events_poll_task):
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

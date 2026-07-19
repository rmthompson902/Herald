"""
FastAPI app entrypoint. Ties together the page routers, the JSON API
routers, static files, and the SocketIO relay that pushes QLab connection
health to every connected browser (see docs/claude-plan.md's Frontend
Architecture - "Real-time push" section).

Run with: uvicorn app.main:app --app-dir webapp --host 127.0.0.1 --port 8000
"""

import asyncio
import contextlib
from pathlib import Path

import socketio
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.node_red_client import NodeRedUnavailableError, node_red_client
from app.routers import cues_api, pages, schedules_api, status_api, vog_api

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(title="Sitewide Audio Messaging")

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

app.include_router(pages.router)
app.include_router(schedules_api.router)
app.include_router(vog_api.router)
app.include_router(cues_api.router)
app.include_router(status_api.router)

# SocketIO relay: the browser only ever talks to this server, never to
# Node-RED directly. Mounted at /socket.io, which is the client library's
# default connection path (see templates/base.html's `const socket = io()`).
sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins=[])
app.mount("/socket.io", socketio.ASGIApp(sio))

_last_health: dict | None = None
_poll_task: asyncio.Task | None = None


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

        if health != _last_health:
            _last_health = health
            await sio.emit("health_update", health)

        await asyncio.sleep(settings.health_poll_interval_seconds)


@app.on_event("startup")
async def start_health_poller() -> None:
    global _poll_task
    _poll_task = asyncio.create_task(_poll_and_broadcast_health())


@app.on_event("shutdown")
async def stop_health_poller() -> None:
    if _poll_task is not None:
        _poll_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await _poll_task

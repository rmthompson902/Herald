"""The three background pollers in main.py must never die on an unexpected error - a dead
asyncio.Task looks alive to launchd while real-time push is silently gone for the rest of the
process's life (a real past bug). These run a poller briefly and assert it's still alive."""

import asyncio

import pytest

from app import main


async def _run_briefly(coro_fn):
    task = asyncio.create_task(coro_fn())
    await asyncio.sleep(0.05)
    still_running = not task.done()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    return still_running


async def test_health_poller_survives_a_broadcast_error(monkeypatch):
    monkeypatch.setattr(main.settings, "health_poll_interval_seconds", 0.01)
    monkeypatch.setattr(main, "_last_health", None)

    async def ok_health():
        return {"state": "connected", "armed": True}

    emitted = {"n": 0}

    async def bad_emit(event, data):
        emitted["n"] += 1
        raise RuntimeError("socket layer blew up")

    monkeypatch.setattr(main.node_red_client, "get_health", ok_health)
    monkeypatch.setattr(main.sio, "emit", bad_emit)

    still_running = await _run_briefly(main._poll_and_broadcast_health)
    assert still_running  # the emit exception was caught, the loop kept going
    assert emitted["n"] >= 1  # and it genuinely attempted the broadcast


async def test_health_poller_survives_node_red_unavailable(monkeypatch):
    monkeypatch.setattr(main.settings, "health_poll_interval_seconds", 0.01)
    monkeypatch.setattr(main, "_last_health", None)

    async def down():
        raise main.NodeRedUnavailableError("refused")

    emitted = []

    async def emit(event, data):
        emitted.append(data)

    monkeypatch.setattr(main.node_red_client, "get_health", down)
    monkeypatch.setattr(main.sio, "emit", emit)

    still_running = await _run_briefly(main._poll_and_broadcast_health)
    assert still_running
    # NodeRedUnavailableError is handled by substituting a disconnected snapshot, which is
    # still broadcast so browsers see the outage.
    assert emitted and emitted[0]["state"] == "disconnected"


async def test_queue_events_poller_skips_a_malformed_event_and_keeps_going(monkeypatch):
    monkeypatch.setattr(main.settings, "queue_poll_interval_seconds", 0.01)
    monkeypatch.setattr(main, "_last_queue_event_at", None)

    events = [
        {"at": "t1"},  # malformed - no "entry"/"event" keys; must be skipped, not fatal
        {
            "at": "t2",
            "event": "fired",
            "entry": {"cueNumber": "1101", "name": "Safety"},
            "extra": {"afterQueue": True},
        },
    ]
    calls = {"n": 0}

    async def get_events(since=None):
        calls["n"] += 1
        return {"status": "success", "events": events if calls["n"] == 1 else []}

    emitted = []

    async def emit(event, data):
        emitted.append(event)

    monkeypatch.setattr(main.node_red_client, "get_queue_events", get_events)
    monkeypatch.setattr(main.sio, "emit", emit)

    still_running = await _run_briefly(main._poll_and_broadcast_queue_events)
    assert still_running
    # The good event still produced its raw relay + the delayed-fire toast, despite the
    # malformed one raising (and being swallowed) first.
    assert "queue_event" in emitted
    assert "queue_notification" in emitted

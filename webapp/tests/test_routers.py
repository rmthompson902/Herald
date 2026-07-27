"""Router behavior: reads come straight from SQLite; writes proxy to Node-RED and surface its
status; a NodeRedUnavailableError becomes a clean 503; bad input is a 400 before any proxy.

TestClient is constructed WITHOUT a `with` block on purpose - that skips the app's lifespan,
so the background pollers (which would hit a real Node-RED) never start."""

from fastapi.testclient import TestClient

from app.main import app
from app.node_red_client import NodeRedUnavailableError, node_red_client

client = TestClient(app)


def test_list_schedules_reads_directly_from_sqlite(seeded_db):
    resp = client.get("/api/schedules")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "success"
    assert [s["qlabCueNumber"] for s in body["schedules"]] == ["1101"]


def test_create_schedule_proxies_and_carries_node_red_status(monkeypatch):
    async def fake_create(data):
        return {"status": "success", "schedule": data, "_http_status": 201}

    monkeypatch.setattr(node_red_client, "create_schedule", fake_create)
    resp = client.post(
        "/api/schedules",
        json={"name": "Safety", "qlab_cue_number": "1101", "interval_seconds": 60},
    )
    assert resp.status_code == 201
    assert resp.json()["status"] == "success"


def test_create_schedule_rejects_bad_input_before_proxying(monkeypatch):
    called = {"n": 0}

    async def fake_create(data):
        called["n"] += 1
        return {}

    monkeypatch.setattr(node_red_client, "create_schedule", fake_create)
    resp = client.post("/api/schedules", json={"name": "", "qlab_cue_number": "1101", "interval_seconds": 60})
    assert resp.status_code == 400
    assert resp.json()["status"] == "error"
    assert called["n"] == 0  # never proxied - validation failed first


def test_create_schedule_maps_node_red_unavailable_to_503(monkeypatch):
    async def boom(data):
        raise NodeRedUnavailableError("connection refused")

    monkeypatch.setattr(node_red_client, "create_schedule", boom)
    resp = client.post(
        "/api/schedules",
        json={"name": "Safety", "qlab_cue_number": "1101", "interval_seconds": 60},
    )
    assert resp.status_code == 503
    assert resp.json()["status"] == "error"


def test_proxied_read_degrades_to_503_when_node_red_down(monkeypatch):
    async def boom():
        raise NodeRedUnavailableError("down")

    monkeypatch.setattr(node_red_client, "get_zones", boom)
    resp = client.get("/api/zones")
    assert resp.status_code == 503
    assert resp.json()["status"] == "error"


def test_trigger_vog_carries_node_red_400_for_disabled_message(monkeypatch):
    async def fake_trigger(vog_id):
        return {"status": "error", "message": "VOG message is disabled", "_http_status": 400}

    monkeypatch.setattr(node_red_client, "trigger_vog_message", fake_trigger)
    resp = client.post("/api/vog-messages/1/trigger")
    assert resp.status_code == 400
    assert resp.json()["message"] == "VOG message is disabled"

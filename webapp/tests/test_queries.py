"""Read-shape parity: db/queries.py must return the same camelCase / JSON-decoded shapes the
JS repos do (lib/db/repositories/*.js), so templates and the API share one mental model."""

from app.db import queries


def test_list_schedules_shape(seeded_db):
    rows = queries.list_schedules()
    assert len(rows) == 1
    s = rows[0]
    assert s["qlabCueNumber"] == "1101"
    assert s["intervalSeconds"] == 60
    assert s["weekdays"] == [1, 2, 3, 4, 5]  # JSON-decoded to a list, not the raw string
    assert s["enabled"] is True  # coerced to bool, not 1
    assert s["startTime"] == "09:00"


def test_get_schedule_and_missing(seeded_db):
    rows = queries.list_schedules()
    got = queries.get_schedule(rows[0]["id"])
    assert got["name"] == "Lobby Safety"
    assert queries.get_schedule(999999) is None


def test_vog_message_shape(seeded_db):
    rows = queries.list_vog_messages()
    assert len(rows) == 1
    v = rows[0]
    assert v["qlabCueNumber"] == "1104"
    assert v["enabled"] is False  # seeded disabled, coerced to bool
    assert queries.get_vog_message(999999) is None


def test_cue_cache_shape(seeded_db):
    cue = queries.get_cue_cache("1101")
    assert cue["cueDisplayName"] == "Message 1"
    assert cue["durationSeconds"] == 5.0
    assert cue["zones"] == ["Zone 1"]  # JSON-decoded list
    assert cue["qlabInternalId"] == "uid-1101"
    assert queries.get_cue_cache("nope") is None


def test_cue_cache_null_zones_decodes_to_empty_list(seeded_db):
    import sqlite3

    conn = sqlite3.connect(seeded_db)
    conn.execute(
        "INSERT INTO cue_cache (qlab_cue_number, zones, refreshed_at) VALUES (?,?,?)",
        ("2101", None, "2026-01-01T00:00:00Z"),
    )
    conn.commit()
    conn.close()
    cue = queries.get_cue_cache("2101")
    assert cue["zones"] == []  # NULL zones -> [], never None (matches the JS repo)

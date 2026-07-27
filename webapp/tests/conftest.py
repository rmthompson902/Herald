"""Shared fixtures for the webapp test suite."""

import pathlib
import sqlite3

import pytest

from app.config import settings

MIGRATION_SQL = pathlib.Path(__file__).resolve().parents[2] / "lib" / "db" / "migrations" / "001_init.sql"


@pytest.fixture
def seeded_db(tmp_path, monkeypatch):
    """A throwaway SQLite DB built from the real migration and seeded with one schedule, one
    (disabled) VOG message, and one cue_cache row. Points app.config.settings.db_path at it so
    the read-only queries module (which opens a fresh connection per call) reads this file."""
    db_path = tmp_path / "test.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(MIGRATION_SQL.read_text())
    conn.execute(
        """INSERT INTO schedules
           (name, qlab_cue_number, interval_seconds, start_time, end_time, weekdays,
            date_range_start, date_range_end, enabled, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            "Lobby Safety",
            "1101",
            60,
            "09:00",
            "17:00",
            "[1,2,3,4,5]",
            None,
            None,
            1,
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        ),
    )
    conn.execute(
        """INSERT INTO vog_messages (name, qlab_cue_number, enabled, created_at, updated_at)
           VALUES (?,?,?,?,?)""",
        ("Evacuation", "1104", 0, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
    )
    conn.execute(
        """INSERT INTO cue_cache
           (qlab_cue_number, qlab_internal_id, cue_display_name, duration_seconds, zones, refreshed_at)
           VALUES (?,?,?,?,?,?)""",
        ("1101", "uid-1101", "Message 1", 5.0, '["Zone 1"]', "2026-01-01T00:00:00Z"),
    )
    conn.commit()
    conn.close()

    monkeypatch.setattr(settings, "db_path", str(db_path))
    return db_path

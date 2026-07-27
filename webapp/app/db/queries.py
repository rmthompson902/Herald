"""
Read-only SQLite access for the browser-facing app. Mirrors the read shapes
of lib/db/repositories/{schedulesRepo,vogMessagesRepo,cueCacheRepo}.js field
for field (camelCase keys, weekdays/zones JSON-decoded) so templates and the
JSON API never need a second mental model of "what a schedule looks like".

No writes happen here, ever - every write goes through Node-RED via
node_red_client.py so validateSchedule/cronSync stay single-sourced (see
docs/02-architecture.md). Opened as a fresh read-only
connection per call: cheap with SQLite, and safe to run alongside Node-RED's
WAL-mode writer process from a second process/language.
"""

import json
import sqlite3
from typing import Any

from app.config import settings


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{settings.db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _schedule_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "qlabCueNumber": row["qlab_cue_number"],
        "intervalSeconds": row["interval_seconds"],
        "startTime": row["start_time"],
        "endTime": row["end_time"],
        "weekdays": json.loads(row["weekdays"]),
        "dateRangeStart": row["date_range_start"],
        "dateRangeEnd": row["date_range_end"],
        "enabled": bool(row["enabled"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _vog_message_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "qlabCueNumber": row["qlab_cue_number"],
        "enabled": bool(row["enabled"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _cue_cache_from_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "qlabCueNumber": row["qlab_cue_number"],
        "qlabInternalId": row["qlab_internal_id"],
        "cueDisplayName": row["cue_display_name"],
        "durationSeconds": row["duration_seconds"],
        "zones": json.loads(row["zones"]) if row["zones"] else [],
        "refreshedAt": row["refreshed_at"],
    }


def list_schedules() -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM schedules ORDER BY id").fetchall()
        return [_schedule_from_row(row) for row in rows]


def get_schedule(schedule_id: int) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM schedules WHERE id = ?", (schedule_id,)).fetchone()
        return _schedule_from_row(row) if row else None


def list_vog_messages() -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM vog_messages ORDER BY id").fetchall()
        return [_vog_message_from_row(row) for row in rows]


def get_vog_message(vog_id: int) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM vog_messages WHERE id = ?", (vog_id,)).fetchone()
        return _vog_message_from_row(row) if row else None


def get_cue_cache(qlab_cue_number: str) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM cue_cache WHERE qlab_cue_number = ?", (qlab_cue_number,)).fetchone()
        return _cue_cache_from_row(row) if row else None


def list_cue_cache() -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM cue_cache ORDER BY qlab_cue_number").fetchall()
        return [_cue_cache_from_row(row) for row in rows]

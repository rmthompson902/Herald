"""
Browser-facing schedule API. Reads go straight to SQLite (db/queries.py);
every write proxies to Node-RED so validateSchedule + cronSync.syncOne stay
single-sourced there (see Frontend Architecture in docs/claude-plan.md).
"""

from fastapi import APIRouter
from pydantic import ValidationError

from app.db import queries
from app.models.schedule import ScheduleRequest
from app.node_red_client import NodeRedUnavailableError, node_red_client
from app.responses import error_response, from_node_red_result, validation_error

router = APIRouter(prefix="/api/schedules", tags=["schedules"])


@router.get("")
async def list_schedules():
    return {"status": "success", "schedules": queries.list_schedules()}


@router.get("/next-occurrences")
async def next_occurrences():
    # Registered before the /{schedule_id} routes below so Starlette's route
    # matching can't ever treat "next-occurrences" as a schedule_id.
    try:
        result = await node_red_client.next_occurrences()
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)


@router.post("/bulk-set-enabled")
async def bulk_set_enabled(payload: dict):
    # Registered before the /{schedule_id} routes below so Starlette's route matching
    # can't ever treat "bulk-set-enabled" as a schedule_id (same reasoning as
    # next_occurrences() above).
    enabled = bool(payload.get("enabled"))
    try:
        result = await node_red_client.bulk_set_enabled_schedules(enabled)
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)


@router.post("")
async def create_schedule(payload: dict):
    try:
        schedule = ScheduleRequest(**payload)
    except ValidationError as exc:
        return validation_error(str(exc))

    try:
        result = await node_red_client.create_schedule(schedule.to_node_red_payload())
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)


@router.put("/{schedule_id}")
async def update_schedule(schedule_id: int, payload: dict):
    try:
        schedule = ScheduleRequest(**payload)
    except ValidationError as exc:
        return validation_error(str(exc))

    try:
        result = await node_red_client.update_schedule(schedule_id, schedule.to_node_red_payload())
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)


@router.delete("/{schedule_id}")
async def delete_schedule(schedule_id: int):
    try:
        result = await node_red_client.delete_schedule(schedule_id)
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)


@router.post("/{schedule_id}/toggle")
async def toggle_schedule(schedule_id: int):
    try:
        result = await node_red_client.toggle_schedule(schedule_id)
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)


@router.post("/{schedule_id}/play-now")
async def play_now(schedule_id: int):
    try:
        result = await node_red_client.play_now(schedule_id)
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)

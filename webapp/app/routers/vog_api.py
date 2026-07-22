"""
Browser-facing VOG (Voice of God / emergency) message API. Same read-direct/
write-proxied split as schedules_api.py.
"""

from fastapi import APIRouter
from pydantic import ValidationError

from app.db import queries
from app.models.vog import VogMessageRequest
from app.node_red_client import NodeRedUnavailableError, node_red_client
from app.responses import error_response, from_node_red_result, validation_error

router = APIRouter(prefix="/api/vog-messages", tags=["vog"])


@router.get("")
async def list_vog_messages():
    return {"status": "success", "vogMessages": queries.list_vog_messages()}


@router.post("/bulk-set-enabled")
async def bulk_set_enabled(payload: dict):
    # Registered before the /{vog_id} routes below so Starlette's route matching can't
    # ever treat "bulk-set-enabled" as a vog_id.
    enabled = bool(payload.get("enabled"))
    try:
        result = await node_red_client.bulk_set_enabled_vog_messages(enabled)
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)


@router.post("")
async def create_vog_message(payload: dict):
    try:
        vog_message = VogMessageRequest(**payload)
    except ValidationError as exc:
        return validation_error(str(exc))

    try:
        result = await node_red_client.create_vog_message(vog_message.to_node_red_payload())
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)


@router.put("/{vog_id}")
async def update_vog_message(vog_id: int, payload: dict):
    try:
        vog_message = VogMessageRequest(**payload)
    except ValidationError as exc:
        return validation_error(str(exc))

    try:
        result = await node_red_client.update_vog_message(vog_id, vog_message.to_node_red_payload())
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)


@router.delete("/{vog_id}")
async def delete_vog_message(vog_id: int):
    try:
        result = await node_red_client.delete_vog_message(vog_id)
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)


@router.post("/{vog_id}/toggle")
async def toggle_vog_message(vog_id: int):
    try:
        result = await node_red_client.toggle_vog_message(vog_id)
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)


@router.post("/{vog_id}/trigger")
async def trigger_vog_message(vog_id: int):
    try:
        result = await node_red_client.trigger_vog_message(vog_id)
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)

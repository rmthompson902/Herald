"""
Browser-facing zones API. Unlike schedules/VOG, zones have no SQLite row at all -
config/audio-patch-map.json is the sole source of truth, and Node-RED's in-memory
patchToZone/zoneConfig (kept live via core.zones.reload()) is the freshest view of it -
so every zones_api route proxies to Node-RED, including plain reads.
"""

from fastapi import APIRouter
from pydantic import ValidationError

from app.models.zone import ZoneRequest
from app.node_red_client import NodeRedUnavailableError, node_red_client
from app.responses import error_response, from_node_red_result, validation_error

router = APIRouter(prefix="/api/zones", tags=["zones"])


@router.get("")
async def list_zones():
    try:
        result = await node_red_client.get_zones()
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)


@router.get("/patches")
async def list_patches():
    # Registered before /{zone_name}-shaped routes below so Starlette's route matching
    # can't ever treat "patches" as a zone name (same reasoning as schedules_api.py's
    # next-occurrences/bulk-set-enabled routes).
    try:
        result = await node_red_client.get_zone_patches()
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)


@router.get("/discover")
async def discover(cueNumber: str):
    try:
        result = await node_red_client.discover_zone(cueNumber)
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)


@router.post("")
async def create_zone(payload: dict):
    try:
        zone = ZoneRequest(**payload)
    except ValidationError as exc:
        return validation_error(str(exc))

    try:
        result = await node_red_client.create_zone(zone.to_node_red_payload())
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)


@router.put("/{zone_name}")
async def update_zone(zone_name: str, payload: dict):
    try:
        zone = ZoneRequest(zone_name=zone_name, **payload)
    except ValidationError as exc:
        return validation_error(str(exc))

    try:
        result = await node_red_client.update_zone(zone_name, zone.to_node_red_payload())
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)


@router.delete("/{zone_name}")
async def delete_zone(zone_name: str):
    try:
        result = await node_red_client.delete_zone(zone_name)
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)

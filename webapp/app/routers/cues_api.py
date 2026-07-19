"""Live QLab cue browsing - always proxied, this needs the live OSC socket."""

from fastapi import APIRouter

from app.node_red_client import NodeRedUnavailableError, node_red_client
from app.responses import error_response, from_node_red_result

router = APIRouter(prefix="/api/cues", tags=["cues"])


@router.get("")
async def list_cues():
    try:
        result = await node_red_client.list_cues()
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)

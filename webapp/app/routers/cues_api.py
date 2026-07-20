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


@router.post("/refresh-all")
async def refresh_all_cues():
    """Re-reads every cue referenced by any schedule/VOG message live from
    QLab into cue_cache - the manual complement to Node-RED's periodic
    5-minute background sweep. Wired to the global "Refresh Cue Data" button
    in the page header (see partials/components/page_header.html)."""
    try:
        result = await node_red_client.refresh_all_cues()
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)

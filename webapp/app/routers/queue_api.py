"""
Browser-facing queue API for the zone queue visualizer (/queue). Thin proxy to
Node-RED's GET /api/queue/state and GET /api/queue/upcoming - same shape as
zones_api.py. Real-time updates for the page itself arrive over SocketIO (see
main.py's _poll_and_broadcast_queue_state/_poll_and_broadcast_queue_events); these
two routes only serve the page's initial load and the infinite-scroll "load next
batch" requests.
"""

from fastapi import APIRouter

from app.node_red_client import NodeRedUnavailableError, node_red_client
from app.responses import error_response, from_node_red_result

router = APIRouter(prefix="/api/queue", tags=["queue"])


@router.get("/state")
async def get_state():
    try:
        result = await node_red_client.get_queue_state()
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)


@router.get("/upcoming")
async def get_upcoming(zone: str, offset: int = 0, count: int = 25):
    try:
        result = await node_red_client.get_zone_upcoming(zone, offset, count)
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)

"""
QLab connection / scheduler-armed status. The page itself gets this pushed
over SocketIO by the background poller in main.py; this endpoint exists as
the one-shot fetch the page uses on first load, before the first push
arrives (see docs/claude-plan.md's real-time push section).
"""

from fastapi import APIRouter

from app.node_red_client import NodeRedUnavailableError, node_red_client
from app.responses import error_response, from_node_red_result

router = APIRouter(prefix="/api/status", tags=["status"])


@router.get("")
async def get_status():
    try:
        result = await node_red_client.get_health()
    except NodeRedUnavailableError as exc:
        return error_response(str(exc), code=503)
    return from_node_red_result(result)

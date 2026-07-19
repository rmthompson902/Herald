"""
Standardized JSON response envelope for this app's /api/* routes, ported
from UPS-Mgmt's response_helpers.py (see docs/claude-plan.md's file-copy
table). Keeps success/error shape identical across this app and Node-RED's
own internal API, so static/js/utils/api-client.js's handleResponse() works
against both without special-casing.
"""

from typing import Any, Optional

from fastapi.responses import JSONResponse


def success_response(message: str, data: Optional[dict] = None, code: int = 200) -> JSONResponse:
    body: dict[str, Any] = {"status": "success", "message": message}
    if data:
        body.update(data)
    return JSONResponse(content=body, status_code=code)


def error_response(message: str, code: int = 500) -> JSONResponse:
    return JSONResponse(content={"status": "error", "message": message}, status_code=code)


def validation_error(message: str, code: int = 400) -> JSONResponse:
    return JSONResponse(content={"status": "error", "message": message}, status_code=code)


def api_response(success: bool, message: str, data: Optional[dict] = None, code: Optional[int] = None) -> JSONResponse:
    if success:
        return success_response(message, data, code or 200)
    return error_response(message, code or 500)


def from_node_red_result(result: dict) -> JSONResponse:
    """Turn a node_red_client response dict back into a JSONResponse carrying
    Node-RED's own HTTP status code (e.g. a 400/404 from validateSchedule),
    rather than flattening every proxied call to 200."""
    body = dict(result)
    status_code = body.pop("_http_status", 200)
    return JSONResponse(content=body, status_code=status_code)

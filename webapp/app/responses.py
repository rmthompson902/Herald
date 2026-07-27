"""
Standardized JSON response envelope for this app's /api/* routes. Keeps the
success/error shape identical to Node-RED's own internal API, so
static/js/utils/api-client.js's handleResponse() works against both without
special-casing.
"""

from fastapi.responses import JSONResponse


def error_response(message: str, code: int = 500) -> JSONResponse:
    return JSONResponse(content={"status": "error", "message": message}, status_code=code)


def validation_error(message: str, code: int = 400) -> JSONResponse:
    return JSONResponse(content={"status": "error", "message": message}, status_code=code)


def from_node_red_result(result: dict) -> JSONResponse:
    """Turn a node_red_client response dict back into a JSONResponse carrying
    Node-RED's own HTTP status code (e.g. a 400/404 from validateSchedule),
    rather than flattening every proxied call to 200."""
    body = dict(result)
    status_code = body.pop("_http_status", 200)
    return JSONResponse(content=body, status_code=status_code)

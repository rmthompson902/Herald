"""node_red_client contract: every httpx failure mode collapses to NodeRedUnavailableError
(the promise its docstring makes to every caller), Node-RED's own HTTP status passes through
via _http_status, and a non-JSON body degrades to a clean error envelope instead of throwing."""

import httpx
import pytest
import respx

from app.node_red_client import NodeRedClient, NodeRedUnavailableError

BASE = "http://nr"


async def test_success_body_passes_through_with_http_status():
    with respx.mock(base_url=BASE) as mock:
        mock.get("/health").mock(
            return_value=httpx.Response(200, json={"status": "success", "state": "connected", "armed": True})
        )
        body = await NodeRedClient(base_url=BASE).get_health()
    assert body["armed"] is True
    assert body["_http_status"] == 200


async def test_node_red_error_status_passes_through():
    with respx.mock(base_url=BASE) as mock:
        mock.post("/schedules").mock(
            return_value=httpx.Response(400, json={"status": "error", "message": "name is required"})
        )
        body = await NodeRedClient(base_url=BASE).create_schedule({})
    assert body["_http_status"] == 400
    assert body["message"] == "name is required"


async def test_connect_refused_becomes_unavailable():
    with respx.mock(base_url=BASE) as mock:
        mock.get("/health").mock(side_effect=httpx.ConnectError("connection refused"))
        with pytest.raises(NodeRedUnavailableError):
            await NodeRedClient(base_url=BASE).get_health()


async def test_timeout_also_becomes_unavailable():
    # A different httpx.HTTPError subtype than ConnectError - proves the base-class catch, not
    # a hand-enumerated list of two subtypes (the bug the current code fixed).
    with respx.mock(base_url=BASE) as mock:
        mock.get("/health").mock(side_effect=httpx.ReadTimeout("too slow"))
        with pytest.raises(NodeRedUnavailableError):
            await NodeRedClient(base_url=BASE).get_health()


async def test_non_json_body_falls_back_to_error_envelope():
    with respx.mock(base_url=BASE) as mock:
        mock.get("/health").mock(return_value=httpx.Response(502, text="<html>Bad Gateway</html>"))
        body = await NodeRedClient(base_url=BASE).get_health()
    assert body["status"] == "error"
    assert "Bad Gateway" in body["message"]
    assert body["_http_status"] == 502

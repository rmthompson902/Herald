"""
Thin async wrapper around Node-RED's internal HTTP API (see the endpoint
table in docs/claude-plan.md's Frontend Architecture section). This is the
ONE place that knows Node-RED's endpoint shapes - routers never build
Node-RED URLs themselves. Every write to schedules/vog_messages and
everything needing the live OSC connection goes through here; connect-
refused (Node-RED not running) is handled gracefully and never raised as an
unhandled exception up into a router.
"""

from typing import Any, Optional

import httpx

from app.config import settings


class NodeRedUnavailableError(Exception):
    """Raised when Node-RED's internal API can't be reached at all."""


class NodeRedClient:
    def __init__(self, base_url: Optional[str] = None, timeout: float = 10.0) -> None:
        self._base_url = (base_url or settings.node_red_api_base).rstrip("/")
        self._timeout = timeout

    async def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        url = f"{self._base_url}{path}"
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                response = await client.request(method, url, **kwargs)
        except httpx.ConnectError as exc:
            raise NodeRedUnavailableError(f"Node-RED is unreachable at {url}") from exc
        except httpx.TimeoutException as exc:
            raise NodeRedUnavailableError(f"Node-RED timed out at {url}") from exc

        try:
            body = response.json()
        except ValueError:
            body = {"status": "error", "message": response.text}

        if isinstance(body, dict):
            body.setdefault("_http_status", response.status_code)
        return body

    # Schedules
    async def create_schedule(self, data: dict) -> dict:
        return await self._request("POST", "/schedules", json=data)

    async def update_schedule(self, schedule_id: int, data: dict) -> dict:
        return await self._request("PUT", f"/schedules/{schedule_id}", json=data)

    async def delete_schedule(self, schedule_id: int) -> dict:
        return await self._request("DELETE", f"/schedules/{schedule_id}")

    async def toggle_schedule(self, schedule_id: int) -> dict:
        return await self._request("POST", f"/schedules/{schedule_id}/toggle")

    async def play_now(self, schedule_id: int) -> dict:
        return await self._request("POST", f"/schedules/{schedule_id}/play-now")

    async def next_occurrences(self) -> dict:
        return await self._request("GET", "/schedules/next-occurrences")

    # VOG messages
    async def create_vog_message(self, data: dict) -> dict:
        return await self._request("POST", "/vog-messages", json=data)

    async def update_vog_message(self, vog_id: int, data: dict) -> dict:
        return await self._request("PUT", f"/vog-messages/{vog_id}", json=data)

    async def delete_vog_message(self, vog_id: int) -> dict:
        return await self._request("DELETE", f"/vog-messages/{vog_id}")

    async def toggle_vog_message(self, vog_id: int) -> dict:
        return await self._request("POST", f"/vog-messages/{vog_id}/toggle")

    async def trigger_vog_message(self, vog_id: int) -> dict:
        return await self._request("POST", f"/vog-messages/{vog_id}/trigger")

    # Cues + health
    async def list_cues(self) -> dict:
        return await self._request("GET", "/cues")

    async def refresh_all_cues(self) -> dict:
        return await self._request("POST", "/cues/refresh-all")

    async def get_health(self) -> dict:
        return await self._request("GET", "/health")


node_red_client = NodeRedClient()

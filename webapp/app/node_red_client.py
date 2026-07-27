"""
Thin async wrapper around Node-RED's internal HTTP API (see the endpoint
table in docs/08-api-reference.md). This is the
ONE place that knows Node-RED's endpoint shapes - routers never build
Node-RED URLs themselves. Every write to schedules/vog_messages and
everything needing the live OSC connection goes through here; connect-
refused (Node-RED not running) is handled gracefully and never raised as an
unhandled exception up into a router.
"""

from typing import Any
from urllib.parse import quote

import httpx

from app.config import settings


class NodeRedUnavailableError(Exception):
    """Raised when Node-RED's internal API can't be reached at all."""


class NodeRedClient:
    def __init__(self, base_url: str | None = None, timeout: float = 10.0) -> None:
        self._base_url = (base_url or settings.node_red_api_base).rstrip("/")
        self._timeout = timeout

    async def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        url = f"{self._base_url}{path}"
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                response = await client.request(method, url, **kwargs)
        # httpx.HTTPError is the base class for every network/protocol-level failure
        # (connect-refused, timeout, a reset connection, a malformed response, ...) - found
        # via a real robustness review that this previously only caught two of many concrete
        # subtypes (ConnectError, TimeoutException), despite this method's own docstring
        # promising every caller that connect-refused "is handled gracefully and never raised
        # as an unhandled exception up into a router." Any other httpx failure fell straight
        # through that promise uncaught - notably into the background pollers in main.py,
        # where an uncaught exception permanently kills that asyncio.Task with nothing to
        # notice or restart it. Catching the base class here, once, is correct because every
        # one of these concrete failure modes means the exact same thing to every caller:
        # "couldn't complete this call to Node-RED right now."
        except httpx.HTTPError as exc:
            raise NodeRedUnavailableError(f"Node-RED request to {url} failed: {exc}") from exc

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

    async def bulk_set_enabled_schedules(self, enabled: bool) -> dict:
        return await self._request("POST", "/schedules/bulk-set-enabled", json={"enabled": enabled})

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

    async def bulk_set_enabled_vog_messages(self, enabled: bool) -> dict:
        return await self._request("POST", "/vog-messages/bulk-set-enabled", json={"enabled": enabled})

    async def trigger_vog_message(self, vog_id: int) -> dict:
        return await self._request("POST", f"/vog-messages/{vog_id}/trigger")

    # Cues + health
    async def list_cues(self) -> dict:
        return await self._request("GET", "/cues")

    async def refresh_all_cues(self) -> dict:
        return await self._request("POST", "/cues/refresh-all")

    async def get_health(self) -> dict:
        return await self._request("GET", "/health")

    async def get_queue_events(self, since: str | None = None) -> dict:
        params = {"since": since} if since else None
        return await self._request("GET", "/queue/events", params=params)

    async def get_queue_state(self) -> dict:
        return await self._request("GET", "/queue/state")

    async def get_zone_upcoming(self, zone: str, offset: int = 0, count: int = 25) -> dict:
        return await self._request("GET", "/queue/upcoming", params={"zone": zone, "offset": offset, "count": count})

    # Zones (see lib/zones/audioPatchMap.js) - the only manual config in the system. Every
    # write here hot-reloads Node-RED's in-memory zone config immediately (core.zones.reload()),
    # no restart needed.
    async def get_zones(self) -> dict:
        return await self._request("GET", "/zones")

    async def get_zone_patches(self) -> dict:
        return await self._request("GET", "/zones/patches")

    async def discover_zone(self, cue_number: str) -> dict:
        return await self._request("GET", "/zones/discover", params={"cueNumber": cue_number})

    async def create_zone(self, data: dict) -> dict:
        return await self._request("POST", "/zones", json=data)

    async def update_zone(self, zone_name: str, data: dict) -> dict:
        return await self._request("PUT", f"/zones/{quote(zone_name, safe='')}", json=data)

    async def delete_zone(self, zone_name: str) -> dict:
        return await self._request("DELETE", f"/zones/{quote(zone_name, safe='')}")


node_red_client = NodeRedClient()

"""
Reads config/audio-patch-map.json directly - the one authoritative "what zones
exist in this venue" list (mirrors lib/zones/audioPatchMap.js's loader on the
Node-RED side). Used only to know how many per-zone tables to draw on the
schedules page; the webapp never needs the patch ids or duck/unduck cue
numbers, only the zone names themselves, in their configured order.

Best-effort: if the file is missing or malformed, the schedules page should
still render (falling back to zero configured zones, so every schedule shows
up under "Not Yet Assigned") rather than 500 - a real config problem here
would already have kept Node-RED itself from starting, so this is a read-side
safety net, not the actual validation authority.
"""

import json

from app.config import settings


def list_zone_names() -> list[str]:
    try:
        with open(settings.audio_patch_map_path, encoding="utf-8") as f:
            parsed = json.load(f)
        zones = parsed.get("zones")
        if not isinstance(zones, dict):
            return []
        return list(zones.keys())
    except (OSError, json.JSONDecodeError):
        return []

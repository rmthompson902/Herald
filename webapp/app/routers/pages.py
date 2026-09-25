"""
Server-rendered pages. Every handler here only reads (db/queries.py or a
best-effort Node-RED call that degrades gracefully) - all writes happen
through the JSON routers in schedules_api.py/vog_api.py, called from the
browser via static/js/utils/api-client.js.
"""

from fastapi import APIRouter, Request

from app.audio_patch_map import list_zone_names
from app.db import queries
from app.log_reader import read_recent_entries
from app.node_red_client import NodeRedUnavailableError, node_red_client
from app.templating import templates

router = APIRouter()


def _matched_zones(cue: dict | None, zone_names: list[str]) -> list[str]:
    """A cue's zones, filtered down to only the venue's currently configured ones - a
    schedule/VOG message whose cue resolves to a zone that's since been renamed/removed
    (or whose cue_cache is stale/missing) is "unassigned" rather than silently mismatched."""
    zones = cue["zones"] if cue else []
    return [zone for zone in zones if zone in zone_names]


def _cue_sort_key(qlab_cue_number: str) -> tuple[int, float | str]:
    """Ascending numeric cue-number order, e.g. "9" before "10" - falls back to a plain
    string compare for the rare non-numeric cue number rather than raising."""
    try:
        return (0, float(qlab_cue_number))
    except ValueError:
        return (1, qlab_cue_number)


def _start_seconds(hhmm: str | None) -> int:
    """Seconds-since-midnight for a schedule's startTime, for the start-to-finish rundown
    ordering - a schedule with no startTime runs all day, so it sorts as if starting at
    midnight (see docs/03-domain-concepts.md). Display-only: doesn't need to match
    lib/scheduling/occurrenceCalculator.js's wrap/validation semantics."""
    if not hhmm:
        return 0
    hours, minutes = hhmm.split(":")
    return int(hours) * 3600 + int(minutes) * 60


def _render_schedules_list(request: Request):
    schedules = queries.list_schedules()
    cue_cache_by_number = {c["qlabCueNumber"]: c for c in queries.list_cue_cache()}
    zone_names = list_zone_names()

    # A single flat table now (no more one-table-per-zone) - a schedule whose cue resolves
    # to more than one zone (a multi-zone Group cue) is one row with multiple zone badges,
    # filterable via the zone pills rather than duplicated across separate tables. Ordered
    # start-to-finish by startTime so the page reads like a rundown of the day.
    for schedule in schedules:
        schedule["zones"] = _matched_zones(cue_cache_by_number.get(schedule["qlabCueNumber"]), zone_names)
        schedule["startSeconds"] = _start_seconds(schedule["startTime"])
    schedules.sort(key=lambda s: (s["startSeconds"], _cue_sort_key(s["qlabCueNumber"])))
    has_unassigned = any(not s["zones"] for s in schedules)

    return templates.TemplateResponse(
        request,
        "schedules/list.html",
        {
            "has_schedules": bool(schedules),
            "zone_names": zone_names,
            "has_unassigned": has_unassigned,
            "schedules": schedules,
            "cue_cache_by_number": cue_cache_by_number,
        },
    )


@router.get("/", name="root")
async def root(request: Request):
    return _render_schedules_list(request)


@router.get("/schedules", name="schedules_list")
async def schedules_list(request: Request):
    return _render_schedules_list(request)


@router.get("/schedules/new", name="schedule_new")
async def schedule_new(request: Request):
    return templates.TemplateResponse(request, "schedules/form.html", {"schedule": None})


@router.get("/schedules/{schedule_id}/edit", name="schedule_edit")
async def schedule_edit(request: Request, schedule_id: int):
    schedule = queries.get_schedule(schedule_id)
    return templates.TemplateResponse(request, "schedules/form.html", {"schedule": schedule})


@router.get("/queues", name="queue_visualizer")
async def queue_visualizer(request: Request):
    # Unlike _render_schedules_list, nothing here is server-rendered from a snapshot - the
    # page is inherently live, so the server only hands over the zone list to build the
    # initial (empty) card skeletons; occupancy/queued/upcoming state all arrive
    # client-side via QueueAPI + the SocketIO push (see static/js/queue_visualizer.js).
    zone_names = list_zone_names()
    return templates.TemplateResponse(request, "queues/visualizer.html", {"zone_names": zone_names})


def _render_vog_list(request: Request):
    vog_messages = queries.list_vog_messages()
    cue_cache_by_number = {c["qlabCueNumber"]: c for c in queries.list_cue_cache()}
    zone_names = list_zone_names()

    for vog_message in vog_messages:
        vog_message["zones"] = _matched_zones(cue_cache_by_number.get(vog_message["qlabCueNumber"]), zone_names)
    vog_messages.sort(key=lambda v: _cue_sort_key(v["qlabCueNumber"]))
    has_unassigned = any(not v["zones"] for v in vog_messages)

    return templates.TemplateResponse(
        request,
        "vog/list.html",
        {
            "vog_messages": vog_messages,
            "cue_cache_by_number": cue_cache_by_number,
            "zone_names": zone_names,
            "has_unassigned": has_unassigned,
        },
    )


@router.get("/vog", name="vog_list")
async def vog_list(request: Request):
    return _render_vog_list(request)


@router.get("/vog/new", name="vog_new")
async def vog_new(request: Request):
    return templates.TemplateResponse(request, "vog/form.html", {"vog_message": None})


@router.get("/vog/{vog_id}/edit", name="vog_edit")
async def vog_edit(request: Request, vog_id: int):
    vog_message = queries.get_vog_message(vog_id)
    return templates.TemplateResponse(request, "vog/form.html", {"vog_message": vog_message})


@router.get("/settings", name="settings_page")
async def settings_page(request: Request):
    # Connection status and zone config are both read live from Node-RED - zones have no
    # SQLite row at all (config/audio-patch-map.json, kept live via core.zones.reload(), is
    # the sole source of truth), so both sections degrade together, gracefully, if Node-RED
    # is unreachable.
    try:
        health = await node_red_client.get_health()
        zones_result = await node_red_client.get_zones()
        patches_result = await node_red_client.get_zone_patches()
        node_red_reachable = True
    except NodeRedUnavailableError:
        health = None
        zones_result = None
        patches_result = None
        node_red_reachable = False

    zones = zones_result.get("zones", []) if zones_result else []
    patches = patches_result.get("patches", []) if patches_result else []
    patch_name_by_id = {p["patchId"]: p["name"] for p in patches}
    for zone in zones:
        zone["patchName"] = patch_name_by_id.get(zone["messagingPatchId"])

    # The event log used to be its own page (/history) - folded in here as a collapsed
    # accordion (see settings.html) between Zones and Connection Status, so operators don't
    # need a separate nav destination just to glance at recent activity.
    entries = read_recent_entries()

    return templates.TemplateResponse(
        request,
        "settings.html",
        {"health": health, "node_red_reachable": node_red_reachable, "zones": zones, "entries": entries},
    )


@router.get("/zones/new", name="zone_new")
async def zone_new(request: Request):
    return templates.TemplateResponse(request, "zones/form.html", {"zone": None})


@router.get("/zones/{zone_name}/edit", name="zone_edit")
async def zone_edit(request: Request, zone_name: str):
    try:
        result = await node_red_client.get_zones()
        zones = result.get("zones", [])
    except NodeRedUnavailableError:
        zones = []
    zone = next((z for z in zones if z["zoneName"] == zone_name), None)
    return templates.TemplateResponse(request, "zones/form.html", {"zone": zone})

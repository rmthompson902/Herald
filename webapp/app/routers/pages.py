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


def _render_schedules_list(request: Request):
    schedules = queries.list_schedules()
    cue_cache_by_number = {c["qlabCueNumber"]: c for c in queries.list_cue_cache()}
    zone_names = list_zone_names()

    # One table per configured zone (see app/audio_patch_map.py) - a schedule whose cue
    # resolves to more than one zone (a multi-zone Group cue) appears in every one of those
    # zones' tables, since each zone now admits/ducks/fires/frees it completely
    # independently (see lib/queue/zoneQueueEngine.js's per-zone decomposition). A schedule
    # not yet resolved to any configured zone (cue_cache stale/missing, or a genuine
    # mismatch) falls into "Not Yet Assigned" rather than silently disappearing.
    schedules_by_zone: dict[str, list] = {zone: [] for zone in zone_names}
    unassigned_schedules = []
    for schedule in schedules:
        cue = cue_cache_by_number.get(schedule["qlabCueNumber"])
        zones = cue["zones"] if cue else []
        matched_zones = [zone for zone in zones if zone in schedules_by_zone]
        if matched_zones:
            for zone in matched_zones:
                schedules_by_zone[zone].append(schedule)
        else:
            unassigned_schedules.append(schedule)

    return templates.TemplateResponse(
        request,
        "schedules/list.html",
        {
            "has_schedules": bool(schedules),
            "zone_names": zone_names,
            "schedules_by_zone": schedules_by_zone,
            "unassigned_schedules": unassigned_schedules,
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


@router.get("/queue", name="queue_visualizer")
async def queue_visualizer(request: Request):
    # Unlike _render_schedules_list, nothing here is server-rendered from a snapshot - the
    # page is inherently live, so the server only hands over the zone list to build the
    # initial (empty) card skeletons; occupancy/queued/upcoming state all arrive
    # client-side via QueueAPI + the SocketIO push (see static/js/queue_visualizer.js).
    zone_names = list_zone_names()
    return templates.TemplateResponse(request, "queue/visualizer.html", {"zone_names": zone_names})


def _render_vog_list(request: Request):
    vog_messages = queries.list_vog_messages()
    cue_cache_by_number = {c["qlabCueNumber"]: c for c in queries.list_cue_cache()}
    return templates.TemplateResponse(
        request,
        "vog/list.html",
        {"vog_messages": vog_messages, "cue_cache_by_number": cue_cache_by_number},
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


@router.get("/history", name="history_page")
async def history_page(request: Request):
    entries = read_recent_entries()
    return templates.TemplateResponse(request, "history.html", {"entries": entries})


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

    return templates.TemplateResponse(
        request,
        "settings.html",
        {"health": health, "node_red_reachable": node_red_reachable, "zones": zones},
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

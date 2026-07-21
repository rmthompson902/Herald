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


@router.get("/status", name="status_page")
async def status_page(request: Request):
    try:
        health = await node_red_client.get_health()
        node_red_reachable = True
    except NodeRedUnavailableError:
        health = None
        node_red_reachable = False
    return templates.TemplateResponse(
        request,
        "status.html",
        {"health": health, "node_red_reachable": node_red_reachable},
    )

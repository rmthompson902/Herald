"""
Server-rendered pages. Every handler here only reads (db/queries.py or a
best-effort Node-RED call that degrades gracefully) - all writes happen
through the JSON routers in schedules_api.py/vog_api.py, called from the
browser via static/js/utils/api-client.js.
"""

import glob
import os

from fastapi import APIRouter, Request

from app.config import settings
from app.db import queries
from app.node_red_client import NodeRedUnavailableError, node_red_client
from app.templating import templates

router = APIRouter()


def _render_schedules_list(request: Request):
    schedules = queries.list_schedules()
    cue_cache_by_number = {c["qlabCueNumber"]: c for c in queries.list_cue_cache()}
    return templates.TemplateResponse(
        request,
        "schedules/list.html",
        {"schedules": schedules, "cue_cache_by_number": cue_cache_by_number},
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
    log_files = sorted(glob.glob(os.path.join(settings.events_log_dir, "events-*.log")), reverse=True)
    entries: list[str] = []
    if log_files:
        with open(log_files[0], "r", encoding="utf-8") as handle:
            entries = handle.readlines()[-200:]
            entries.reverse()
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

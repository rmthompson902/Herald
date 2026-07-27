"""Pydantic models mirror lib/scheduling/scheduleModel.js's rules for instant client-side
feedback. These assert the mirror holds (Node-RED remains the real authority on writes)."""

import pytest
from pydantic import ValidationError

from app.models.schedule import ScheduleRequest
from app.models.vog import VogMessageRequest
from app.models.zone import ZoneRequest


def test_valid_schedule_maps_to_node_red_payload():
    req = ScheduleRequest(name=" Safety ", qlab_cue_number=" 1101 ", interval_seconds=60)
    payload = req.to_node_red_payload()
    assert payload["name"] == "Safety"  # trimmed
    assert payload["qlabCueNumber"] == "1101"  # trimmed + camelCase key
    assert payload["intervalSeconds"] == 60
    assert payload["weekdays"] == [1, 2, 3, 4, 5, 6, 7]  # default


@pytest.mark.parametrize(
    "kwargs",
    [
        {"name": "  ", "qlab_cue_number": "1101", "interval_seconds": 60},  # blank name
        {"name": "S", "qlab_cue_number": "1101", "interval_seconds": 0},  # non-positive interval
        {"name": "S", "qlab_cue_number": "1101", "interval_seconds": 60, "start_time": "25:00"},  # bad time
        {"name": "S", "qlab_cue_number": "1101", "interval_seconds": 60, "weekdays": [0, 8]},  # out of range
        {"name": "S", "qlab_cue_number": "1101", "interval_seconds": 60, "weekdays": [1, 1]},  # duplicate
        {
            "name": "S",
            "qlab_cue_number": "1101",
            "interval_seconds": 60,
            "start_time": "17:00",
            "end_time": "09:00",
        },  # start after end
        {
            "name": "S",
            "qlab_cue_number": "1101",
            "interval_seconds": 60,
            "date_range_start": "2026-05-01",
            "date_range_end": "2026-04-01",
        },  # range reversed
    ],
)
def test_invalid_schedule_rejected(kwargs):
    with pytest.raises(ValidationError):
        ScheduleRequest(**kwargs)


def test_vog_message_requires_name_and_cue():
    assert VogMessageRequest(name="Evac", qlab_cue_number="1104").to_node_red_payload()["qlabCueNumber"] == "1104"
    with pytest.raises(ValidationError):
        VogMessageRequest(name="", qlab_cue_number="1104")


def test_zone_request_requires_all_fields():
    z = ZoneRequest(
        zone_name="Zone 9",
        messaging_patch_id="9",
        duck_cue_number="9198",
        unduck_cue_number="9199",
    )
    assert z.to_node_red_payload() == {
        "zoneName": "Zone 9",
        "messagingPatchId": "9",
        "duckCueNumber": "9198",
        "unduckCueNumber": "9199",
    }
    with pytest.raises(ValidationError):
        ZoneRequest(zone_name="Zone 9", messaging_patch_id=" ", duck_cue_number="9198", unduck_cue_number="9199")

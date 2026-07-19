"""
Pydantic request model mirroring lib/scheduling/scheduleModel.js's field
rules, for instant client-side feedback only. This is UX duplication, not
business-logic duplication: Node-RED's validateSchedule still runs on every
write and remains the actual authority (see docs/claude-plan.md) - a passing
check here never skips the proxy call to Node-RED.
"""

import re
from typing import Optional

from pydantic import BaseModel, field_validator, model_validator

TIME_PATTERN = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class ScheduleRequest(BaseModel):
    name: str
    qlab_cue_number: str
    interval_seconds: int
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    weekdays: list[int] = [1, 2, 3, 4, 5, 6, 7]
    date_range_start: Optional[str] = None
    date_range_end: Optional[str] = None
    enabled: bool = True

    @field_validator("name", "qlab_cue_number")
    @classmethod
    def not_blank(cls, value: str) -> str:
        if not value or not value.strip():
            raise ValueError("must not be blank")
        return value.strip()

    @field_validator("interval_seconds")
    @classmethod
    def positive_interval(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("must be a positive integer")
        return value

    @field_validator("start_time", "end_time")
    @classmethod
    def valid_time(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and not TIME_PATTERN.match(value):
            raise ValueError('must be HH:MM (24-hour)')
        return value

    @field_validator("date_range_start", "date_range_end")
    @classmethod
    def valid_date(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and not DATE_PATTERN.match(value):
            raise ValueError("must be YYYY-MM-DD")
        return value

    @field_validator("weekdays")
    @classmethod
    def valid_weekdays(cls, value: list[int]) -> list[int]:
        if not value or not all(1 <= d <= 7 for d in value) or len(set(value)) != len(value):
            raise ValueError("must be a non-empty list of unique integers 1-7 (1=Monday..7=Sunday)")
        return sorted(value)

    @model_validator(mode="after")
    def start_before_end(self) -> "ScheduleRequest":
        if self.start_time is not None and self.end_time is not None and self.start_time >= self.end_time:
            raise ValueError("start_time must be before end_time")
        return self

    @model_validator(mode="after")
    def date_range_order(self) -> "ScheduleRequest":
        if (
            self.date_range_start is not None
            and self.date_range_end is not None
            and self.date_range_start > self.date_range_end
        ):
            raise ValueError("date_range_start must be on or before date_range_end")
        return self

    def to_node_red_payload(self) -> dict:
        return {
            "name": self.name,
            "qlabCueNumber": self.qlab_cue_number,
            "intervalSeconds": self.interval_seconds,
            "startTime": self.start_time,
            "endTime": self.end_time,
            "weekdays": self.weekdays,
            "dateRangeStart": self.date_range_start,
            "dateRangeEnd": self.date_range_end,
            "enabled": self.enabled,
        }

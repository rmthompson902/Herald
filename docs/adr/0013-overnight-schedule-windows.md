# ADR 0013: Overnight (midnight-crossing) schedule windows

## Status

Accepted.

## Context

Reported by the operator: adding a schedule against cue 260112 with an active window of
`startTime: 21:30`, `endTime: 03:00` (9:30pm through 3:00am the next morning, all weekdays
checked) failed to save, with the dashboard's add button surfacing a generic error. Changing
the end time to `23:59` saved successfully, confirming the active-window fields, not the cue
or zone, were the cause.

Traced to a hard validation rule present in both `lib/scheduling/scheduleModel.js`
(`validateSchedule`, the write authority) and `webapp/app/models/schedule.py`
(`ScheduleRequest`, the client-side-feedback mirror — see `docs/02-architecture.md`): both
rejected any schedule where `startTime >= endTime`, on the implicit assumption that a
schedule's active window is always same-day. `lib/scheduling/occurrenceCalculator.js`'s
`gridTimesForDay` made the same same-day assumption in its occurrence math — a window with
`endTime < startTime` would silently produce zero grid points rather than erroring, so the
validation rule was the only thing standing between "reject" and "silently never fire."

Overnight windows (evening into early morning) are a normal shape for a show schedule and
should be a first-class case, not a same-day-only workaround.

## Decision

Reinterpret `startTime`/`endTime` as a duration relative to `startTime`, rather than a
same-day range, with no new field or UI control — this is inferred entirely from the existing
two `HH:MM` inputs:

- **Wrap trigger**: if `endTime` is numerically earlier than `startTime`, the window wraps
  past midnight into the next calendar day.
- **Equal start/end stays rejected.** `21:00`/`21:00` remains a validation error (an ambiguous
  zero-length window) — to run all day, leave both fields blank (already supported;
  `gridTimesForDay` already defaults to the full day when both are null). The validation rule
  in both `scheduleModel.js` and `schedule.py` changed from rejecting `startTime >= endTime`
  to rejecting only `startTime === endTime`.
- **Weekday ownership.** With all 7 weekdays checked (the common case, and what the failing
  schedule used), this doesn't come up — every day including the one it rolls into is already
  covered. It only matters for a schedule restricted to specific weekdays, e.g. only
  Friday+Saturday checked, running 11pm→2am:
  - If **both** the start day and the day it rolls into are allowed (weekdays + date range),
    the full window fires — Friday 11pm through Saturday 2am.
  - If **only the start day** is allowed, the occurrence **truncates at 23:59:59** of the
    start day — nothing fires after midnight that night. Checking only Friday effectively
    yields an 11pm→midnight window on that occasion, not a rejected/skipped one.
  - This also governs a window wrapping past the end of a `dateRangeEnd` boundary — a wrap
    that would land outside the active date range truncates at midnight for the same reason
    the next day would otherwise be disallowed.
  - Implemented in `gridTimesForDay(scheduleRow, cursorDay)`, which now takes the calendar day
    being evaluated so it can check `isDayAllowed(scheduleRow, nextDay)` before deciding
    whether to extend the grid past `SECONDS_PER_DAY` or cap it there. `nextOccurrences` and
    `occurrencesUntil` already iterated day-by-day checking `isDayAllowed` against the
    *start* day before generating that day's grid — unchanged, and already exactly the "start
    day owns the span" behavior this needed.
  - No change was needed to how grid seconds become real `Date` objects: both callers already
    build occurrences via `new Date(cursorDay); occurrence.setSeconds(occurrence.getSeconds()
    + seconds)`, and `Date.prototype.setSeconds` already normalizes a seconds value past
    86400 into the correct following calendar day on its own.
- **`isWithinActiveWindow` deliberately left unchanged.** Its docstring claims to be "a
  defensive re-check at fire-time," but a repo-wide search confirmed nothing in the live fire
  path (`onDue` in `node-red/lib/handlers/schedules.js`) actually calls it — it's exercised
  only by its own unit tests. It's pre-existing dead code with a misleading comment;
  reworking its same-day assumption for overnight windows was judged out of scope for this
  fix, since doing so wouldn't change any real behavior today.
- **No UI copy changes.** This is a backend/logic-only fix; the form's "Active window
  start/end" labels are unchanged.

New/updated tests: `test/unit/scheduleModel.test.js` and `webapp/tests/test_models.py` cover
the validation change (overnight window accepted, equal start/end still rejected).
`test/unit/occurrenceCalculator.test.js` adds coverage for `gridTimesForDay` (full wrap,
weekday-truncation, same-day-unaffected) and for `nextOccurrences`/`occurrencesUntil` (full
wrap rolling onto the next calendar day, truncation when only the start weekday is checked,
truncation at a `dateRangeEnd` boundary). All existing and new unit/pytest tests pass.

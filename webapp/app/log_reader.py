"""
Reads the most recent lines from today's event log (see lib/log/eventLogger.js).
Shared by the Settings page's Event Log accordion (first load - see
routers/pages.py's settings_page) and the GET /api/history/entries JSON endpoint
it polls afterward for auto-refresh, so both read the exact same file the exact
same way.
"""

import glob
import os

from app.config import settings

MAX_ENTRIES = 200


def read_recent_entries(limit: int = MAX_ENTRIES) -> list[str]:
    log_files = sorted(glob.glob(os.path.join(settings.events_log_dir, "events-*.log")), reverse=True)
    if not log_files:
        return []

    with open(log_files[0], "r", encoding="utf-8") as handle:
        lines = handle.readlines()[-limit:]
    lines.reverse()
    return [line.rstrip("\n") for line in lines]

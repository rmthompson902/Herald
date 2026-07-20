"""
JSON endpoint backing the /history page's periodic auto-refresh and its
manual "Refresh Log Entries" button. Reads the same events-YYYY-MM-DD.log
file the page itself reads on first load (see app/log_reader.py) - a plain
re-read, no proxy to Node-RED needed.
"""

from fastapi import APIRouter

from app.log_reader import read_recent_entries

router = APIRouter(prefix="/api/history", tags=["history"])


@router.get("/entries")
async def get_recent_entries():
    return {"status": "success", "entries": read_recent_entries()}

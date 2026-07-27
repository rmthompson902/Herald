"""
App settings, following the same typed-env-var-with-defaults spirit as
lib/'s Node-RED settings.js and UPS-Mgmt's Config.get_env() (see
docs/claude-plan.md). pydantic-settings gives the same guarantee - every
setting has an explicit type and a safe default - without hand-rolling the
conversion helper.
"""

from pathlib import Path

from pydantic_settings import BaseSettings

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    node_red_api_base: str = "http://127.0.0.1:1880/api"
    db_path: str = str(REPO_ROOT / "data" / "schedule.db")
    audio_patch_map_path: str = str(REPO_ROOT / "config" / "audio-patch-map.json")
    events_log_dir: str = str(REPO_ROOT / "logs")
    port: int = 8000
    log_level: str = "INFO"
    health_poll_interval_seconds: float = 2.0
    # Deliberately much faster than health_poll_interval_seconds - QLab connection health
    # changes rarely and doesn't need sub-second granularity, but the zone queue visualizer
    # (/queues) needs a transition (duck starting, a cue actually firing, a zone freeing) to
    # reach the browser fast enough to read as "live" rather than laggy. Both endpoints this
    # backs (GET /queue/state, /queue/events) are cheap in-memory reads on the Node-RED side,
    # not real I/O, so polling this much faster than the health check costs nothing there.
    queue_poll_interval_seconds: float = 0.5

    class Config:
        env_file = str(REPO_ROOT / "webapp" / ".env")
        env_file_encoding = "utf-8"


settings = Settings()

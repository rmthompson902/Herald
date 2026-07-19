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
    events_log_dir: str = str(REPO_ROOT / "logs")
    port: int = 8000
    log_level: str = "INFO"
    health_poll_interval_seconds: float = 2.0

    class Config:
        env_file = str(REPO_ROOT / "webapp" / ".env")
        env_file_encoding = "utf-8"


settings = Settings()

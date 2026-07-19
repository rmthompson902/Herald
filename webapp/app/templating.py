"""
Single shared Jinja2Templates instance so every router resolves templates/
from the same absolute path regardless of the process's working directory.
"""

from pathlib import Path

from fastapi.templating import Jinja2Templates

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates"

templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

import os

from pathlib import Path


class Config:
    TITLE = "OpenCode Conversations"

    ROOT_DIR = Path(__file__).resolve().parent.parent
    APP_DIR = ROOT_DIR / "app"
    DATA_DIR = ROOT_DIR / "data"
    STATIC_ASSETS_DIR = APP_DIR / "static"
    TEMPLATES_DIR = APP_DIR / "templates"

    OPENCODE_DB_PATH = Path.home() / ".local/share/opencode/opencode.db"
    SEARCH_DB_PATH = DATA_DIR / "search_index.db"
    MAIN_DB_PATH = DATA_DIR / "main.db"

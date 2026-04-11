import os
from pathlib import Path

# Project root: Radar/ (three levels above this file: app/ → server/ → Radar/)
_PROJECT_ROOT = Path(__file__).parent.parent.parent

# All SQLite database files (radar.db, -wal, -shm) live here and are gitignored.
DB_DIR = _PROJECT_ROOT / "db"


class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "change-me-in-production")

    SQLALCHEMY_DATABASE_URI = os.getenv(
        "DATABASE_URL",
        f"sqlite:///{DB_DIR / 'radar.db'}",
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = {
        # Allow the same connection to be used across threads (Flask dev server).
        "connect_args": {"check_same_thread": False},
    }

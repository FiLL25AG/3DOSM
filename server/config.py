"""Ładowanie konfiguracji źródeł. Adresy usług żyją wyłącznie w config/sources.json."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_sources():
    return json.loads((ROOT / "config" / "sources.json").read_text(encoding="utf-8"))

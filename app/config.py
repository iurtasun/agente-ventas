"""Configuración compartida: rutas, modelo y credenciales."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "static"

load_dotenv(ROOT / ".env")

DB_PATH = Path(os.environ.get("SALES_DB_PATH", ROOT / "sales_data.db"))

DEFAULT_MODEL = os.environ.get("AGENT_MODEL", "deepseek/deepseek-v4.1-flash")
OPENROUTER_BASE_URL = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")

# Minutos de inactividad tras los que una sesión se cierra y se descarta.
SESSION_TTL_MINUTES = int(os.environ.get("SESSION_TTL_MINUTES", "60"))

# Segundos máximos que se espera una respuesta del modelo en un turno.
TURN_TIMEOUT_SECONDS = float(os.environ.get("TURN_TIMEOUT_SECONDS", "180"))


def api_key() -> str:
    """Clave de OpenRouter, o cadena vacía si no está configurada."""
    return os.environ.get("OPENROUTER_API_KEY", "").strip()


def require_api_key() -> str:
    key = api_key()
    if not key:
        raise RuntimeError(
            f"Falta OPENROUTER_API_KEY en {ROOT / '.env'} o en el entorno."
        )
    return key

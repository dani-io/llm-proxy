"""Configuration loaded from .env"""
import os
from dotenv import load_dotenv

load_dotenv()

# LLM
LLAMA_URL = os.getenv("LLAMA_URL", "http://192.168.10.245:8080")
LLAMA_MODEL = os.getenv("LLAMA_MODEL", "gemma-4-e4b")
LLAMA_TIMEOUT = float(os.getenv("LLAMA_TIMEOUT_SECONDS", "180"))

# SearXNG
SEARXNG_URL = os.getenv("SEARXNG_URL", "http://searx.bp:8080")

# Server
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))
LOG_LEVEL = os.getenv("LOG_LEVEL", "info")
RELOAD = os.getenv("RELOAD", "false").lower() in ("1", "true", "yes")

# Admin panel (served on its own port; set ADMIN_PORT=0 to disable)
ADMIN_HOST = os.getenv("ADMIN_HOST", "0.0.0.0")
ADMIN_PORT = int(os.getenv("ADMIN_PORT", "8002"))
SESSION_TTL_HOURS = float(os.getenv("SESSION_TTL_HOURS", "168"))
PANEL_TZ = os.getenv("PANEL_TZ", "Asia/Tehran")          # day boundaries in stats

# Request log (metadata only — no prompts) and provider health probe
STATS_DB = os.getenv(
    "STATS_DB", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "stats.db"))
STATS_RETENTION_DAYS = int(os.getenv("STATS_RETENTION_DAYS", "90"))
HEALTH_PROBE_SECONDS = int(os.getenv("HEALTH_PROBE_SECONDS", "300"))   # 0 = off

# API keys entered in the admin panel (own file, 0600; .env is never rewritten)
KEYS_FILE = os.getenv(
    "KEYS_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "provider-keys.env"))

# Providers / models (see providers.example.yaml). If the file is missing,
# a single local model is built from LLAMA_URL / LLAMA_MODEL above.
PROVIDERS_FILE = os.getenv(
    "PROVIDERS_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "providers.yaml"))

# Behavior
MAX_TOOL_LOOPS = int(os.getenv("MAX_TOOL_LOOPS", "5"))
SEARCH_MAX_RESULTS = int(os.getenv("SEARCH_MAX_RESULTS", "10"))
FETCH_TIMEOUT = float(os.getenv("FETCH_TIMEOUT_SECONDS", "15"))

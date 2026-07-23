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

# Behavior
MAX_TOOL_LOOPS = int(os.getenv("MAX_TOOL_LOOPS", "5"))
SEARCH_MAX_RESULTS = int(os.getenv("SEARCH_MAX_RESULTS", "10"))
FETCH_TIMEOUT = float(os.getenv("FETCH_TIMEOUT_SECONDS", "15"))

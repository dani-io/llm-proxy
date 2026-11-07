# llm-proxy — model API on :8000, admin panel on :8002 (one process).
# Deployed by Coolify. All runtime state lives in /app/data — mount a
# persistent volume there (stats.db, provider-keys.env, providers.yaml, backups).
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PROVIDERS_FILE=/app/data/providers.yaml \
    HOST=0.0.0.0 \
    PORT=8000 \
    ADMIN_HOST=0.0.0.0 \
    ADMIN_PORT=8002

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

# Non-root; /app/data is created owned by the app user so a fresh named
# volume mounted there inherits that ownership.
RUN useradd --uid 1000 --create-home app \
 && mkdir -p /app/data && chown app:app /app/data

COPY --chown=app:app . .
USER app

EXPOSE 8000 8002
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)"

# Single process, single replica: the provider registry and health state are in memory.
CMD ["python", "server.py"]

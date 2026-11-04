"""
Admin panel backend — served on its own port (ADMIN_PORT, default 8002) so
the model API on PORT stays separate. Same-origin: this app serves both the
built UI (admin-ui/dist) and its JSON API under /api, with an HttpOnly
session cookie. One admin account, created on first visit.
"""
import os
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import config
import health
import proxy
from providers import _is_lan, get_registry
from stats import store

COOKIE = "llmp_session"
MIN_PASSWORD = 10
STARTED = time.time()
DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "admin-ui", "dist")

admin_app = FastAPI(title="llm-proxy admin", docs_url=None, redoc_url=None, openapi_url=None)


# ─── Auth ─────────────────────────────────────────────────────
_failures: dict[str, list[float]] = {}


def _throttle(ip: str) -> None:
    recent = [t for t in _failures.get(ip, []) if time.time() - t < 60]
    _failures[ip] = recent
    if len(recent) >= 5:
        raise HTTPException(429, "Too many failed attempts — wait a minute.")


def require_admin(request: Request) -> None:
    if not store().valid_session(request.cookies.get(COOKIE)):
        raise HTTPException(401, "Not signed in")


def _set_session(response: Response) -> None:
    ttl = config.SESSION_TTL_HOURS * 3600
    response.set_cookie(COOKIE, store().new_session(ttl), max_age=int(ttl),
                        httponly=True, samesite="strict", path="/")


class Credentials(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=MIN_PASSWORD, max_length=256)


@admin_app.get("/api/auth/setup")
async def setup_status():
    return {"needs_setup": store().admin() is None}


@admin_app.post("/api/auth/setup")
async def setup(creds: Credentials, response: Response):
    if len(creds.password) < MIN_PASSWORD:
        raise HTTPException(422, f"Password must be at least {MIN_PASSWORD} characters.")
    if not store().create_admin(creds.username.strip(), creds.password):
        raise HTTPException(409, "An admin account already exists — sign in instead.")
    _set_session(response)
    return {"ok": True}


@admin_app.post("/api/auth/login")
async def login(creds: Credentials, request: Request, response: Response):
    ip = request.client.host if request.client else "?"
    _throttle(ip)
    if not store().check_password(creds.username.strip(), creds.password):
        _failures.setdefault(ip, []).append(time.time())
        raise HTTPException(401, "Wrong username or password.")
    _failures.pop(ip, None)
    _set_session(response)
    return {"ok": True}


@admin_app.post("/api/auth/logout")
async def logout(request: Request, response: Response):
    store().end_session(request.cookies.get(COOKIE))
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@admin_app.get("/api/auth/me", dependencies=[Depends(require_admin)])
async def me():
    a = store().admin() or {}
    return {"kind": "admin", "name": a.get("username", "admin")}


@admin_app.post("/api/auth/password", dependencies=[Depends(require_admin)])
async def change_password(body: PasswordChange, request: Request, response: Response):
    ip = request.client.host if request.client else "?"
    _throttle(ip)
    if not store().check_password(None, body.current_password):
        _failures.setdefault(ip, []).append(time.time())
        raise HTTPException(400, "Current password is wrong.")
    store().set_password(body.new_password)       # also ends every session
    _set_session(response)
    return {"ok": True}


# ─── Read-only data ───────────────────────────────────────────
def _key_hint(key: str | None) -> str | None:
    return f"…{key[-4:]}" if key and len(key) > 8 else ("set" if key else None)


def _tz_offset() -> int:
    try:
        return int(datetime.now(ZoneInfo(config.PANEL_TZ)).utcoffset().total_seconds())
    except Exception:
        return 0


def _midnight() -> float:
    off = _tz_offset()
    now = time.time()
    return (now + off) // 86400 * 86400 - off


@admin_app.get("/api/overview", dependencies=[Depends(require_admin)])
async def overview():
    reg = get_registry()
    now = time.time()
    st = store()
    usage24 = {r["model"]: r for r in st.by_model(now - 86400)}

    providers = []
    for p in reg.providers.values():
        providers.append({
            "name": p.name,
            "base_url": p.base_url,
            "key": _key_hint(p.api_key),
            "timeout": p.timeout,
            "external": not _is_lan(p.base_url),
            "models": [m.alias for m in reg.models.values() if m.provider is p],
            "health": health.providers.get(p.name, health.State()).to_dict(),
        })

    models = []
    for m in reg.models.values():
        models.append({
            **proxy.model_info(m, reg.default_model),
            "health": health.models.get(m.alias, health.State()).to_dict(),
            "usage_24h": usage24.get(m.alias),
        })

    return {
        "proxy": {
            "version": proxy.app.version,
            "started": STARTED,
            "uptime_s": int(now - STARTED),
            "default_model": reg.default_model,
            "tools": list(proxy.TOOLS),
            "max_tool_loops": config.MAX_TOOL_LOOPS,
            "api_port": config.PORT,
            "admin_port": config.ADMIN_PORT,
            "providers_file": config.PROVIDERS_FILE,
            "providers_file_exists": os.path.exists(config.PROVIDERS_FILE),
            "probe_interval_s": config.HEALTH_PROBE_SECONDS,
            "retention_days": config.STATS_RETENTION_DAYS,
            "timezone": config.PANEL_TZ,
        },
        "summary": {
            "today": st.summary(_midnight()),
            "last_24h": st.summary(now - 86400),
            "last_7d": st.summary(now - 7 * 86400),
        },
        "models": models,
        "providers": providers,
    }


RANGES = {"24h": (3600, 24), "7d": (86400, 7), "30d": (86400, 30), "90d": (86400, 90)}


@admin_app.get("/api/stats/series", dependencies=[Depends(require_admin)])
async def stats_series(span: str = Query("7d", alias="range")):
    if span not in RANGES:
        raise HTTPException(422, f"range must be one of {list(RANGES)}")
    bucket, n = RANGES[span]
    off = _tz_offset()   # bucket edges on local hours/midnights (Tehran is UTC+3:30)
    now = time.time()
    first = ((now + off) // bucket - (n - 1)) * bucket - off
    rows = store().series(bucket, first, off)

    buckets = [first + i * bucket for i in range(n)]
    by_bucket = {b: {"bucket": b, "requests": 0, "errors": 0, "prompt_tokens": 0,
                     "completion_tokens": 0, "by_model": {}} for b in buckets}
    models = set()
    for r in rows:
        b = by_bucket.get(r["bucket"])
        if b is None:
            continue
        models.add(r["model"])
        for k in ("requests", "errors", "prompt_tokens", "completion_tokens"):
            b[k] += r[k] or 0
        b["by_model"][r["model"]] = r["requests"]
    return {"range": span, "bucket_s": bucket, "models": sorted(m for m in models if m),
            "points": list(by_bucket.values())}


@admin_app.get("/api/stats/models", dependencies=[Depends(require_admin)])
async def stats_models(days: int = 7):
    days = max(1, min(days, config.STATS_RETENTION_DAYS))
    return {"days": days, "models": store().by_model(time.time() - days * 86400)}


@admin_app.get("/api/requests", dependencies=[Depends(require_admin)])
async def requests_log(limit: int = 50, before_id: int | None = None,
                       model: str | None = None, status: str | None = None):
    return {"items": store().recent(limit, before_id, model or None, status or None)}


class TestBody(BaseModel):
    prompt: str = Field(default="Reply with one short sentence: which model are you?",
                        max_length=2000)


@admin_app.post("/api/models/{alias}/test", dependencies=[Depends(require_admin)])
async def test_model(alias: str, body: TestBody):
    """One direct call — no tools, no fallback — so the result is about this model only."""
    reg = get_registry()
    m = reg.models.get(alias)
    if not m:
        raise HTTPException(404, f"Unknown model {alias}")
    rec = proxy.Rec(alias, False, "panel", source="test")
    rec.served_by(m)
    payload = {"model": m.upstream_model, "stream": False, "max_tokens": 120,
               "messages": [{"role": "user", "content": body.prompt}]}
    t0 = time.monotonic()
    try:
        data = await proxy.post_chat(m, payload)
        ms = int((time.monotonic() - t0) * 1000)
        rec.add_usage(data.get("usage"))
        msg = data["choices"][0]["message"]
        usage = data.get("usage") or {}
        timings = data.get("timings") or {}
        tps = timings.get("predicted_per_second")
        if tps is None and usage.get("completion_tokens") and ms:
            tps = usage["completion_tokens"] / (ms / 1000)
        return {"ok": True, "latency_ms": ms, "content": msg.get("content") or "",
                "reasoning": bool(msg.get("reasoning_content")),
                "usage": usage, "tokens_per_s": round(tps, 1) if tps else None,
                "upstream_model": data.get("model")}
    except proxy.UpstreamError as e:
        rec.fail(str(e))
        return {"ok": False, "latency_ms": int((time.monotonic() - t0) * 1000),
                "status": e.status, "error": e.detail[:1000]}
    finally:
        rec.save()


@admin_app.post("/api/providers/{name}/probe", dependencies=[Depends(require_admin)])
async def probe_provider(name: str):
    p = get_registry().providers.get(name)
    if not p:
        raise HTTPException(404, f"Unknown provider {name}")
    return await health.probe(p)


# ─── UI ───────────────────────────────────────────────────────
@admin_app.get("/api/{rest:path}")
async def api_404(rest: str):
    raise HTTPException(404, "Not found")


if os.path.isdir(os.path.join(DIST, "assets")):
    admin_app.mount("/assets", StaticFiles(directory=os.path.join(DIST, "assets")), name="assets")


@admin_app.get("/{path:path}", include_in_schema=False)
async def ui(path: str):
    target = os.path.normpath(os.path.join(DIST, path))
    if path and target.startswith(DIST + os.sep) and os.path.isfile(target):
        return FileResponse(target)
    index = os.path.join(DIST, "index.html")
    if os.path.isfile(index):
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
    return Response("Admin UI is not built (admin-ui/dist missing). The API is under /api.",
                    media_type="text/plain", status_code=503)

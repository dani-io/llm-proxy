"""
In-memory health of providers and models, fed by real traffic and by a
periodic probe (GET {base_url}/models). Resets on restart — the request log
in stats.py is the durable history.
"""
import asyncio
import logging
import time
from dataclasses import asdict, dataclass

import httpx

import config

log = logging.getLogger("llm-proxy.health")

RECENT_WINDOW = 15 * 60   # an error within this window marks "degraded"


@dataclass
class State:
    last_ok: float | None = None
    last_error: float | None = None
    error: str | None = None
    status_code: int | None = None
    latency_ms: int | None = None
    consecutive_failures: int = 0
    successes: int = 0
    failures: int = 0
    probe_models: int | None = None     # model count from the last probe
    last_probe: float | None = None

    def status(self) -> str:
        if self.last_ok is None and self.last_error is None:
            return "unknown"
        if self.last_error and (self.last_ok is None or self.last_error > self.last_ok):
            return "down"
        if self.last_error and time.time() - self.last_error < RECENT_WINDOW:
            return "degraded"
        return "ok"

    def to_dict(self) -> dict:
        return {**asdict(self), "status": self.status()}


providers: dict[str, State] = {}
models: dict[str, State] = {}


def _get(table: dict, key: str) -> State:
    return table.setdefault(key, State())


def ok(provider: str, model: str | None, latency_ms: int) -> None:
    now = time.time()
    for s in filter(None, (_get(providers, provider), model and _get(models, model))):
        s.last_ok, s.latency_ms = now, latency_ms
        s.consecutive_failures = 0
        s.successes += 1


def error(provider: str, model: str | None, status_code: int | None, message: str) -> None:
    now = time.time()
    for s in filter(None, (_get(providers, provider), model and _get(models, model))):
        s.last_error, s.status_code, s.error = now, status_code, message[:500]
        s.consecutive_failures += 1
        s.failures += 1


async def probe(provider) -> dict:
    """GET {base_url}/models — cheap and does not spend generation quota."""
    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=min(provider.timeout, 15)) as client:
            resp = await client.get(f"{provider.base_url}/models",
                                    headers=provider.request_headers())
        ms = int((time.monotonic() - t0) * 1000)
        if resp.status_code >= 400:
            raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")
        data = resp.json().get("data") or []
        ids = sorted(str(m.get("id")) for m in data if isinstance(m, dict))
        ok(provider.name, None, ms)
        s = _get(providers, provider.name)
        s.probe_models, s.last_probe = len(ids), time.time()
        return {"ok": True, "latency_ms": ms, "count": len(ids), "models": ids}
    except Exception as e:
        ms = int((time.monotonic() - t0) * 1000)
        msg = f"{type(e).__name__}: {e}"
        error(provider.name, None, getattr(e, "status_code", None), f"probe: {msg}")
        _get(providers, provider.name).last_probe = time.time()
        return {"ok": False, "latency_ms": ms, "error": msg}


async def probe_loop(get_registry) -> None:
    if config.HEALTH_PROBE_SECONDS <= 0:
        return
    await asyncio.sleep(5)
    while True:
        for p in list(get_registry().providers.values()):
            await probe(p)
        await asyncio.sleep(config.HEALTH_PROBE_SECONDS)

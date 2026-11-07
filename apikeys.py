"""
Project API keys for the model API (/v1/*) — same model as sms-gateway.

Each project gets its own key `llp_<slug>_<secret>`, sent as
`Authorization: Bearer <key>` (what every OpenAI SDK sends for `api_key`).
Only a sha256 of the key is stored. A key has:

  - models:  the aliases it may use (None = every model, including new ones);
             fallback only moves to models the key may use
  - tools:   whether the server tools (web_search / fetch_url) are offered
  - daily_tokens / monthly_tokens: limits on prompt + completion tokens over
             the Tehran day / the last 30 Tehran days (today included)
  - expires_at, active

Errors use the OpenAI error shape so SDKs show a useful message.
"""
import hashlib
import json
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import config
from stats import store

KEY_PREFIX = "llp_"
TOUCH_EVERY = 60.0          # don't write last_used_at on every request


class ApiError(Exception):
    """An OpenAI-style error response."""

    def __init__(self, status: int, message: str, code: str,
                 type_: str = "invalid_request_error", headers: dict | None = None):
        super().__init__(message)
        self.status, self.message, self.code, self.type, self.headers = (
            status, message, code, type_, headers)

    def body(self) -> dict:
        return {"error": {"message": self.message, "type": self.type, "code": self.code}}


# ── Time: Tehran days ─────────────────────────────────────────
def _tz():
    try:
        return ZoneInfo(config.PANEL_TZ)
    except Exception:
        return ZoneInfo("Asia/Tehran")


def day_start(now: float | None = None) -> float:
    dt = datetime.fromtimestamp(now if now is not None else time.time(), _tz())
    return dt.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()


def next_midnight(now: float | None = None) -> float:
    start = datetime.fromtimestamp(day_start(now), _tz())
    return (start + timedelta(days=1)).timestamp()


def windows(now: float | None = None) -> tuple[float, float, float]:
    """today, last 7 days, last 30 days — all starting at a Tehran midnight."""
    d = day_start(now)
    return d, d - 6 * 86400, d - 29 * 86400


# ── Keys ──────────────────────────────────────────────────────
def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def generate(name: str) -> tuple[str, str, str]:
    """New key -> (plaintext, display prefix, hash)."""
    slug = "".join(c for c in name.lower() if c.isalnum())[:10] or "key"
    plaintext = f"{KEY_PREFIX}{slug}_{secrets.token_urlsafe(24)}"
    return plaintext, display_prefix(plaintext), sha256_hex(plaintext)


def display_prefix(plaintext: str) -> str:
    """Enough to recognise the key, not enough to use it. The urlsafe secret
    can contain '_', so split from the left at most twice."""
    parts = plaintext.split("_", 2)
    if plaintext.startswith(KEY_PREFIX) and len(parts) == 3:
        return f"{parts[0]}_{parts[1]}_{parts[2][:4]}…"
    return f"{plaintext[:6]}…"


def parse_models(raw: str | None) -> list[str] | None:
    if raw is None:
        return None
    try:
        v = json.loads(raw)
        return [str(m) for m in v] if isinstance(v, list) else None
    except ValueError:
        return None


def dump_models(models: list[str] | None) -> str | None:
    return None if models is None else json.dumps(sorted(set(models)))


@dataclass
class Caller:
    id: int
    name: str
    models: frozenset | None        # None = every model
    tools: bool
    daily_tokens: int | None
    monthly_tokens: int | None

    def allows(self, alias: str) -> bool:
        return self.models is None or alias in self.models


def client_ip(request) -> str | None:
    """The model API is only reachable through Coolify's proxy (the container
    port is not published), so its X-Forwarded-For is the real client."""
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else None


def authenticate(request) -> Caller:
    header = request.headers.get("authorization") or ""
    scheme, _, token = header.partition(" ")
    token = token.strip()
    if not header:
        raise ApiError(401, "Missing API key. Send 'Authorization: Bearer <key>' "
                            "(the api_key of an OpenAI SDK). Keys are issued in the llm-proxy panel.",
                       "missing_api_key")
    if scheme.lower() != "bearer" or not token:
        raise ApiError(401, "Invalid Authorization header (use: Bearer <key>).", "invalid_api_key")
    row = store().get_key_by_hash(sha256_hex(token))
    if not row:
        raise ApiError(401, "Invalid API key.", "invalid_api_key")
    if not row["active"]:
        raise ApiError(403, f"API key '{row['name']}' is disabled.", "api_key_disabled")
    if row["expires_at"] and row["expires_at"] <= time.time():
        raise ApiError(403, f"API key '{row['name']}' has expired.", "api_key_expired")
    if not row["last_used_at"] or time.time() - row["last_used_at"] > TOUCH_EVERY:
        store().touch_key(row["id"], client_ip(request))
    models = parse_models(row["models"])
    return Caller(row["id"], row["name"], None if models is None else frozenset(models),
                  bool(row["tools"]), row["daily_tokens"], row["monthly_tokens"])


def check_limits(caller: Caller) -> None:
    """429 when today's / the last 30 days' tokens have reached the limit.
    Checked before a request starts, so one request can go over a little."""
    if not caller.daily_tokens and not caller.monthly_tokens:
        return
    now = time.time()
    day, _, month = windows(now)
    reset_in = max(1, int(next_midnight(now) - now))
    when = f"{reset_in // 3600}h {reset_in % 3600 // 60}m"
    if caller.daily_tokens:
        used = store().key_tokens_since(caller.id, day)
        if used >= caller.daily_tokens:
            raise ApiError(429, f"Daily token limit reached for '{caller.name}': "
                                f"{used:,}/{caller.daily_tokens:,} today (resets at 00:00 Tehran, in {when}).",
                           "daily_limit_reached", "rate_limit_error", {"Retry-After": str(reset_in)})
    if caller.monthly_tokens:
        used = store().key_tokens_since(caller.id, month)
        if used >= caller.monthly_tokens:
            raise ApiError(429, f"30-day token limit reached for '{caller.name}': "
                                f"{used:,}/{caller.monthly_tokens:,} over the last 30 days.",
                           "monthly_limit_reached", "rate_limit_error", {"Retry-After": str(reset_in)})


def resolve_model(caller: Caller, reg, requested: str | None):
    """The model to serve. A model the key may not use is refused; an unknown
    or missing model goes to the default, or the key's first allowed model."""
    if requested and requested in reg.models:
        if not caller.allows(requested):
            raise ApiError(403, f"API key '{caller.name}' may not use model '{requested}'.",
                           "model_not_allowed")
        return reg.models[requested]
    if caller.allows(reg.default_model):
        return reg.models[reg.default_model]
    for alias, m in reg.models.items():
        if caller.allows(alias):
            return m
    raise ApiError(403, f"API key '{caller.name}' has no usable model.", "model_not_allowed")

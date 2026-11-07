"""Admin endpoints for project API keys (/api/keys). The plaintext key is
returned once — on create and on rotate — and never stored."""
import sqlite3
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

import apikeys
import config_store as cs
from providers import get_registry
from stats import store

router = APIRouter(prefix="/api/keys")


class KeyBody(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    models: list[str] | None = None          # None = every model
    tools: bool = True
    daily_tokens: int | None = Field(default=None, ge=1)
    monthly_tokens: int | None = Field(default=None, ge=1)
    expires_at: float | None = None
    note: str | None = Field(default=None, max_length=500)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name is required")
        return v


class KeyPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=40)
    models: list[str] | None = None
    all_models: bool | None = None           # true -> models = None (every model)
    tools: bool | None = None
    daily_tokens: int | None = Field(default=None, ge=0)     # 0 = remove the limit
    monthly_tokens: int | None = Field(default=None, ge=0)
    expires_at: float | None = Field(default=None, ge=0)     # 0 = never expires
    active: bool | None = None
    note: str | None = Field(default=None, max_length=500)


def _known_models() -> set[str]:
    """Aliases in providers.yaml, including ones inactive right now."""
    try:
        return set(cs.read_raw().get("models") or {}) | set(get_registry().models)
    except Exception:
        return set(get_registry().models)


def _check_models(models: list[str] | None) -> list[str] | None:
    if models is None:
        return None
    models = [m.strip() for m in models if m and m.strip()]
    if not models:
        raise HTTPException(422, "Pick at least one model, or allow every model.")
    unknown = sorted(set(models) - _known_models())
    if unknown:
        raise HTTPException(422, f"Unknown model(s): {', '.join(unknown)}")
    return models


def _public(row: dict, usage: dict | None = None, by_model: list | None = None) -> dict:
    """A key as the panel sees it — never the hash."""
    now = time.time()
    expired = bool(row["expires_at"] and row["expires_at"] <= now)
    u = usage or {}
    active_models = set(get_registry().models)
    models = apikeys.parse_models(row["models"])
    return {
        "id": row["id"],
        "name": row["name"],
        "prefix": row["prefix"],
        "models": models,                               # None = every model
        "missing_models": sorted(set(models or []) - active_models),
        "tools": bool(row["tools"]),
        "daily_tokens": row["daily_tokens"],
        "monthly_tokens": row["monthly_tokens"],
        "expires_at": row["expires_at"],
        "active": bool(row["active"]),
        "expired": expired,
        "state": "disabled" if not row["active"] else ("expired" if expired else "active"),
        "note": row["note"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "last_used_at": row["last_used_at"],
        "last_used_ip": row["last_used_ip"],
        "usage": {
            "today_requests": u.get("today_requests") or 0,
            "today_tokens": u.get("today_tokens") or 0,
            "week_requests": u.get("week_requests") or 0,
            "week_tokens": u.get("week_tokens") or 0,
            "month_requests": u.get("month_requests") or 0,
            "month_tokens": u.get("month_tokens") or 0,
            "month_errors": u.get("month_errors") or 0,
            "last_ts": u.get("last_ts"),
            "by_model": by_model or [],
        },
    }


def _get(key_id: int) -> dict:
    row = store().get_key(key_id)
    if not row:
        raise HTTPException(404, "Unknown key")
    return row


@router.get("")
async def list_keys():
    day, week, month = apikeys.windows()
    usage = store().key_usage(day, week, month)
    by_model = store().key_models(month)
    keys = [_public(r, usage.get(r["id"]), by_model.get(r["id"])) for r in store().list_keys()]
    known = {k["id"] for k in keys}
    # traffic from deleted keys and from before keys existed (key_id 0)
    other = [{"key_id": kid, "deleted": kid != 0, **u, "by_model": by_model.get(kid, [])}
             for kid, u in usage.items() if kid not in known]
    return {"keys": keys, "other": other, "day_start": day, "timezone": "Asia/Tehran",
            "models": list(get_registry().models)}


@router.post("")
async def create_key(body: KeyBody):
    models = _check_models(body.models)
    plaintext, prefix, key_hash = apikeys.generate(body.name)
    try:
        row = store().create_key({
            "name": body.name, "models": apikeys.dump_models(models), "tools": body.tools,
            "daily_tokens": body.daily_tokens, "monthly_tokens": body.monthly_tokens,
            "expires_at": body.expires_at, "active": True,
            "note": (body.note or "").strip() or None,
        }, prefix, key_hash)
    except sqlite3.IntegrityError:
        raise HTTPException(409, f"A key named '{body.name}' already exists.")
    return {**_public(row), "key": plaintext}


@router.patch("/{key_id}")
async def update_key(key_id: int, body: KeyPatch):
    _get(key_id)
    data = body.model_dump(exclude_unset=True)
    fields: dict = {}
    if "name" in data:
        name = (data["name"] or "").strip()
        if not name:
            raise HTTPException(422, "name is required")
        fields["name"] = name
    if data.get("all_models"):
        fields["models"] = None
    elif "models" in data and data["models"] is not None:
        fields["models"] = apikeys.dump_models(_check_models(data["models"]))
    for k in ("daily_tokens", "monthly_tokens", "expires_at"):
        if k in data:
            fields[k] = data[k] or None                 # 0 / null clears it
    for k in ("tools", "active"):
        if data.get(k) is not None:
            fields[k] = data[k]
    if "note" in data:
        fields["note"] = (data["note"] or "").strip() or None
    try:
        row = store().update_key(key_id, fields)
    except sqlite3.IntegrityError:
        raise HTTPException(409, f"A key named '{fields.get('name')}' already exists.")
    return _public(row)


@router.post("/{key_id}/rotate")
async def rotate_key(key_id: int):
    row = _get(key_id)
    plaintext, prefix, key_hash = apikeys.generate(row["name"])
    return {**_public(store().replace_key_secret(key_id, prefix, key_hash)), "key": plaintext}


@router.delete("/{key_id}")
async def delete_key(key_id: int):
    _get(key_id)
    store().delete_key(key_id)
    return {"ok": True}

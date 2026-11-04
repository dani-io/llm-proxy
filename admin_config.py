"""Admin endpoints that change providers.yaml / keys (phase 2)."""
import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import config_store as cs
import health
import keystore
from providers import get_registry

router = APIRouter(prefix="/api/config")
_lock = asyncio.Lock()     # one writer at a time


class ProviderBody(BaseModel):
    base_url: str = Field(max_length=500)
    timeout: float = 120
    api_key_env: str | None = Field(default=None, max_length=64)
    headers: dict[str, str] = {}
    stream_usage: bool = True
    key: str | None = Field(default=None, max_length=4000)   # optional: set key in the same step


class KeyBody(BaseModel):
    key: str = Field(default="", max_length=4000)            # empty = remove


class ModelBody(BaseModel):
    provider: str
    model: str = Field(min_length=1, max_length=300)
    tools: bool = True
    fallback: str | None = None
    description: str = Field(default="", max_length=300)


class DefaultBody(BaseModel):
    model: str


def _fail(e: Exception):
    raise HTTPException(422, str(e))


@router.get("")
async def get_config():
    return cs.view()


@router.post("/reload")
async def reload_config():
    async with _lock:
        try:
            return cs.reload()
        except cs.ConfigError as e:
            _fail(e)


@router.put("/providers/{name}")
async def put_provider(name: str, body: ProviderBody):
    async with _lock:
        raw = cs.read_raw()
        old = raw["providers"].get(name, {})
        env = (body.api_key_env or "").strip() or old.get("api_key_env")
        if body.key and not env:
            env = f"{name.upper().replace('-', '_')}_API_KEY"
        raw["providers"][name] = {
            **old,
            "base_url": body.base_url.strip(),
            "timeout": body.timeout,
            "api_key_env": env or None,
            "headers": body.headers,
            "stream_usage": body.stream_usage,
        }
        errs = cs.validate(raw)
        if errs:
            _fail(cs.ConfigError("; ".join(errs)))
        try:
            if body.key:
                keystore.set_key(env, body.key)
            return cs.save(raw)
        except (cs.ConfigError, ValueError) as e:
            _fail(e)


@router.delete("/providers/{name}")
async def delete_provider(name: str):
    async with _lock:
        raw = cs.read_raw()
        if name not in raw["providers"]:
            raise HTTPException(404, f"Unknown provider {name}")
        users = [a for a, m in raw["models"].items() if m.get("provider") == name]
        if users:
            raise HTTPException(409, f"Provider {name} is used by: {', '.join(users)}. Delete or move those models first.")
        env = raw["providers"][name].get("api_key_env")
        del raw["providers"][name]
        try:
            result = cs.save(raw)
        except cs.ConfigError as e:
            _fail(e)
        # drop a panel-stored key nobody references any more
        if env and keystore.read().get(env) and not any(
                p.get("api_key_env") == env for p in raw["providers"].values()):
            keystore.set_key(env, None)
        health.providers.pop(name, None)
        health.last_probe.pop(name, None)
        return result


@router.put("/providers/{name}/key")
async def put_key(name: str, body: KeyBody):
    async with _lock:
        raw = cs.read_raw()
        p = raw["providers"].get(name)
        if p is None:
            raise HTTPException(404, f"Unknown provider {name}")
        env = p.get("api_key_env")
        if not env:
            if not body.key:
                return cs.view()
            env = f"{name.upper().replace('-', '_')}_API_KEY"
            p["api_key_env"] = env
        try:
            keystore.set_key(env, body.key or None)
            health.last_probe.pop(name, None)     # list may differ per key
            return cs.save(raw)        # writes api_key_env if new, and reloads
        except (cs.ConfigError, ValueError) as e:
            _fail(e)


@router.put("/models/{alias}")
async def put_model(alias: str, body: ModelBody):
    async with _lock:
        raw = cs.read_raw()
        old = raw["models"].get(alias, {})
        raw["models"][alias] = {
            **old,
            "provider": body.provider,
            "model": body.model.strip(),
            "tools": body.tools,
            "fallback": body.fallback or None,
            "description": body.description.strip(),
        }
        if not raw.get("default_model"):
            raw["default_model"] = alias
        try:
            return cs.save(raw)
        except cs.ConfigError as e:
            _fail(e)


@router.delete("/models/{alias}")
async def delete_model(alias: str):
    async with _lock:
        raw = cs.read_raw()
        if alias not in raw["models"]:
            raise HTTPException(404, f"Unknown model {alias}")
        if raw.get("default_model") == alias:
            raise HTTPException(409, f"{alias} is the default model — make another model the default first.")
        users = [a for a, m in raw["models"].items() if m.get("fallback") == alias]
        if users:
            raise HTTPException(409, f"{alias} is the fallback of: {', '.join(users)}. Change their fallback first.")
        del raw["models"][alias]
        try:
            result = cs.save(raw)
        except cs.ConfigError as e:
            _fail(e)
        health.models.pop(alias, None)
        return result


@router.put("/default")
async def put_default(body: DefaultBody):
    async with _lock:
        raw = cs.read_raw()
        if body.model not in raw["models"]:
            raise HTTPException(404, f"Unknown model {body.model}")
        if body.model not in get_registry().models:
            raise HTTPException(409, f"{body.model} is inactive — the default must be a working model.")
        raw["default_model"] = body.model
        try:
            return cs.save(raw)
        except cs.ConfigError as e:
            _fail(e)

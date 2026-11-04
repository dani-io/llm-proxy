"""
Read / validate / write providers.yaml for the admin panel, then hot-reload
the registry. Every write keeps a timestamped backup in data/backups/.
Hand edits stay possible: edit the file, then Reload in the panel (or restart).
"""
import glob
import os
import re
import shutil
import tempfile
import time

import yaml

import config
import keystore
from providers import _is_lan, get_registry, reload_registry

PROVIDER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$")
ALIAS_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
BACKUP_DIR = os.path.join(os.path.dirname(os.path.abspath(config.STATS_DB)), "backups")
KEEP_BACKUPS = 30

HEADER = """\
# llm-proxy providers & models.
# Managed from the admin panel (port {port}); hand edits are fine too — then
# press "Reload from disk" in Settings or restart the service. Comments are not
# preserved when the panel saves. All options: providers.example.yaml.
# API keys never go here: api_key_env names a variable that is looked up in
# data/provider-keys.env (keys set in the panel) and then in .env.
"""


class ConfigError(ValueError):
    pass


# ─── read ─────────────────────────────────────────────────────
def read_raw() -> dict:
    """Current providers.yaml as a plain dict. Without the file, start from the
    legacy single-model setup so the first save creates a working file."""
    if os.path.exists(config.PROVIDERS_FILE):
        with open(config.PROVIDERS_FILE, encoding="utf-8") as f:
            raw = yaml.safe_load(f) or {}
    else:
        raw = {
            "default_model": config.LLAMA_MODEL,
            "providers": {"local": {"base_url": config.LLAMA_URL.rstrip("/") + "/v1",
                                    "timeout": config.LLAMA_TIMEOUT}},
            "models": {config.LLAMA_MODEL: {"provider": "local", "model": config.LLAMA_MODEL}},
        }
    raw.setdefault("providers", {})
    raw.setdefault("models", {})
    raw["providers"] = raw["providers"] or {}
    raw["models"] = raw["models"] or {}
    return raw


def view() -> dict:
    """Config for the panel: every entry, active or not, keys only as hints."""
    raw = read_raw()
    reg = get_registry()
    providers = []
    for name, p in raw["providers"].items():
        env = p.get("api_key_env")
        value, source = keystore.get(env) if env else (None, None)
        providers.append({
            "name": name,
            "base_url": p.get("base_url", ""),
            "timeout": p.get("timeout", 120),
            "api_key_env": env,
            "key": {"required": bool(env), "set": bool(value), "source": source,
                    "hint": keystore.hint(value)},
            "headers": p.get("headers") or {},
            "stream_usage": p.get("stream_usage", True),
            "external": not _is_lan(str(p.get("base_url", ""))),
            "active": name in reg.providers,
            "skipped_reason": reg.skipped["providers"].get(name),
            "models": [a for a, m in raw["models"].items() if m.get("provider") == name],
        })
    models = []
    for alias, m in raw["models"].items():
        models.append({
            "alias": alias,
            "provider": m.get("provider"),
            "model": m.get("model", alias),
            "tools": m.get("tools", True),
            "fallback": m.get("fallback"),
            "description": m.get("description", ""),
            "active": alias in reg.models,
            "skipped_reason": reg.skipped["models"].get(alias),
            "used_as_fallback_by": [a for a, o in raw["models"].items() if o.get("fallback") == alias],
        })
    return {
        "file": config.PROVIDERS_FILE,
        "file_exists": os.path.exists(config.PROVIDERS_FILE),
        "keys_file": config.KEYS_FILE,
        "legacy": reg.legacy,
        "default_model": raw.get("default_model"),
        "active_default": reg.default_model,
        "providers": providers,
        "models": models,
        "backups": len(glob.glob(os.path.join(BACKUP_DIR, "providers-*.yaml"))),
    }


# ─── validate ─────────────────────────────────────────────────
def validate(raw: dict) -> list[str]:
    errs = []
    provs, models = raw.get("providers") or {}, raw.get("models") or {}
    for name, p in provs.items():
        if not PROVIDER_RE.match(name):
            errs.append(f"provider name {name!r}: letters, digits, - or _ only")
        url = str(p.get("base_url", ""))
        if not re.match(r"^https?://[^\s/]+", url):
            errs.append(f"provider {name}: base_url must start with http:// or https://")
        try:
            t = float(p.get("timeout", 120))
            if not 1 <= t <= 900:
                raise ValueError
        except (TypeError, ValueError):
            errs.append(f"provider {name}: timeout must be 1–900 seconds")
        env = p.get("api_key_env")
        if env and not keystore.NAME_RE.match(env):
            errs.append(f"provider {name}: api_key_env must look like FOO_API_KEY")
        if not isinstance(p.get("headers") or {}, dict):
            errs.append(f"provider {name}: headers must be a mapping")
    for alias, m in models.items():
        if not ALIAS_RE.match(alias):
            errs.append(f"model name {alias!r}: letters, digits and . _ : - only")
        if m.get("provider") not in provs:
            errs.append(f"model {alias}: provider {m.get('provider')!r} does not exist")
        if not str(m.get("model") or "").strip():
            errs.append(f"model {alias}: upstream model id is empty")
        fb = m.get("fallback")
        if fb is not None:
            if fb == alias:
                errs.append(f"model {alias}: cannot fall back to itself")
            elif fb not in models:
                errs.append(f"model {alias}: fallback {fb!r} does not exist")
    if not models:
        errs.append("at least one model is required")
    elif raw.get("default_model") not in models:
        errs.append(f"default model {raw.get('default_model')!r} does not exist")
    return errs


# ─── write ────────────────────────────────────────────────────
def _backup() -> None:
    if not os.path.exists(config.PROVIDERS_FILE):
        return
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    shutil.copy2(config.PROVIDERS_FILE, os.path.join(BACKUP_DIR, f"providers-{stamp}.yaml"))
    for old in sorted(glob.glob(os.path.join(BACKUP_DIR, "providers-*.yaml")))[:-KEEP_BACKUPS]:
        os.unlink(old)


def _clean(raw: dict) -> dict:
    """Drop defaults/empties so the file stays short and readable."""
    out = {"default_model": raw["default_model"], "providers": {}, "models": {}}
    for name, p in raw["providers"].items():
        q = {"base_url": str(p["base_url"]).rstrip("/")}
        if float(p.get("timeout", 120)) != 120:
            t = float(p["timeout"])
            q["timeout"] = int(t) if t.is_integer() else t
        if p.get("api_key_env"):
            q["api_key_env"] = p["api_key_env"]
        if p.get("headers"):
            q["headers"] = p["headers"]
        if p.get("stream_usage", True) is False:
            q["stream_usage"] = False
        out["providers"][name] = q
    for alias, m in raw["models"].items():
        q = {"provider": m["provider"], "model": str(m["model"]).strip()}
        if m.get("tools", True) is False:
            q["tools"] = False
        if m.get("fallback"):
            q["fallback"] = m["fallback"]
        if m.get("external") is not None:
            q["external"] = bool(m["external"])
        if m.get("description"):
            q["description"] = str(m["description"]).strip()
        out["models"][alias] = q
    return out


def save(raw: dict) -> dict:
    errs = validate(raw)
    if errs:
        raise ConfigError("; ".join(errs))
    text = HEADER.format(port=config.ADMIN_PORT) + "\n" + yaml.safe_dump(
        _clean(raw), sort_keys=False, allow_unicode=True, default_flow_style=False, width=100)
    _backup()
    d = os.path.dirname(os.path.abspath(config.PROVIDERS_FILE))
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".providers-", suffix=".yaml")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        if os.path.exists(config.PROVIDERS_FILE):
            shutil.copymode(config.PROVIDERS_FILE, tmp)
        os.replace(tmp, config.PROVIDERS_FILE)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    reload_registry()
    return view()


def reload() -> dict:
    if os.path.exists(config.PROVIDERS_FILE):
        errs = validate(read_raw())
        if errs:
            raise ConfigError("providers.yaml has errors — not reloaded: " + "; ".join(errs))
    reload_registry()
    return view()

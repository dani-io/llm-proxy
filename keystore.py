"""
API keys set from the admin panel, kept in their own file (KEYS_FILE, mode
0600) so the hand-edited .env is never rewritten. Lookup order for a
provider's api_key_env: this file first, then the process environment (.env).
"""
import os
import re
import tempfile

import config

NAME_RE = re.compile(r"^[A-Z_][A-Z0-9_]*$")


def read() -> dict[str, str]:
    keys: dict[str, str] = {}
    try:
        with open(config.KEYS_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                keys[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    return keys


def get(name: str) -> tuple[str | None, str | None]:
    """(value, source) — source is 'panel', 'env' or None."""
    v = read().get(name)
    if v:
        return v, "panel"
    v = os.getenv(name)
    if v:
        return v, "env"
    return None, None


def set_key(name: str, value: str | None) -> None:
    """Store (or with an empty value, remove) a key; atomic, 0600."""
    if not NAME_RE.match(name):
        raise ValueError(f"invalid key name {name!r}")
    if value and ("\n" in value or "\r" in value):
        raise ValueError("key must be a single line")
    keys = read()
    if value:
        keys[name] = value.strip()
    else:
        keys.pop(name, None)

    d = os.path.dirname(os.path.abspath(config.KEYS_FILE))
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".keys-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write("# API keys set from the llm-proxy admin panel. Do not commit.\n")
            for k, v in sorted(keys.items()):
                f.write(f"{k}={v}\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, config.KEYS_FILE)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def hint(value: str | None) -> str | None:
    if not value:
        return None
    return f"…{value[-4:]}" if len(value) > 8 else "set"

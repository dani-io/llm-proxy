"""
Provider / model registry.

Loads providers.yaml (path from PROVIDERS_FILE). Every model alias maps to
one provider (an OpenAI-compatible base_url) plus the upstream model id.

If providers.yaml is missing, a single local provider is built from the
legacy LLAMA_URL / LLAMA_MODEL env vars, so old deployments keep working.
"""
import logging
import os
from dataclasses import dataclass, field

import yaml

import config

log = logging.getLogger("llm-proxy.providers")


@dataclass
class Provider:
    name: str
    base_url: str                      # ends with /v1
    api_key: str | None = None
    timeout: float = 120.0
    headers: dict = field(default_factory=dict)

    def request_headers(self) -> dict:
        h = dict(self.headers)
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h


@dataclass
class Model:
    alias: str                         # name clients use
    provider: Provider
    upstream_model: str                # name sent to the provider
    tools: bool = True                 # model supports tool calling
    fallback: str | None = None        # alias to try if this one fails
    external: bool = False             # data leaves the LAN
    description: str = ""


class Registry:
    def __init__(self, providers: dict, models: dict, default_model: str):
        self.providers = providers
        self.models = models
        self.default_model = default_model

    def resolve(self, requested: str | None) -> Model:
        """Return the model for an alias; unknown/missing -> default model."""
        if requested and requested in self.models:
            return self.models[requested]
        if requested:
            log.info("unknown model %r -> default %r", requested, self.default_model)
        return self.models[self.default_model]

    def fallback_chain(self, model: Model) -> list[Model]:
        """model, then its fallback, then the fallback's fallback… (no loops)."""
        chain, seen = [model], {model.alias}
        while chain[-1].fallback and chain[-1].fallback not in seen:
            nxt = self.models.get(chain[-1].fallback)
            if not nxt:
                log.warning("fallback %r of %r is not defined", chain[-1].fallback, chain[-1].alias)
                break
            chain.append(nxt)
            seen.add(nxt.alias)
        return chain


def _legacy_registry() -> Registry:
    local = Provider(
        name="local",
        base_url=config.LLAMA_URL.rstrip("/") + "/v1",
        timeout=config.LLAMA_TIMEOUT,
    )
    alias = config.LLAMA_MODEL
    return Registry(
        providers={"local": local},
        models={alias: Model(alias=alias, provider=local, upstream_model=alias)},
        default_model=alias,
    )


def load_registry(path: str | None = None) -> Registry:
    path = path or config.PROVIDERS_FILE
    if not os.path.exists(path):
        log.warning("%s not found — using legacy LLAMA_URL only", path)
        return _legacy_registry()

    with open(path, encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}

    providers: dict[str, Provider] = {}
    for name, p in (raw.get("providers") or {}).items():
        key = None
        if p.get("api_key_env"):
            key = os.getenv(p["api_key_env"])
            if not key:
                log.warning("provider %r: env %s is empty — its models are skipped",
                            name, p["api_key_env"])
                continue
        providers[name] = Provider(
            name=name,
            base_url=str(p["base_url"]).rstrip("/"),
            api_key=key,
            timeout=float(p.get("timeout", 120)),
            headers=p.get("headers") or {},
        )

    models: dict[str, Model] = {}
    for alias, m in (raw.get("models") or {}).items():
        prov = providers.get(m.get("provider"))
        if not prov:
            log.warning("model %r: provider %r unavailable — skipped", alias, m.get("provider"))
            continue
        models[alias] = Model(
            alias=alias,
            provider=prov,
            upstream_model=m.get("model", alias),
            tools=bool(m.get("tools", True)),
            fallback=m.get("fallback"),
            external=bool(m.get("external", not _is_lan(prov.base_url))),
            description=m.get("description", ""),
        )

    if not models:
        log.error("no usable models in %s — falling back to legacy config", path)
        return _legacy_registry()

    default = raw.get("default_model") or next(iter(models))
    if default not in models:
        first = next(iter(models))
        log.error("default_model %r unavailable — using %r", default, first)
        default = first

    log.info("loaded %d provider(s), %d model(s), default=%s: %s",
             len(providers), len(models), default, ", ".join(models))
    return Registry(providers, models, default)


def _is_lan(url: str) -> bool:
    host = url.split("://", 1)[-1].split("/", 1)[0].split(":", 1)[0]
    return (host.startswith(("192.168.", "10.", "127.", "localhost"))
            or host.endswith(".bp")
            or any(host.startswith(f"172.{i}.") for i in range(16, 32)))

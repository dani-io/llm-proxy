"""
Entry point: runs the model API (PORT) and the admin panel (ADMIN_PORT) in one
process, so the panel sees live provider health and shares the registry.

    python server.py        (python proxy.py does the same)
"""
import asyncio
import logging

import uvicorn

import config
import health
from providers import get_registry

log = logging.getLogger("llm-proxy")


async def _main() -> None:
    import proxy                      # imported here so both apps share one module copy
    servers = [uvicorn.Server(uvicorn.Config(
        proxy.app, host=config.HOST, port=config.PORT, log_level=config.LOG_LEVEL))]
    if config.ADMIN_PORT:
        import admin
        servers.append(uvicorn.Server(uvicorn.Config(
            admin.admin_app, host=config.ADMIN_HOST, port=config.ADMIN_PORT,
            log_level=config.LOG_LEVEL)))
        log.info("admin panel on %s:%d", config.ADMIN_HOST, config.ADMIN_PORT)

    probe = asyncio.create_task(health.probe_loop(get_registry))
    try:
        await asyncio.gather(*(s.serve() for s in servers))
    finally:
        probe.cancel()


def run() -> None:
    if config.RELOAD:
        # dev convenience: API only, auto-reload
        uvicorn.run("proxy:app", host=config.HOST, port=config.PORT, reload=True,
                    log_level=config.LOG_LEVEL)
        return
    asyncio.run(_main())


if __name__ == "__main__":
    run()

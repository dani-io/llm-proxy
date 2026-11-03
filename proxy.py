"""
llm-proxy — OpenAI-compatible gateway with server-side tool calling.

Design:
  - Accepts OpenAI-compatible /v1/chat/completions requests
  - Routes by `model` to a provider from providers.yaml (local llama-server,
    OpenRouter, any OpenAI-compatible API); unknown model -> default model
  - Server tools (web_search, fetch_url) are executed here, in a loop, for
    every model that supports tool calling — local or external
  - Client tools (e.g. OpenCode's) are merged in and passed back to the
    client untouched when the model calls them
  - On upstream failure (network, 429, 5xx, bad key…) the request moves to
    the model's `fallback` and stays there for the rest of the request
  - Streaming streams every turn live; tool-call turns are executed silently
"""
import json
import logging
import time
import uuid

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

import config
from providers import Model, load_registry
from tools import fetch_url, web_search


logging.basicConfig(
    level=getattr(logging, config.LOG_LEVEL.upper()),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("llm-proxy")


# ─── Tool registry ────────────────────────────────────────────
TOOLS = {
    "web_search": {"schema": web_search.TOOL_SCHEMA, "execute": web_search.execute},
    "fetch_url": {"schema": fetch_url.TOOL_SCHEMA, "execute": fetch_url.execute},
}
SERVER_TOOLS_SCHEMA = [t["schema"] for t in TOOLS.values()]

BUDGET_MSG = ("You have used all tool call budget. Provide your final answer "
              "now based on the information gathered so far.")

registry = load_registry()

app = FastAPI(title="llm-proxy", version="0.2.0")


class UpstreamError(Exception):
    def __init__(self, model: Model, status: int, detail: str):
        super().__init__(f"{model.alias}: HTTP {status}: {detail[:300]}")
        self.model, self.status, self.detail = model, status, detail


# ─── Info endpoints ───────────────────────────────────────────
@app.get("/health")
async def health():
    return {
        "status": "ok",
        "tools": list(TOOLS),
        "default_model": registry.default_model,
        "models": list(registry.models),
    }


@app.get("/v1/models")
async def list_models():
    now = int(time.time())
    return {
        "object": "list",
        "data": [
            {
                "id": m.alias,
                "object": "model",
                "created": now,
                "owned_by": m.provider.name,
                "upstream_model": m.upstream_model,
                "tools": m.tools,
                "external": m.external,
                "fallback": m.fallback,
                "default": m.alias == registry.default_model,
                "description": m.description,
            }
            for m in registry.models.values()
        ],
    }


# ─── Helpers ──────────────────────────────────────────────────
def _tool_name(schema: dict) -> str:
    return schema.get("function", {}).get("name", "")


def merge_tools(model: Model, client_tools: list) -> tuple[list, set]:
    """Client tools + server tools (client wins on name clash).
    Returns (tools to send, names the proxy executes itself)."""
    if not model.tools:
        return client_tools, set()
    client_names = {_tool_name(t) for t in client_tools}
    server = [t for t in SERVER_TOOLS_SCHEMA if _tool_name(t) not in client_names]
    return client_tools + server, {_tool_name(t) for t in server}


def build_payload(model: Model, body: dict, messages: list, tools: list, stream: bool) -> dict:
    payload = {k: v for k, v in body.items()
               if k not in ("messages", "tools", "tool_choice", "stream", "model")}
    payload.update(model=model.upstream_model, messages=messages, stream=stream)
    if tools:  # OpenAI-style APIs reject an empty tools array
        payload["tools"] = tools
        if "tool_choice" in body:
            payload["tool_choice"] = body["tool_choice"]
    return payload


def clean_assistant_msg(msg: dict) -> dict:
    """Assistant turn to send back upstream — drop provider-specific fields
    (reasoning_content etc.) that other providers may reject."""
    return {"role": "assistant", "content": msg.get("content") or "",
            "tool_calls": msg.get("tool_calls") or []}


async def execute_tool_call(tool_call: dict) -> dict:
    call_id = tool_call.get("id") or "call_" + uuid.uuid4().hex[:12]
    fn = tool_call.get("function", {})
    name = fn.get("name", "")
    raw_args = fn.get("arguments") or "{}"
    log.info("tool_call: %s(%s)", name, str(raw_args)[:200])

    try:
        args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
        content = await TOOLS[name]["execute"](**args)
    except json.JSONDecodeError as e:
        content = f"Error: invalid JSON arguments for {name}: {e}"
    except TypeError as e:
        content = f"Error: bad arguments for {name}: {e}"
    except Exception as e:
        log.exception("tool %s failed", name)
        content = f"Error executing {name}: {type(e).__name__}: {e}"

    return {"role": "tool", "tool_call_id": call_id, "content": content}


# ─── Upstream calls ───────────────────────────────────────────
async def post_chat(model: Model, payload: dict) -> dict:
    url = f"{model.provider.base_url}/chat/completions"
    try:
        async with httpx.AsyncClient(timeout=model.provider.timeout) as client:
            resp = await client.post(url, json=payload, headers=model.provider.request_headers())
    except httpx.HTTPError as e:
        raise UpstreamError(model, 502, f"{type(e).__name__}: {e}") from e
    if resp.status_code >= 400:
        raise UpstreamError(model, resp.status_code, resp.text)
    try:
        data = resp.json()
        data["choices"][0]["message"]
    except (ValueError, KeyError, IndexError, TypeError):
        raise UpstreamError(model, 502, f"malformed response: {resp.text[:300]}")
    return data


async def call_chain(chain: list[Model], body: dict, messages: list,
                     client_tools: list, force_no_tools: bool = False):
    """Try each model in the chain; return (index, response, server_tool_names)."""
    last_err = None
    for i, model in enumerate(chain):
        tools, server_names = ([], set()) if force_no_tools else merge_tools(model, client_tools)
        try:
            data = await post_chat(model, build_payload(model, body, messages, tools, False))
            if i:
                log.warning("served by fallback %s", model.alias)
            return i, data, server_names
        except UpstreamError as e:
            log.warning("upstream failed: %s", e)
            last_err = e
    raise last_err


# ─── Non-streaming ────────────────────────────────────────────
async def handle_non_stream(body: dict, chain: list[Model]):
    messages = list(body.get("messages", []))
    client_tools = body.get("tools") or []

    for loop in range(config.MAX_TOOL_LOOPS):
        log.info("loop %d/%d [%s]", loop + 1, config.MAX_TOOL_LOOPS, chain[0].alias)
        i, resp, server_names = await call_chain(chain, body, messages, client_tools)
        chain = chain[i:]                       # sticky fallback
        resp["model"] = chain[0].alias

        msg = resp["choices"][0]["message"]
        tool_calls = msg.get("tool_calls") or []
        if not tool_calls:
            log.info("done after %d loops, finish_reason=%s",
                     loop + 1, resp["choices"][0].get("finish_reason"))
            return resp
        names = {tc.get("function", {}).get("name") for tc in tool_calls}
        if not names <= server_names:
            log.info("client tool call(s) %s -> returned to client", names - server_names)
            return resp

        messages.append(clean_assistant_msg(msg))
        for tc in tool_calls:
            messages.append(await execute_tool_call(tc))

    log.warning("MAX_TOOL_LOOPS reached, forcing final answer")
    messages.append({"role": "user", "content": BUDGET_MSG})
    i, resp, _ = await call_chain(chain, body, messages, client_tools, force_no_tools=True)
    resp["model"] = chain[i].alias
    return resp


# ─── Streaming ────────────────────────────────────────────────
def sse(obj) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


async def handle_stream(body: dict, chain: list[Model]):
    """Every turn is streamed from upstream. Content chunks go to the client
    live; tool-call chunks are held back. If all held calls are server tools
    they are executed and the loop continues; otherwise they are flushed to
    the client (client tools)."""

    async def gen():
        nonlocal chain
        messages = list(body.get("messages", []))
        client_tools = body.get("tools") or []

        for loop in range(config.MAX_TOOL_LOOPS + 1):
            final_turn = loop == config.MAX_TOOL_LOOPS
            if final_turn:
                log.warning("MAX_TOOL_LOOPS reached, forcing final answer")
                messages.append({"role": "user", "content": BUDGET_MSG})

            opened = False
            for i, model in enumerate(chain):
                tools, server_names = ([], set()) if final_turn else merge_tools(model, client_tools)
                payload = build_payload(model, body, messages, tools, True)
                acc: dict[int, dict] = {}       # index -> accumulated tool call
                held: list[str] = []            # raw tool-call chunks, flushed only for client tools
                sent_any = False
                try:
                    async with httpx.AsyncClient(timeout=model.provider.timeout) as client:
                        async with client.stream(
                            "POST", f"{model.provider.base_url}/chat/completions",
                            json=payload, headers=model.provider.request_headers(),
                        ) as resp:
                            if resp.status_code >= 400:
                                detail = (await resp.aread()).decode(errors="replace")
                                raise UpstreamError(model, resp.status_code, detail)
                            opened = True
                            chain = chain[i:]
                            if i:
                                log.warning("served by fallback %s", model.alias)
                            log.info("stream turn %d [%s]", loop + 1, model.alias)

                            async for line in resp.aiter_lines():
                                if not line.startswith("data:"):
                                    continue
                                data = line[5:].strip()
                                if data == "[DONE]":
                                    break
                                try:
                                    chunk = json.loads(data)
                                except ValueError:
                                    continue
                                chunk["model"] = model.alias
                                choices = chunk.get("choices") or []
                                delta = (choices[0].get("delta") or {}) if choices else {}
                                finish = choices[0].get("finish_reason") if choices else None

                                if delta.get("tool_calls"):
                                    for tc in delta["tool_calls"]:
                                        slot = acc.setdefault(tc.get("index", 0), {
                                            "id": None, "type": "function",
                                            "function": {"name": "", "arguments": ""}})
                                        if tc.get("id"):
                                            slot["id"] = tc["id"]
                                        f = tc.get("function") or {}
                                        slot["function"]["name"] += f.get("name") or ""
                                        slot["function"]["arguments"] += f.get("arguments") or ""
                                    held.append(sse(chunk))
                                    continue
                                if finish == "tool_calls" or (acc and finish):
                                    held.append(sse(chunk))
                                    continue
                                sent_any = True
                                yield sse(chunk)
                    break                       # this turn is done
                except (UpstreamError, httpx.HTTPError) as e:
                    log.warning("upstream failed (stream): %s", e)
                    if sent_any:                # can't switch provider mid-answer
                        yield sse({"error": {"message": f"upstream stream broke: {e}"}})
                        yield "data: [DONE]\n\n"
                        return
                    opened = False
                    continue

            if not opened:
                yield sse({"error": {"message": "all upstream models failed",
                                     "models": [m.alias for m in chain]}})
                yield "data: [DONE]\n\n"
                return

            if not acc:
                break                           # final answer streamed
            calls = [acc[k] for k in sorted(acc)]
            names = {c["function"]["name"] for c in calls}
            if not names <= server_names:
                log.info("client tool call(s) %s -> returned to client", names - server_names)
                for h in held:
                    yield h
                break

            messages.append({"role": "assistant", "content": "", "tool_calls": calls})
            for c in calls:
                messages.append(await execute_tool_call(c))

        yield "data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


# ─── Main endpoint ────────────────────────────────────────────
@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    body = await request.json()
    model = registry.resolve(body.get("model"))
    chain = registry.fallback_chain(model)

    if body.get("stream"):
        return await handle_stream(body, chain)
    try:
        return JSONResponse(await handle_non_stream(body, chain))
    except UpstreamError as e:
        status = e.status if 400 <= e.status < 600 else 502
        return JSONResponse(
            {"error": {"message": str(e), "model": e.model.alias,
                       "tried": [m.alias for m in chain]}},
            status_code=status,
        )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "proxy:app",
        host=config.HOST,
        port=config.PORT,
        reload=config.RELOAD,
        log_level=config.LOG_LEVEL,
    )

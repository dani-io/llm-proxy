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
  - /v1/* needs a project API key (apikeys.py): allowed models, server tools,
    daily / 30-day token limits; fallback stays within the key's models
  - Every request is logged (metadata only, with its key) for the admin panel (admin.py)
"""
import json
import logging
import time
import uuid

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

import apikeys
import config
import health
from providers import Model, get_registry
from stats import store
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

app = FastAPI(title="llm-proxy", version="0.3.0")


class UpstreamError(Exception):
    def __init__(self, model: Model, status: int, detail: str):
        super().__init__(f"{model.alias}: HTTP {status}: {detail[:300]}")
        self.model, self.status, self.detail = model, status, detail


# ─── Per-request record (written to the stats DB at the end) ───
class Rec:
    def __init__(self, requested, stream, client, source="api", key_id=None, allow_tools=True):
        self.t0 = time.monotonic()
        self.d = {"ts": time.time(), "requested": requested, "stream": int(bool(stream)),
                  "status": "ok", "fallback": 0, "prompt_tokens": 0,
                  "completion_tokens": 0, "turns": 0, "tool_calls": 0,
                  "client": client, "source": source, "key_id": key_id}
        self.allow_tools = allow_tools      # the API key may use the server tools
        self.tools: list[str] = []
        self.first_model: str | None = None

    def served_by(self, model: Model) -> None:
        if self.first_model is None:
            self.first_model = model.alias
        if model.alias != self.first_model:
            self.d["fallback"] = 1
        self.d["model"], self.d["provider"] = model.alias, model.provider.name

    def add_usage(self, usage: dict | None) -> None:
        if usage:
            self.d["prompt_tokens"] += int(usage.get("prompt_tokens") or 0)
            self.d["completion_tokens"] += int(usage.get("completion_tokens") or 0)

    def first_token(self) -> None:
        if self.d.get("ttft_ms") is None:
            self.d["ttft_ms"] = int((time.monotonic() - self.t0) * 1000)

    def fail(self, err: str) -> None:
        self.d["status"], self.d["error"] = "error", err[:500]

    def save(self) -> None:
        self.d["latency_ms"] = int((time.monotonic() - self.t0) * 1000)
        self.d["tools"] = ",".join(self.tools) or None
        try:
            store().log_request(self.d)
        except Exception:
            log.exception("could not write request log")


# ─── Info endpoints ───────────────────────────────────────────
@app.on_event("startup")
async def _startup():
    get_registry()
    store()


@app.get("/health")
async def health_endpoint():
    reg = get_registry()
    return {"status": "ok", "tools": list(TOOLS),
            "default_model": reg.default_model, "models": list(reg.models)}


def model_info(m: Model, default: str) -> dict:
    return {
        "id": m.alias, "object": "model", "created": 0,
        "owned_by": m.provider.name, "upstream_model": m.upstream_model,
        "tools": m.tools, "external": m.external, "fallback": m.fallback,
        "default": m.alias == default, "description": m.description,
    }


@app.exception_handler(apikeys.ApiError)
async def _api_error(request: Request, e: apikeys.ApiError):
    return JSONResponse(e.body(), status_code=e.status, headers=e.headers)


@app.get("/v1/models")
async def list_models(request: Request):
    caller = apikeys.authenticate(request)
    reg = get_registry()
    return {"object": "list",
            "data": [model_info(m, reg.default_model) for m in reg.models.values()
                     if caller.allows(m.alias)]}


# ─── Helpers ──────────────────────────────────────────────────
def _tool_name(schema: dict) -> str:
    return schema.get("function", {}).get("name", "")


def merge_tools(model: Model, client_tools: list, allow_server: bool = True) -> tuple[list, set]:
    """Client tools + server tools (client wins on name clash).
    Returns (tools to send, names the proxy executes itself)."""
    if not model.tools or not allow_server:
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
    if stream and model.provider.stream_usage:
        payload["stream_options"] = {**(body.get("stream_options") or {}), "include_usage": True}
    return payload


def clean_assistant_msg(msg: dict) -> dict:
    """Assistant turn to send back upstream — drop provider-specific fields
    (reasoning_content etc.) that other providers may reject."""
    return {"role": "assistant", "content": msg.get("content") or "",
            "tool_calls": msg.get("tool_calls") or []}


async def execute_tool_call(tool_call: dict, rec: Rec) -> dict:
    call_id = tool_call.get("id") or "call_" + uuid.uuid4().hex[:12]
    fn = tool_call.get("function", {})
    name = fn.get("name", "")
    raw_args = fn.get("arguments") or "{}"
    log.info("tool_call: %s(%s)", name, str(raw_args)[:200])
    rec.d["tool_calls"] += 1
    if name not in rec.tools:
        rec.tools.append(name)

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
    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=model.provider.timeout) as client:
            resp = await client.post(url, json=payload, headers=model.provider.request_headers())
    except httpx.HTTPError as e:
        health.error(model.provider.name, model.alias, None, f"{type(e).__name__}: {e}")
        raise UpstreamError(model, 502, f"{type(e).__name__}: {e}") from e
    if resp.status_code >= 400:
        health.error(model.provider.name, model.alias, resp.status_code, resp.text)
        raise UpstreamError(model, resp.status_code, resp.text)
    try:
        data = resp.json()
        data["choices"][0]["message"]
    except (ValueError, KeyError, IndexError, TypeError):
        health.error(model.provider.name, model.alias, resp.status_code, "malformed response")
        raise UpstreamError(model, 502, f"malformed response: {resp.text[:300]}")
    health.ok(model.provider.name, model.alias, int((time.monotonic() - t0) * 1000))
    return data


async def call_chain(chain: list[Model], body: dict, messages: list, client_tools: list,
                     rec: Rec, force_no_tools: bool = False):
    """Try each model in the chain; return (index, response, server_tool_names)."""
    last_err = None
    for i, model in enumerate(chain):
        tools, server_names = ([], set()) if force_no_tools else merge_tools(model, client_tools, rec.allow_tools)
        try:
            data = await post_chat(model, build_payload(model, body, messages, tools, False))
            if i:
                log.warning("served by fallback %s", model.alias)
            rec.served_by(model)
            rec.d["turns"] += 1
            rec.add_usage(data.get("usage"))
            return i, data, server_names
        except UpstreamError as e:
            log.warning("upstream failed: %s", e)
            rec.served_by(model)
            last_err = e
    raise last_err


# ─── Non-streaming ────────────────────────────────────────────
async def handle_non_stream(body: dict, chain: list[Model], rec: Rec):
    messages = list(body.get("messages", []))
    client_tools = body.get("tools") or []

    for loop in range(config.MAX_TOOL_LOOPS):
        log.info("loop %d/%d [%s]", loop + 1, config.MAX_TOOL_LOOPS, chain[0].alias)
        i, resp, server_names = await call_chain(chain, body, messages, client_tools, rec)
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
            rec.d["status"] = "client_tool"
            return resp

        messages.append(clean_assistant_msg(msg))
        for tc in tool_calls:
            messages.append(await execute_tool_call(tc, rec))

    log.warning("MAX_TOOL_LOOPS reached, forcing final answer")
    messages.append({"role": "user", "content": BUDGET_MSG})
    i, resp, _ = await call_chain(chain, body, messages, client_tools, rec, force_no_tools=True)
    resp["model"] = chain[i].alias
    return resp


# ─── Streaming ────────────────────────────────────────────────
def sse(obj) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


async def handle_stream(body: dict, chain: list[Model], rec: Rec):
    """Every turn is streamed from upstream. Content chunks go to the client
    live; tool-call chunks are held back. If all held calls are server tools
    they are executed and the loop continues; otherwise they are flushed to
    the client (client tools)."""
    client_wants_usage = bool((body.get("stream_options") or {}).get("include_usage"))

    async def gen():
        nonlocal chain
        messages = list(body.get("messages", []))
        client_tools = body.get("tools") or []
        try:
            for loop in range(config.MAX_TOOL_LOOPS + 1):
                final_turn = loop == config.MAX_TOOL_LOOPS
                if final_turn:
                    log.warning("MAX_TOOL_LOOPS reached, forcing final answer")
                    messages.append({"role": "user", "content": BUDGET_MSG})

                opened = False
                for i, model in enumerate(chain):
                    tools, server_names = ([], set()) if final_turn else merge_tools(model, client_tools, rec.allow_tools)
                    payload = build_payload(model, body, messages, tools, True)
                    acc: dict[int, dict] = {}   # index -> accumulated tool call
                    held: list[str] = []        # raw tool-call chunks, flushed only for client tools
                    sent_any = False
                    t0 = time.monotonic()
                    rec.served_by(model)
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
                                rec.d["turns"] += 1
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
                                    if chunk.get("usage"):
                                        rec.add_usage(chunk["usage"])
                                        if not choices:     # usage-only chunk
                                            if client_wants_usage:
                                                yield sse(chunk)
                                            continue
                                        if not client_wants_usage:
                                            chunk.pop("usage")
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
                                    if delta.get("content"):
                                        rec.first_token()
                                    sent_any = True
                                    yield sse(chunk)
                        health.ok(model.provider.name, model.alias,
                                  int((time.monotonic() - t0) * 1000))
                        break                   # this turn is done
                    except (UpstreamError, httpx.HTTPError) as e:
                        log.warning("upstream failed (stream): %s", e)
                        health.error(model.provider.name, model.alias,
                                     getattr(e, "status", None), str(e))
                        if sent_any:            # can't switch provider mid-answer
                            rec.fail(f"stream broke: {e}")
                            yield sse({"error": {"message": f"upstream stream broke: {e}"}})
                            yield "data: [DONE]\n\n"
                            return
                        rec.d.setdefault("error", str(e)[:500])
                        opened = False
                        continue

                if not opened:
                    rec.fail(rec.d.get("error") or "all upstream models failed")
                    yield sse({"error": {"message": "all upstream models failed",
                                         "models": [m.alias for m in chain]}})
                    yield "data: [DONE]\n\n"
                    return

                if not acc:
                    break                       # final answer streamed
                calls = [acc[k] for k in sorted(acc)]
                names = {c["function"]["name"] for c in calls}
                if not names <= server_names:
                    log.info("client tool call(s) %s -> returned to client", names - server_names)
                    rec.d["status"] = "client_tool"
                    for h in held:
                        yield h
                    break

                messages.append({"role": "assistant", "content": "", "tool_calls": calls})
                for c in calls:
                    messages.append(await execute_tool_call(c, rec))

            if rec.d["status"] != "error":
                rec.d.pop("error", None)        # errors that a fallback recovered from
            yield "data: [DONE]\n\n"
        finally:
            rec.save()

    return StreamingResponse(gen(), media_type="text/event-stream")


# ─── Main endpoint ────────────────────────────────────────────
@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    caller = apikeys.authenticate(request)
    apikeys.check_limits(caller)
    try:
        body = await request.json()
    except ValueError:
        raise apikeys.ApiError(400, "Request body is not valid JSON.", "invalid_json")
    reg = get_registry()
    model = apikeys.resolve_model(caller, reg, body.get("model"))
    if body.get("model") and body.get("model") not in reg.models:
        log.info("unknown model %r -> %r", body.get("model"), model.alias)
    # fallback only moves to models this key may use
    chain = [m for m in reg.fallback_chain(model) if caller.allows(m.alias)]
    rec = Rec(body.get("model"), body.get("stream"), apikeys.client_ip(request),
              key_id=caller.id, allow_tools=caller.tools)

    if body.get("stream"):
        return await handle_stream(body, chain, rec)
    try:
        return JSONResponse(await handle_non_stream(body, chain, rec))
    except UpstreamError as e:
        rec.fail(str(e))
        status = e.status if 400 <= e.status < 600 else 502
        return JSONResponse(
            {"error": {"message": str(e), "model": e.model.alias,
                       "tried": [m.alias for m in chain]}},
            status_code=status,
        )
    finally:
        rec.save()


if __name__ == "__main__":
    import server
    server.run()

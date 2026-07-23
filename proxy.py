"""
llm-proxy — FastAPI wrapper around llama-server with tool calling.

Design:
  - Accepts OpenAI-compatible /v1/chat/completions requests
  - Forwards to upstream llama-server
  - If model returns tool_calls: execute tools, feed back, loop
  - Loop until model returns final content or MAX_TOOL_LOOPS reached
  - Supports both streaming (?stream=true) and non-streaming
"""
import json
import logging
import time
from typing import Any

import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse

import config
from tools import web_search, fetch_url


logging.basicConfig(
    level=getattr(logging, config.LOG_LEVEL.upper()),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("llm-proxy")


# ─── Tool registry ────────────────────────────────────────────
TOOLS = {
    "web_search": {
        "schema": web_search.TOOL_SCHEMA,
        "execute": web_search.execute,
    },
    "fetch_url": {
        "schema": fetch_url.TOOL_SCHEMA,
        "execute": fetch_url.execute,
    },
}

DEFAULT_TOOLS_SCHEMA = [t["schema"] for t in TOOLS.values()]


# ─── FastAPI app ──────────────────────────────────────────────
app = FastAPI(title="llm-proxy", version="0.1.0")


@app.get("/health")
async def health():
    return {"status": "ok", "tools": list(TOOLS.keys())}


@app.get("/v1/models")
async def list_models():
    """OpenAI-compatible model list, forwarded from llama-server."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(f"{config.LLAMA_URL}/v1/models")
        return JSONResponse(resp.json(), status_code=resp.status_code)


# ─── Tool execution ────────────────────────────────────────────
async def execute_tool_call(tool_call: dict) -> dict:
    """
    Execute a single tool_call from the LLM, return a role='tool' message
    ready to append to the conversation.
    """
    call_id = tool_call.get("id", "unknown")
    fn = tool_call.get("function", {})
    name = fn.get("name", "")
    raw_args = fn.get("arguments", "{}")

    log.info("tool_call: %s(%s)", name, raw_args[:200])

    if name not in TOOLS:
        content = f"Error: unknown tool '{name}'. Available: {list(TOOLS.keys())}"
    else:
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

    return {
        "role": "tool",
        "tool_call_id": call_id,
        "content": content,
    }


# ─── LLM upstream call ─────────────────────────────────────────
async def call_llama(messages: list, tools: list, **kwargs) -> dict:
    """Non-streaming call to llama-server."""
    payload = {
        "model": kwargs.get("model", config.LLAMA_MODEL),
        "messages": messages,
        "tools": tools,
        **{k: v for k, v in kwargs.items() if k not in ("model", "stream")},
        "stream": False,
    }
    async with httpx.AsyncClient(timeout=config.LLAMA_TIMEOUT) as client:
        resp = await client.post(
            f"{config.LLAMA_URL}/v1/chat/completions",
            json=payload,
        )
        resp.raise_for_status()
        return resp.json()


# ─── Non-streaming endpoint ────────────────────────────────────
async def handle_non_stream(body: dict) -> dict:
    """Loop through tool calls until final content, return single response."""
    messages = list(body.get("messages", []))
    tools = body.get("tools") or DEFAULT_TOOLS_SCHEMA
    passthrough = {
        k: v for k, v in body.items()
        if k not in ("messages", "tools", "stream")
    }

    for loop in range(config.MAX_TOOL_LOOPS):
        log.info("loop %d/%d", loop + 1, config.MAX_TOOL_LOOPS)
        resp = await call_llama(messages, tools, **passthrough)

        choice = resp["choices"][0]
        msg = choice["message"]
        tool_calls = msg.get("tool_calls") or []

        if not tool_calls:
            log.info("done after %d loops, finish_reason=%s",
                     loop + 1, choice.get("finish_reason"))
            return resp

        # Append assistant message with tool_calls
        messages.append(msg)

        # Execute all tool calls in this turn
        for tc in tool_calls:
            tool_msg = await execute_tool_call(tc)
            messages.append(tool_msg)

    # Loop budget exhausted — return whatever we have, with a warning
    log.warning("MAX_TOOL_LOOPS reached, forcing final answer")
    final_body = {
        **passthrough,
        "messages": messages + [{
            "role": "user",
            "content": "You have used all tool call budget. Provide your final answer now based on the information gathered so far.",
        }],
        "tools": [],  # no more tools
        "stream": False,
        "model": passthrough.get("model", config.LLAMA_MODEL),
    }
    async with httpx.AsyncClient(timeout=config.LLAMA_TIMEOUT) as client:
        resp = await client.post(
            f"{config.LLAMA_URL}/v1/chat/completions",
            json=final_body,
        )
        resp.raise_for_status()
        return resp.json()


# ─── Streaming endpoint (SSE) ──────────────────────────────────
async def handle_stream(body: dict):
    """
    Run tool loop non-streamed internally, stream only the FINAL response.

    Compromise: full streaming through tool loops is complex (need to buffer
    tool_calls SSE events, execute, then continue stream). For prototype,
    we run tool loops silently, then stream the last llama response.
    """
    messages = list(body.get("messages", []))
    tools = body.get("tools") or DEFAULT_TOOLS_SCHEMA
    passthrough = {
        k: v for k, v in body.items()
        if k not in ("messages", "tools", "stream")
    }

    # Tool loop (silent, non-streamed)
    for loop in range(config.MAX_TOOL_LOOPS):
        resp = await call_llama(messages, tools, **passthrough)
        choice = resp["choices"][0]
        msg = choice["message"]
        tool_calls = msg.get("tool_calls") or []

        if not tool_calls:
            break

        messages.append(msg)
        for tc in tool_calls:
            tool_msg = await execute_tool_call(tc)
            messages.append(tool_msg)
    else:
        messages.append({
            "role": "user",
            "content": "You have used all tool call budget. Provide your final answer now.",
        })
        tools = []

    # Final call — real streaming to client
    final_payload = {
        **passthrough,
        "model": passthrough.get("model", config.LLAMA_MODEL),
        "messages": messages,
        "tools": tools,
        "stream": True,
    }

    async def event_generator():
        async with httpx.AsyncClient(timeout=config.LLAMA_TIMEOUT) as client:
            async with client.stream(
                "POST",
                f"{config.LLAMA_URL}/v1/chat/completions",
                json=final_payload,
            ) as resp:
                async for line in resp.aiter_lines():
                    if line:
                        yield f"{line}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
    )


# ─── Main endpoint ─────────────────────────────────────────────
@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    body = await request.json()

    if body.get("stream"):
        return await handle_stream(body)
    else:
        return JSONResponse(await handle_non_stream(body))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "proxy:app",
        host=config.HOST,
        port=config.PORT,
        reload=True,
        log_level=config.LOG_LEVEL,
    )

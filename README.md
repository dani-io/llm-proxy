# llm-proxy

OpenAI-compatible gateway in front of llama-server and any external
OpenAI-compatible API, with server-side tool calling.

## Features

- **Multi-provider routing** — the request's `model` picks a provider from
  `providers.yaml` (local llama-server, OpenRouter, any OpenAI-compatible API).
  Unknown or missing model → `default_model`.
- **Server tools for every model** — `web_search` (SearXNG) and `fetch_url`
  (trafilatura) are offered to and executed for any model with `tools: true`,
  local or external.
- **Client tools pass through** — tools sent by the client (e.g. OpenCode) are
  merged with the server tools; when the model calls a client tool, the
  response goes back to the client untouched.
- **Fallback** — on any upstream error (network, 429, 5xx, bad key…) the
  request switches to the model's `fallback` and stays there.
- **True streaming** — every turn is streamed live; tool-call turns are run
  silently, and no answer is generated twice.

## Setup

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
cp providers.example.yaml providers.yaml   # optional — without it only LLAMA_URL is used
python proxy.py
```

API keys go in `.env` (e.g. `OPENROUTER_API_KEY=...`) and are referenced from
`providers.yaml` via `api_key_env`. A provider with an empty key is skipped.
Restart after editing either file.

## Endpoints

- `GET /health` — status, tools, models, default model
- `GET /v1/models` — model aliases with provider, tool support, fallback, external flag
- `POST /v1/chat/completions` — OpenAI-compatible, streaming and non-streaming

## Privacy

Models whose provider is not on the LAN are marked `external: true` in
`/v1/models`. Their prompts — and any web pages fetched by tools during the
conversation — are sent to that provider. Keep private data on local models.

## Deploy

Production runs as systemd service `llm-proxy` in CT 261 (hawk), from `/opt/llm-proxy`.

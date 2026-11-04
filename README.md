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

## Admin panel

Served by the same process on `ADMIN_PORT` (default **8002**), separate from
the model API:

- **Dashboard** — today's requests, errors, tokens, latency; model and provider health
- **Models** — health, usage, and a one-click test call per model
- **Providers** — health, key hint, and *Check now* (`GET /models`, no quota) with
  a searchable list of upstream model ids
- **Usage** — requests per model and tokens over 24h / 7d / 30d / 90d
- **Requests** — the request log (metadata only — prompts are never stored)

The first visit creates the single admin account. Data lives in
`data/stats.db` (SQLite, 90-day retention). Health comes from real traffic
plus a probe every 5 minutes.

The UI source is in `admin-ui/` (React + Vite + Tailwind, same style as
sms-panel). The built `admin-ui/dist` is committed, so the server needs no
Node. After UI changes: `cd admin-ui && npm install && npm run build`.

## Setup

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
cp providers.example.yaml providers.yaml   # optional — without it only LLAMA_URL is used
python server.py      # model API on PORT, admin panel on ADMIN_PORT
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

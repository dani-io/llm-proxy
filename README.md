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
- **API keys per project** — the model API only accepts keys issued in the
  admin panel (`Authorization: Bearer llp_…`, the `api_key` of any OpenAI SDK).
  Each key has its allowed models, server tools on/off, daily and 30-day token
  limits, an expiry and an on/off switch; usage is counted per key.

## Admin panel

Served by the same process on `ADMIN_PORT` (default **8002**), separate from
the model API:

- **Dashboard** — today's requests, errors, tokens, latency; model and provider health
- **API Keys** — one key per project: allowed models, token limits (Tehran day /
  last 30 days), expiry, rotate; usage per project and per model
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

- `GET /health` — `{"status": "ok"}` only, no key needed (Uptime Kuma). It is
  public, so it lists no models or tools — those are in the admin panel
- `GET /v1/models` — the models this key may use, with provider, tool support,
  fallback and external flag
- `POST /v1/chat/completions` — OpenAI-compatible, streaming and non-streaming

`/v1/*` needs `Authorization: Bearer <key>`. Errors use the OpenAI shape
(`{"error": {"message", "type", "code"}}`):

| HTTP | code | when |
|------|------|------|
| 401 | `missing_api_key` / `invalid_api_key` | no key, or unknown key |
| 403 | `api_key_disabled` / `api_key_expired` | key switched off or past its expiry |
| 403 | `model_not_allowed` | the key may not use the requested model |
| 429 | `daily_limit_reached` / `monthly_limit_reached` | token limit used up (`Retry-After` until 00:00 Tehran) |

A missing or unknown `model` goes to the default model, or to the key's first
allowed model when the default isn't one of them. Fallback only moves to models
the key may use. Limits are checked before a request starts, so a single
request can go slightly over.

Using it from a project on Coolify: store the key as a secret env var and point
the OpenAI client at the proxy.

```python
import os
from openai import OpenAI

client = OpenAI(base_url="http://llm.bp/v1", api_key=os.environ["LLM_API_KEY"])
```

## Using it

### 1. Issue a key

Admin panel → **API Keys** → **New key**: one key per project (name it after
the project), pick its models, set limits if needed. The key is shown once —
store it in Bitwarden. Lost it? **Rotate** issues a new one; the old one stops
working at once.

### 2. Point the client at the proxy

Any OpenAI-compatible client works: base URL `http://llm.bp/v1`, the key as
`api_key`, and one of the key's model names as `model`.

```bash
curl http://llm.bp/v1/chat/completions \
  -H "Authorization: Bearer $LLM_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"gemma-local","messages":[{"role":"user","content":"سلام"}]}'
```

```js
import OpenAI from 'openai'
const client = new OpenAI({ baseURL: 'http://llm.bp/v1', apiKey: process.env.LLM_API_KEY })
```

**Apps on Coolify:** add `LLM_API_KEY` as a secret env var on the app, and use
`http://llm.bp/v1` (resolved by the MikroTik like any LAN client).

### OpenCode

The provider in `~/.config/opencode/opencode.json` (here its id is `homelab`):

```json
"provider": {
  "homelab": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "llm-proxy (homelab)",
    "options": { "baseURL": "http://llm.bp/v1" },
    "models": { "gemma-local": { "name": "Gemma 4 E4B (local, private)" } }
  }
}
```

Store the key outside the config: `opencode auth login` → **Other** → provider
id **exactly the same as in the config** (`homelab`) → paste the key. Don't
leave an `apiKey` in `options` — it overrides the stored key.

OpenCode does not read `/v1/models`; it only lists the models in the config.
After adding or removing models (or changing the key's models) run:

```bash
scripts/opencode-sync-models.sh            # provider id, base URL: homelab, http://llm.bp/v1
```

It adds new models, drops ones the key can no longer use, keeps your names and
options, and writes a timestamped backup. Needs `jq`. Restart OpenCode after.

### Adding a provider

Admin panel → **Providers** → add, with a base URL ending in the API's version
path, then **Check now** to load its model list. Examples:

| Provider | Base URL |
|----------|----------|
| local llama-server | `http://192.168.10.245:8080/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` |

Then add models under **Models** and give them to the keys that should use
them (keys set to *All models* get them automatically).

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `401 missing_api_key` | The client sends no key. OpenCode: the provider id in `opencode auth login` must match the config's id. |
| `401 invalid_api_key` | Wrong or rotated key — or an `apiKey: "none"` left in OpenCode's `options`, which wins over the stored key. |
| `403 api_key_disabled` / `api_key_expired` | Enable the key, or extend/clear its expiry in **API Keys**. |
| `403 model_not_allowed` | The key may not use that model: edit the key's models, or pick another model. |
| `429 daily_limit_reached` / `monthly_limit_reached` | Limit used up. Raise or clear it in **API Keys**, or wait (`Retry-After`). |
| A model is missing in OpenCode | OpenCode only lists the config's models — run `scripts/opencode-sync-models.sh`. Check the model is active (Models page) and allowed for the key. |
| A model shows *Failing* | Open **Providers** for the upstream error. `scheduled maintenance`, 429 or 5xx are the provider's side; add a `fallback` to the model so requests move on. |
| Gemini: `403` / `User location is not supported` | Google blocks Iranian IPs; the request must leave through the SFO2 tunnel. |
| Provider *no API key* | Set the key on the Providers page (stored in `data/provider-keys.env`). |
| Answers arrive all at once instead of streaming | Client sent `stream: false`, or something between client and Coolify buffers. `curl -N` with `"stream": true` shows whether chunks come live. |
| `llm.bp` doesn't resolve | MikroTik static DNS: `llm.bp` and `llm-admin.bp` → `192.168.10.4`. |
| `/health` OK but every `/v1` call fails | Expected without a key — `/health` is open on purpose (Uptime Kuma). |
| Forgot the admin password | No reset in the panel. Stop the app, delete the `admin` row from `data/stats.db` (`sqlite3 stats.db "DELETE FROM admin; DELETE FROM sessions;"`), start it, and set up again — keys and stats stay. |

Logs: Coolify → Lab → llm-proxy → **Logs** (one line per request, plus tool
calls and upstream errors). Prompts are never logged. Roll back with
Coolify's **Rollback** to an earlier image; data in `/app/data` is kept.

## Privacy

Models whose provider is not on the LAN are marked `external: true` in
`/v1/models`. Their prompts — and any web pages fetched by tools during the
conversation — are sent to that provider. Keep private data on local models.

## Deploy

Production runs on **Coolify** (eagle CT 100, project *Lab*, app `llm-proxy`),
built from the `Dockerfile` on every push to `main`.

- Model API: `http://llm.bp/v1` (container port 8000)
- Admin panel: `http://llm-admin.bp` (container port 8002)
- Persistent volume on `/app/data`: `stats.db`, `providers.yaml`,
  `provider-keys.env`, `backups/` — edit providers/keys from the admin panel
- Env vars (Coolify): `LLAMA_URL`, `LLAMA_MODEL`, `SEARXNG_URL`, `PANEL_TZ`,
  `LOG_LEVEL`, plus any `*_API_KEY` named in `providers.yaml` (as secrets)
- One replica only: the provider registry and health state live in memory
- `.bp` domains only — never put it under `*.blackport.ir` (public CF tunnel)

Run the image locally:

```bash
docker build -t llm-proxy .
docker run -p 8000:8000 -p 8002:8002 -v llm-proxy-data:/app/data llm-proxy
```

Until Nov 2026 it ran as systemd service `llm-proxy` in CT 261 on hawk
(`/opt/llm-proxy`); that CT is stopped and kept for rollback.

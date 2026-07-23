# llm-proxy

FastAPI reverse proxy for llama-server with tool calling support.

## Tools

- **web_search** — SearXNG JSON API
- **fetch_url** — trafilatura HTML extraction

## Setup

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python proxy.py
```

## Endpoints

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions` — OpenAI-compatible

## Deploy

Production runs as systemd service in CT 261 (hawk).
See homelab-docs/hawk-ai-stack/.

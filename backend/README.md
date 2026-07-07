# WhatsApp Agent Backend

FastAPI server that hosts an OpenAI Agents SDK agent with tools executed
remotely via a Chrome extension connected over WebSocket.

## Prerequisites

- **Python 3.11+**
- **[uv](https://docs.astral.sh/uv/)** — fast Python package manager

Install uv if you haven't:
```bash
# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

## Setup

1. **Copy `.env.example` to `.env`** and add your Gemini API key:
   ```bash
   cp .env.example .env
   ```

2. **Install dependencies:**
   ```bash
   uv sync
   ```

3. **Run the server (development — auto-reload):**
   ```bash
   uv run fastapi dev main.py --host 127.0.0.1 --port 8787
   ```

   Or for **production** (no auto-reload, binds to 0.0.0.0):
   ```bash
   uv run fastapi run main.py --host 127.0.0.1 --port 8787
   ```

The Chrome extension connects automatically to `ws://127.0.0.1:8787/ws`
when you switch to Agent mode.

## Quick Reference

| Command | Purpose |
|---------|---------|
| `uv sync` | Install/update all dependencies into `.venv` |
| `uv add <package>` | Add a new dependency |
| `uv run fastapi dev main.py --port 8787` | Development server (auto-reload) |
| `uv run fastapi run main.py --port 8787` | Production server |

## Architecture

```
Extension ←──WebSocket──→ FastAPI ←──LiteLLM──→ Gemini
               /ws          │
                          Agent (Agents SDK)
                            │
                          Tools ──→ bridge.call_extension()
                                       │
                                    Sends tool_call over WS
                                    Awaits tool_result
```

## Data

Runtime data is stored in `data/` (git-ignored):
- `data/sessions.db` — Agent conversation memory (SQLite)
- `data/transcripts.json` — Cached voice-note transcriptions
- `data/media/` — Downloaded voice-note audio files

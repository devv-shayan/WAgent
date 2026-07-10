# WhatsApp Agent Backend

FastAPI server that hosts an OpenAI Agents SDK agent with tools executed
remotely via a Chrome extension connected over WebSocket.

## Quick start (Windows)

One command does everything — installs `uv` if missing, installs
dependencies, creates `.env`, installs Ollama + pulls the local Gemma 4
model (`gemma4:e2b`, ~7.2 GB) as the default agent model, and sets the
backend to auto-start hidden at login:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

Skip the local model and use cloud Gemini only: `install.ps1 -SkipLocal`.
Undo auto-start anytime: `powershell -ExecutionPolicy Bypass -File uninstall-autostart.ps1`.
Logs: `../data/backend.log`.

No API key is required to get started — the installer defaults to a fully
local model. You only need `GEMINI_API_KEY` for media transcription (voice
notes/video/images, which is cloud-only today) or if you prefer cloud
Gemini for text. A key can also be typed directly into the extension's
**Agent settings** panel (gear icon, Agent mode) instead of `.env` — web
settings there override `.env` per message; leave them blank to use `.env`.

## Prerequisites (manual setup / Mac / Linux)

- **Python 3.11+**
- **[uv](https://docs.astral.sh/uv/)** — fast Python package manager

Install uv if you haven't:
```bash
# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

## Manual setup

1. **Copy `.env.example` to `.env`.** `GEMINI_API_KEY` / `AGENT_MODEL` are
   both optional — see the note above.
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
when you switch to Agent mode. The port must be **8787** — the extension
has that hardcoded.

**Running a local model manually:** install [Ollama](https://ollama.com),
`ollama pull gemma4:e2b`, then set `AGENT_MODEL=ollama_chat/gemma4:e2b` in
`.env` (note the `ollama_chat/` prefix, not `ollama/` — that's Ollama's
native tool-calling API; the older `ollama/` path emulates tool calls via
JSON prompting and breaks the agent's tool use on smaller models). Verify
with `uv run python verify_local.py`.

## Quick Reference

| Command | Purpose |
|---------|---------|
| `install.ps1` | One-command setup: uv, deps, Ollama + Gemma 4, auto-start (Windows) |
| `install.ps1 -SkipLocal` | Same, but skip the local model (cloud Gemini only) |
| `install-autostart.ps1` | Set the backend to auto-start hidden at login |
| `uninstall-autostart.ps1` | Remove auto-start and stop the running backend |
| `uv sync` | Install/update all dependencies into `.venv` |
| `uv add <package>` | Add a new dependency |
| `uv run fastapi dev main.py --port 8787` | Development server (auto-reload) |
| `uv run fastapi run main.py --port 8787` | Production server |
| `uv run python verify_local.py` | Confirm the configured model actually runs locally |

## Architecture

```
Extension ←──WebSocket──→ FastAPI ←──LiteLLM──→ Gemini (cloud) or Ollama (local)
               /ws          │
                          Agent (Agents SDK)
                            │
                          Tools ──→ bridge.call_extension()
                                       │
                                    Sends tool_call over WS
                                    Awaits tool_result
```

Media transcription (voice notes, video, images) is a separate path —
always Gemini cloud today, regardless of the text model (see
`transcribe.py`), and always needs `GEMINI_API_KEY`.

## Data

Runtime data is stored in `data/` (git-ignored):
- `data/sessions.db` — Agent conversation memory (SQLite)
- `data/transcripts.json` — Cached voice-note transcriptions
- `data/media/` — Downloaded voice-note audio files

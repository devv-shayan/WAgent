"""
FastAPI application with a single /ws WebSocket endpoint.

The WebSocket is shared between:
  • The user's chat messages  (user_message → agent run → assistant_message)
  • The tool-call RPC channel  (tool_call ↔ tool_result, managed by bridge)

Concurrency model:
  A persistent *receive loop* reads every incoming frame and routes it:
    - user_message  → spawns an agent-run task
    - tool_result   → forwarded to bridge.handle_tool_result()
  The agent-run task streams deltas and status messages back through the
  bridge, and sends the final assistant_message when done.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import time
import uuid
from pathlib import Path

import httpx

import litellm
from agents import Runner, SQLiteSession
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from openai.types.responses import ResponseTextDeltaEvent
from pydantic import BaseModel

from agent import create_agent
from bridge import bridge
from transcribe import is_ollama_model, set_media_model_override

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Data directory & Memory files
# ---------------------------------------------------------------------------

DATA_DIR = Path(__file__).parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)

MEMORY_FILE = DATA_DIR / "memory.md"


def _load_memory() -> str:
    """Load current memory markdown from disk."""
    if MEMORY_FILE.exists():
        try:
            return MEMORY_FILE.read_text(encoding="utf-8")
        except OSError:
            logger.warning("Failed to read memory.md, starting fresh")
    return ""


def _save_memory(memory_text: str) -> None:
    """Save memory markdown to disk."""
    DATA_DIR.mkdir(exist_ok=True)
    try:
        MEMORY_FILE.write_text(memory_text, encoding="utf-8")
    except OSError:
        logger.exception("Failed to write memory.md")


_TOOL_FRIENDLY_NAMES = {
    "list_chats": "Listing chats",
    "get_messages": "Fetching messages",
    "search_messages": "Searching messages",
    "get_active_chat": "Checking active chat",
    "transcribe_media": "Processing media",
    "visit_url": "Reading webpage",
    "export_chat": "Exporting chat",
}


def _format_session_items(items: list) -> list[str]:
    """Turn raw SQLiteSession items into readable 'ROLE: text' lines.

    Shared by context compaction (agent-facing summary) and the
    /memory/session viewer endpoint (human-facing display) so there's one
    place that knows how to read the Agents SDK's item shape.
    """
    lines: list[str] = []
    for item in items:
        get_val = lambda k: item.get(k) if isinstance(item, dict) else getattr(item, k, None)  # noqa: E731

        role = get_val("role") or get_val("type") or "unknown"
        text = ""

        item_text = get_val("text")
        item_content = get_val("content")
        item_parts = get_val("parts")

        if item_text:
            text = str(item_text)
        elif item_content:
            text = str(item_content)
        elif item_parts:
            if isinstance(item_parts, list):
                part_texts = []
                for p in item_parts:
                    p_text = p.get("text") if isinstance(p, dict) else getattr(p, "text", None)
                    part_texts.append(str(p_text) if p_text else str(p))
                text = " ".join(part_texts)
            else:
                text = str(item_parts)

        item_type = get_val("type")
        if item_type in ("tool_call_item", "tool_call"):
            tool_name = get_val("name") or "tool"
            text = f"[Action: {_TOOL_FRIENDLY_NAMES.get(tool_name, 'Working')}]"
        elif item_type in ("tool_response_item", "tool_response"):
            text = "[Action Result]"

        if text:
            lines.append(f"{str(role).upper()}: {text}")
    return lines


async def _compact_context_if_needed(session: SQLiteSession) -> None:
    """
    Check if the conversation history exceeds 50 messages.
    If yes, summarize the older history into memory.md, prune them
    from the SQLite session, and keep only the last 10 messages raw.
    """
    try:
        items = await session.get_items()
        if len(items) <= 50:
            return

        logger.info("Session history length is %d. Running context compaction...", len(items))
        await bridge.send_status("Compacting chat memory…")

        # Keep at least the last 10 items, but align to a 'user' message
        # to avoid separating tool calls from their matching tool responses
        split_idx = len(items) - 10
        while split_idx > 0:
            item = items[split_idx]
            get_val = lambda k: item.get(k) if isinstance(item, dict) else getattr(item, k, None)
            if get_val("role") == "user":
                break
            split_idx -= 1
            
        if split_idx <= 0:
            split_idx = len(items) - 10
            
        to_summarize = items[:split_idx]
        to_keep = items[split_idx:]

        # Format messages to summarize
        history_text = "\n".join(_format_session_items(to_summarize))

        # Load existing memory
        existing_memory = _load_memory()
        if not existing_memory:
            existing_memory = (
                "# Agent Memory\n\n"
                "Last Updated: Never\n\n"
                "## Summary\nNo conversations summarized yet.\n\n"
                "## Discovered Facts\n- None"
            )

        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            logger.warning("GEMINI_API_KEY not set, skipping compaction")
            return

        from google import genai
        client = genai.Client(api_key=api_key)

        prompt = f"""\
You are a memory compaction system for an AI WhatsApp Agent.
Your job is to read the current memory file (which is in Markdown) and a log of recent messages that are about to be deleted, and output a freshly updated, consolidated Markdown document.

Current memory file:
```markdown
{existing_memory}
```

New messages to merge:
```text
{history_text}
```

INSTRUCTIONS:
1. Update the 'Last Updated' timestamp to the current date/time.
2. Under '## Summary', update the high-level narrative summary of the relationship and discussions. Keep it under 3 paragraphs.
3. Under '## Discovered Facts', update the bulleted list of facts (e.g. user preferences, setup paths, contacts, group chats, key dates, decisions).
4. Strictly enforce length: Keep the facts list to a maximum of 20 high-value bullet points. If there are too many, merge similar facts or discard older, low-priority historic facts.
5. Output ONLY the updated Markdown document. Do not include any explanation or backticks. Start your response directly with '# Agent Memory'.
"""

        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
        )

        updated_memory = (response.text or "").strip()
        if updated_memory.startswith("```markdown"):
            updated_memory = updated_memory[11:]
        if updated_memory.endswith("```"):
            updated_memory = updated_memory[:-3]
        updated_memory = updated_memory.strip()

        if updated_memory.startswith("# Agent Memory"):
            _save_memory(updated_memory)
            # Prune SQLite session history
            await session.clear_session()
            await session.add_items(to_keep)
            logger.info("Context compaction complete. Pruned %d items.", len(to_summarize))
        else:
            logger.warning("Gemini returned invalid memory format, aborting compaction. Output: %r", updated_memory[:200])

    except Exception as e:
        logger.exception("Failed to compact context: %s", e)

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="WhatsApp Agent Backend")

from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://web.whatsapp.com"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Telemetry
# ---------------------------------------------------------------------------
TELEMETRY_URL = "https://wagent-telemetry.devvshayan.workers.dev/ping"

async def _send_telemetry():
    try:
        install_id_file = DATA_DIR / "installation_id.txt"
        if install_id_file.exists():
            install_id = install_id_file.read_text().strip()
        else:
            install_id = str(uuid.uuid4())
            install_id_file.write_text(install_id)
            
        payload = {
            "installation_id": install_id,
            "os": platform.system().lower(),
            "version": "0.1.0"
        }
        
        async with httpx.AsyncClient(timeout=3.0) as client:
            await client.post(TELEMETRY_URL, json=payload)
    except Exception as e:
        logger.debug(f"Telemetry ping failed: {e}")

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(_send_telemetry())

# Session persistence (single-user, fixed ID)
SESSION_DB = str(DATA_DIR / "sessions.db")
SESSION_ID = "wa-agent"

# ---------------------------------------------------------------------------
# WebSocket origin allow-list (CSWSH protection)
# ---------------------------------------------------------------------------
# The backend binds to localhost, but ANY web page in ANY browser tab can open
# a WebSocket to ws://127.0.0.1:8787 — so localhost binding alone does NOT stop
# a malicious site from driving the agent (cross-site WebSocket hijacking).
# Browsers set the Origin header honestly and a page cannot forge it, so we
# only accept the handshake when Origin is our extension's page origin.
_DEFAULT_ALLOWED_ORIGINS = {"https://web.whatsapp.com"}
# Extra origins may be added via env (comma-separated) for development.
ALLOWED_ORIGINS = _DEFAULT_ALLOWED_ORIGINS | {
    o.strip()
    for o in os.getenv("ALLOWED_WS_ORIGINS", "").split(",")
    if o.strip()
}


def _origin_allowed(origin: str | None) -> bool:
    # Chrome extension content scripts on web.whatsapp.com send that page's
    # origin. chrome-extension:// origins (if any future caller uses them) are
    # also trusted since only this user's installed extensions can send them.
    if origin in ALLOWED_ORIGINS:
        return True
    if origin and origin.startswith("chrome-extension://"):
        return True
    return False


# ---------------------------------------------------------------------------
# Model discovery — live model lists instead of a hardcoded dropdown
# ---------------------------------------------------------------------------
# The extension's Agent settings panel calls this so the model dropdown
# reflects what's actually available on the user's own key (or actually
# pulled locally for Ollama), instead of a list we'd have to hand-maintain
# and that goes stale (this happened once already with the Gemini list).

_DISCOVERY_TIMEOUT = 15  # seconds — bounds a real network call to the provider
_SUPPORTED_DISCOVERY_PROVIDERS = {"gemini", "ollama_chat"}


class _ModelDiscoveryRequest(BaseModel):
    provider: str
    apiKey: str | None = None


@app.post("/models")
async def list_models(payload: _ModelDiscoveryRequest, request: Request) -> dict:
    # Same origin allow-list as the WebSocket endpoint (main.py's CSWSH
    # comment above applies equally here: this binds to localhost, but any
    # page in any tab can still send a same-origin-unrestricted fetch unless
    # we check Origin ourselves).
    origin = request.headers.get("origin")
    if not _origin_allowed(origin):
        raise HTTPException(status_code=403, detail="Origin not allowed")

    provider = payload.provider.strip()
    api_key = payload.apiKey or None

    if provider not in _SUPPORTED_DISCOVERY_PROVIDERS:
        return {"models": [], "error": f"Unsupported provider: {provider}"}

    try:
        models = await asyncio.wait_for(
            asyncio.to_thread(
                litellm.get_valid_models,
                check_provider_endpoint=True,
                custom_llm_provider=provider,
                api_key=api_key,
            ),
            timeout=_DISCOVERY_TIMEOUT,
        )
    except asyncio.TimeoutError:
        return {"models": [], "error": "Timed out contacting the provider."}
    except Exception:
        # Never leak the api_key or a stack trace back to the client.
        logger.warning("Model discovery failed for provider=%s", provider, exc_info=True)
        return {"models": [], "error": "Could not fetch models. Check your API key."}

    # LiteLLM's discovery mislabels ollama_chat results with the legacy
    # "ollama/" prefix instead of "ollama_chat/". That exact prefix mismatch
    # is what broke local tool-calling earlier (see agent.py / .env.example
    # history) — correct it here so every value this endpoint returns is
    # actually usable by the backend, not just displayable.
    if provider == "ollama_chat":
        models = [
            "ollama_chat/" + m.split("/", 1)[1] if m.startswith("ollama/") else m
            for m in models
        ]

    return {"models": sorted(set(models)), "error": None}


@app.get("/model-status")
async def get_model_status(request: Request, model: str | None = None) -> dict:
    # CSWSH protection: check Origin header
    origin = request.headers.get("origin")
    if not _origin_allowed(origin):
        raise HTTPException(status_code=403, detail="Origin not allowed")

    resolved_model = model or os.getenv("AGENT_MODEL", "gemini/gemini-2.5-flash")
    provider = resolved_model.split("/", 1)[0] if "/" in resolved_model else resolved_model
    is_local = provider.lower() in {"ollama", "ollama_chat"}

    if not is_local:
        return {"status": "n/a", "is_local": False}

    model_name = resolved_model.split("/", 1)[1] if "/" in resolved_model else resolved_model

    ollama_base = os.getenv("OLLAMA_API_BASE", "http://localhost:11434").rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(f"{ollama_base}/api/ps")
            if resp.status_code == 200:
                data = resp.json()
                loaded_models = data.get("models", [])

                is_loaded = False
                for m in loaded_models:
                    loaded_name = m.get("name", "")
                    loaded_model = m.get("model", "")
                    if model_name == loaded_name or model_name == loaded_model:
                        is_loaded = True
                        break
                    # Try matching without version tag if necessary
                    if ":" in loaded_name and loaded_name.split(":")[0] == model_name.split(":")[0]:
                        is_loaded = True
                        break

                return {
                    "status": "loaded" if is_loaded else "stopped",
                    "is_local": True,
                    "model_name": model_name
                }
            else:
                return {
                    "status": "offline",
                    "is_local": True,
                    "error": f"Ollama returned status {resp.status_code}"
                }
    except Exception as e:
        return {
            "status": "offline",
            "is_local": True,
            "error": str(e)
        }


# ---------------------------------------------------------------------------
# Memory viewer/clear — short-term (SQLiteSession) and long-term (memory.md)
# ---------------------------------------------------------------------------
# Lets the web UI show the user what the agent actually remembers, and wipe
# either store. Same origin allow-list as every other endpoint here: this
# reads/deletes conversation history, so it needs the same CSWSH protection
# as the WebSocket itself.


@app.get("/memory/session")
async def get_session_memory(request: Request) -> dict:
    origin = request.headers.get("origin")
    if not _origin_allowed(origin):
        raise HTTPException(status_code=403, detail="Origin not allowed")

    session = SQLiteSession(SESSION_ID, SESSION_DB)
    items = await session.get_items()
    return {"lines": _format_session_items(items), "raw_count": len(items)}


@app.post("/memory/session/clear")
async def clear_session_memory(request: Request) -> dict:
    origin = request.headers.get("origin")
    if not _origin_allowed(origin):
        raise HTTPException(status_code=403, detail="Origin not allowed")

    session = SQLiteSession(SESSION_ID, SESSION_DB)
    await session.clear_session()
    logger.info("Session memory cleared via web UI")
    return {"cleared": True}


@app.get("/memory/long-term")
async def get_long_term_memory(request: Request) -> dict:
    origin = request.headers.get("origin")
    if not _origin_allowed(origin):
        raise HTTPException(status_code=403, detail="Origin not allowed")

    return {"content": _load_memory()}


@app.post("/memory/long-term/clear")
async def clear_long_term_memory(request: Request) -> dict:
    origin = request.headers.get("origin")
    if not _origin_allowed(origin):
        raise HTTPException(status_code=403, detail="Origin not allowed")

    _save_memory("")
    logger.info("Long-term memory (memory.md) cleared via web UI")
    return {"cleared": True}


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    # Reject cross-origin handshakes BEFORE accepting (CSWSH protection).
    origin = ws.headers.get("origin")
    if not _origin_allowed(origin):
        logger.warning("Rejected WebSocket from disallowed origin: %r", origin)
        # 1008 = policy violation. Close during handshake without accepting.
        await ws.close(code=1008)
        return

    await ws.accept()
    await bridge.register(ws)
    logger.info("WebSocket accepted (origin=%s)", origin)

    # Track the currently-running agent task so we don't overlap runs
    agent_task: asyncio.Task | None = None

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                logger.warning("Non-JSON frame ignored: %s", raw[:120])
                continue

            msg_type = msg.get("type")

            # ----- tool_result from extension -----
            if msg_type == "tool_result":
                await bridge.handle_tool_result(msg)

            # ----- user_message → run agent -----
            elif msg_type == "user_message":
                user_text = msg.get("text", "").strip()
                if not user_text:
                    continue

                # If a previous run is still in progress, let user know
                if agent_task is not None and not agent_task.done():
                    await bridge.send_assistant_message(
                        "I'm still working on the previous request. "
                        "Please wait a moment…"
                    )
                    continue

                # Web-first model/key overrides from the extension settings
                # panel; empty strings collapse to None so the agent falls
                # back to the .env defaults.
                model_override = msg.get("model") or None
                key_override = msg.get("apiKey") or None

                agent_task = asyncio.create_task(
                    _run_agent(user_text, model_override, key_override),
                    name="agent-run",
                )

            else:
                logger.debug("Unknown message type: %s", msg_type)

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected")
    except Exception:
        logger.exception("WebSocket error")
    finally:
        # Clean up
        if agent_task is not None and not agent_task.done():
            agent_task.cancel()
            try:
                await agent_task
            except (asyncio.CancelledError, Exception):
                pass
        await bridge.unregister()


# ---------------------------------------------------------------------------
# Agent execution (runs as a background task)
# ---------------------------------------------------------------------------


async def _run_agent(
    user_text: str,
    model_override: str | None = None,
    key_override: str | None = None,
) -> None:
    """
    Execute one turn of the agent, streaming deltas and status updates
    back to the extension via the bridge.
    """
    logger.info("Agent run started: %r", user_text[:120])

    # If the web UI picked a local text model, image transcription follows
    # it too — same "web UI wins over .env" precedence AGENT_MODEL already
    # has. Cloud text picks don't touch MEDIA_MODEL; .env's own setting (or
    # the cloud default) still applies for images in that case.
    set_media_model_override(
        model_override if model_override and is_ollama_model(model_override) else None
    )

    session = SQLiteSession(SESSION_ID, SESSION_DB)

    try:
        # 1. Run context compaction if history exceeds limits
        await _compact_context_if_needed(session)

        # 2. Load memory and instantiate agent dynamically (web-first model/key)
        memory_prompt = _load_memory()
        dynamic_agent = create_agent(
            memory_prompt=memory_prompt,
            model_name=model_override,
            api_key=key_override,
        )

        result = Runner.run_streamed(
            dynamic_agent,
            input=user_text,
            session=session,
        )

        async for event in result.stream_events():
            if event.type == "raw_response_event" and isinstance(
                event.data, ResponseTextDeltaEvent
            ):
                await bridge.send_delta(event.data.delta)

            elif event.type == "run_item_stream_event":
                item = event.item
                if hasattr(item, "type") and item.type == "tool_call_item":
                    tool_name = getattr(item, "name", None) or "tool"
                    friendly = {
                        "list_chats": "Listing chats",
                        "get_messages": "Fetching messages",
                        "search_messages": "Searching messages",
                        "get_active_chat": "Checking active chat",
                        "transcribe_media": "Processing media",
                        "visit_url": "Reading webpage",
                        "export_chat": "Exporting chat",
                    }.get(tool_name, "Working")
                    await bridge.send_status(f"{friendly}…")

        # Send the final complete message
        final = result.final_output or ""
        await bridge.send_assistant_message(final)
        logger.info("Agent run complete (%d chars)", len(final))

    except Exception:
        logger.exception("Agent run failed")
        try:
            await bridge.send_assistant_message(
                "Sorry, something went wrong while processing your request. "
                "Please try again."
            )
        except Exception:
            pass  # bridge may be disconnected

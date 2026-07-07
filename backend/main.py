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
import time
from pathlib import Path

from agents import Runner, SQLiteSession
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from openai.types.responses import ResponseTextDeltaEvent

from agent import create_agent
from bridge import bridge

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
        history_lines = []
        for item in to_summarize:
            # Helper to get value from dict or object representation
            get_val = lambda k: item.get(k) if isinstance(item, dict) else getattr(item, k, None)
            
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
                        if p_text:
                            part_texts.append(str(p_text))
                        else:
                            part_texts.append(str(p))
                    text = " ".join(part_texts)
                else:
                    text = str(item_parts)
            
            # If it's a tool call/response, represent it cleanly
            item_type = get_val("type")
            if item_type in ("tool_call_item", "tool_call"):
                tool_name = get_val("name") or "tool"
                text = f"[Tool Call: {tool_name}]"
            elif item_type in ("tool_response_item", "tool_response"):
                text = f"[Tool Response]"

            if text:
                history_lines.append(f"{str(role).upper()}: {text}")

        history_text = "\n".join(history_lines)

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

# Session persistence (single-user, fixed ID)
SESSION_DB = str(DATA_DIR / "sessions.db")
SESSION_ID = "wa-agent"


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    await bridge.register(ws)
    logger.info("WebSocket accepted")

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
                        "⏳ I'm still working on the previous request. "
                        "Please wait a moment…"
                    )
                    continue

                agent_task = asyncio.create_task(
                    _run_agent(user_text),
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


async def _run_agent(user_text: str) -> None:
    """
    Execute one turn of the agent, streaming deltas and status updates
    back to the extension via the bridge.
    """
    logger.info("Agent run started: %r", user_text[:120])

    session = SQLiteSession(SESSION_ID, SESSION_DB)

    try:
        # 1. Run context compaction if history exceeds limits
        await _compact_context_if_needed(session)

        # 2. Load memory and instantiate agent dynamically
        memory_prompt = _load_memory()
        dynamic_agent = create_agent(memory_prompt=memory_prompt)

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
                    await bridge.send_status(f"Using {tool_name}…")

        # Send the final complete message
        final = result.final_output or ""
        await bridge.send_assistant_message(final)
        logger.info("Agent run complete (%d chars)", len(final))

    except Exception:
        logger.exception("Agent run failed")
        try:
            await bridge.send_assistant_message(
                "❌ Sorry, something went wrong while processing your request. "
                "Please try again."
            )
        except Exception:
            pass  # bridge may be disconnected

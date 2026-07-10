"""
WhatsApp Agent definition using the OpenAI Agents SDK.

Tools are thin wrappers that delegate execution to the Chrome extension
via the WebSocket bridge.  The LLM is Gemini, accessed through LiteLLM.
"""

from __future__ import annotations

import os

from agents import Agent, function_tool
from agents.extensions.models.litellm_model import LitellmModel
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """\
You are a WhatsApp assistant that helps users understand their chat history.

You have tools to interact with the user's WhatsApp Web:
- list_chats: Get all chat names and metadata (no permission needed)
- get_messages: Fetch messages from a specific chat (paginated)
- search_messages: Search within a chat by text/sender/date
- get_active_chat: Get the currently open chat's info
- transcribe_media: Download and transcribe/describe a voice note (type='ptt'), video (type='video'), or image (type='image') message
- visit_url: Fetch and read the text/Markdown content of any webpage URL shared in chat
- export_chat: Export a chat as HTML/CSV/JSON file download

IMPORTANT GUIDELINES:
1. SEARCH FIRST: Always use search_messages before get_messages. \
Only fetch full message lists as a last resort.
2. PAGINATE: Never request more than 50 messages at once unless specifically asked.
3. PERMISSION RESPECT: Some tools require user permission per chat. \
If denied, acknowledge gracefully and move on.
4. CITE SOURCES: Always mention sender names and approximate dates \
when quoting messages.
5. Be concise but thorough.  Format responses with markdown.
6. MEDIA MESSAGES: When you see messages with type 'image', 'video', \
or 'ptt' (voice note), you CANNOT see their content directly. The body \
field will be null. You MUST call transcribe_media with the message's \
chat_id and message id to get a description (for images/video) or \
transcription (for voice notes). Always do this proactively when a user \
asks about media content — don't say you can't see it.
7. NO TOOL LEAKS: Never mention internal tool names (e.g., `list_chats`, `get_messages`, `search_messages`, `get_active_chat`, `transcribe_media`, `visit_url`, `export_chat`) in your responses to the user. Always describe what you are doing in natural language instead of referring to the underlying functions.
8. USE TOOL RESULTS: After a tool returns data, your reply MUST be built \
from that data — name the actual chats, messages, or content it returned. \
Never reply with a generic greeting or a description of your capabilities \
after fetching data.
"""

# ---------------------------------------------------------------------------
# Tool definitions — each calls the extension bridge
# ---------------------------------------------------------------------------


def _tool_json(result: object) -> str:
    """Serialize a tool result as clean JSON for the model.

    Python's repr (str(result)) is hostile input for small local models —
    single quotes, nested dicts, no guarantees. Proper JSON is what models
    are trained to read. Falls back to str() for non-serializable objects.
    """
    import json

    try:
        return json.dumps(result, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(result)


@function_tool
async def list_chats() -> str:
    """List all WhatsApp chats with their names and metadata.
    Returns chat names, IDs, group status, and unread counts.
    No permission needed - only returns names, never message content.
    """
    from bridge import bridge

    result = await bridge.call_extension("listChats", {})
    return _tool_json(result)


@function_tool
async def get_messages(
    chat_id: str,
    limit: int = 50,
    before_ts: int | None = None,
    after_ts: int | None = None,
) -> str:
    """Fetch messages from a WhatsApp chat (paginated).

    Args:
        chat_id: The chat's serialized ID (from list_chats).
        limit: Max messages to return (1-200, default 50).
        before_ts: Only messages before this unix timestamp (seconds).
        after_ts: Only messages after this unix timestamp (seconds).
    """
    from bridge import bridge

    result = await bridge.call_extension(
        "getMessages",
        {
            "chatId": chat_id,
            "limit": min(limit, 200),
            "beforeTs": before_ts,
            "afterTs": after_ts,
        },
    )
    return _tool_json(result)


@function_tool
async def search_messages(
    chat_id: str,
    query: str = "",
    sender: str | None = None,
    days: int | None = None,
    limit: int = 50,
) -> str:
    """Search messages within a WhatsApp chat.

    Args:
        chat_id: The chat's serialized ID.
        query: Text to search for in message content.
        sender: Filter by sender name (partial match).
        days: Only messages from the last N days.
        limit: Max results (1-200, default 50).
    """
    from bridge import bridge

    result = await bridge.call_extension(
        "searchMessages",
        {
            "chatId": chat_id,
            "query": query,
            "sender": sender,
            "days": days,
            "limit": min(limit, 200),
        },
    )
    return _tool_json(result)


@function_tool
async def get_active_chat() -> str:
    """Get info about the currently open chat in WhatsApp Web.
    Returns the chat ID and name, or null if no chat is open.
    """
    from bridge import bridge

    result = await bridge.call_extension("activeChat", {})
    return _tool_json(result)


@function_tool
async def transcribe_media(chat_id: str, message_id: str) -> str:
    """Download and transcribe/describe a voice note, video, or image message.

    Args:
        chat_id: The chat's serialized ID.
        message_id: The message's serialized ID (from search_messages, type='ptt', type='video', or type='image').
    """
    from transcribe import transcribe_media as _transcribe

    return await _transcribe(chat_id, message_id)


@function_tool
async def visit_url(url: str) -> str:
    """Fetch and read the text/Markdown content of a webpage.

    Args:
        url: The absolute HTTP/HTTPS URL of the webpage to visit.
    """
    from scraper import scrape_url
    return scrape_url(url)


@function_tool
async def export_chat(chat_id: str, format: str = "html") -> str:
    """Export a chat as a downloadable file.

    Args:
        chat_id: The chat's serialized ID.
        format: Export format - 'html', 'csv', or 'json'.
    """
    from bridge import bridge

    result = await bridge.call_extension(
        "exportChat",
        {
            "chatId": chat_id,
            "format": format,
        },
    )
    return _tool_json(result)


# ---------------------------------------------------------------------------
# Agent factory
# ---------------------------------------------------------------------------


def create_agent(
    memory_prompt: str | None = None,
    model_name: str | None = None,
    api_key: str | None = None,
) -> Agent:
    """Create and return the WhatsApp agent.

    Model and key resolve web-first: values passed from the extension settings
    panel win; otherwise fall back to the .env defaults. This lets a user run
    the agent by typing their own key / picking a model in the UI, without
    editing .env. For local models (ollama/*) no key is needed.
    """
    instructions = SYSTEM_PROMPT
    if memory_prompt:
        instructions += f"\n\n{memory_prompt}"

    resolved_model = model_name or os.getenv("AGENT_MODEL", "gemini/gemini-2.5-flash")
    resolved_key = api_key or os.getenv("GEMINI_API_KEY")

    model = LitellmModel(model=resolved_model, api_key=resolved_key)
    return Agent(
        name="WhatsApp Agent",
        instructions=instructions,
        model=model,
        tools=[
            list_chats,
            get_messages,
            search_messages,
            get_active_chat,
            transcribe_media,
            visit_url,
            export_chat,
        ],
    )

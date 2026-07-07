# WhatsApp backup and AI assistant

This is a personal Chrome extension that runs inside WhatsApp Web to export chats and query your history using Gemini. 

It has two modes:
1. Local Copilot: A simple sidebar chat interface that runs entirely in the browser using your own Gemini API key. You can scope questions to specific date ranges (like the last 7 or 30 days) to keep context small.
2. Agent Mode: Connects the sidebar to a local Python backend. The backend uses the OpenAI Agents SDK to give Gemini tool-calling powers. Instead of dumping entire chats, the agent queries what it needs on demand, transcribes voice notes, describes video messages, and keeps a long term memory.

---

## Key features

### Chat export
* Export to JSON: Saves raw message logs with timestamps and sender metadata.
* Export to HTML: Downloads a clean, local conversation viewer with styled chat bubbles.
* Export to CSV: Outputs a simple spreadsheet of the chat.

### Agent tools
* Smart queries: The agent paginates through messages and searches by keywords or sender, avoiding giant payload dumps.
* Media transcription: Decrypts and transcribes voice notes, video messages, and images on the fly. It auto deletes temp media files from your disk and the Gemini API as soon as it is done.
* Long term memory: If your chat history goes past 50 messages, the backend condenses older conversations into a markdown file (`data/memory.md`). It prunes the active SQLite database but keeps the last 10 messages raw so the current conversation doesn't lose context. You can open and edit the memory file directly to teach the agent new facts.

---

## Security and permissions

The extension acts as a gatekeeper for your data:
* Navigating chat lists runs without prompts so the agent can find chats.
* Reading messages or transcribing media triggers a prompt on the page: "Agent wants to read [Chat Name]". You can choose "Allow once", "Always allow", or "Deny".
* Your permissions are saved in your local browser storage. Denials are handled gracefully, and the agent will stop asking if you say no.

---

## Architecture

```
WhatsApp Web (Chrome Extension)              Local Python Backend
┌──────────────────────────────┐             ┌──────────────────────────────┐
│ content.js (Isolated)        │             │ FastAPI  ws://127.0.0.1:8787 │
│  • Local / Agent Sidebar UI  │             │  • Agents SDK Runner         │
│  • Permissions Gate & Store  │◀─WebSocket─▶│  • Model: LiteLLM (Gemini)   │
│  • Tool RPC Dispatcher       │             │  • transcribe: genai SDK     │
│ inject.js (Main / WA-JS)     │             │  • data/ memory.md + SQLite  │
│  • WA-JS hooks & downloads   │             └──────────────────────────────┘
└──────────────────────────────┘
```

---

## Setup and installation

### 1. Load the extension
1. Open Chrome and go to `chrome://extensions`.
2. Turn on "Developer mode" in the top right.
3. Click "Load unpacked" in the top left and select this folder.

### 2. Start the backend
You need the `uv` package manager installed.

```bash
cd backend
cp .env.example .env          # Add your GEMINI_API_KEY
uv sync                       # Install dependencies
uv run fastapi dev main.py    # Starts the dev server on port 8787
```

### 3. Run it
1. Open https://web.whatsapp.com and open a chat.
2. Click the green "Export chat" button in the bottom right to open the sidebar.
3. Toggle from "Local" to "Agent". The status light will turn green when connected.

---

## Project status

- [x] M1: Text export to JSON, CSV, and HTML.
- [x] Local Copilot: In-browser date-scoped AI chat.
- [x] Agent Mode: Bidirectional WebSocket bridge.
- [x] Permissions gate: User authorization store.
- [x] Multimodal support: Transcribing voice, video, and images.
- [x] Structured memory: Markdown context compaction.


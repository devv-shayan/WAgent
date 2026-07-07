# WA Chat Backup & AI Copilot

A powerful, privacy-first personal WhatsApp Web assistant and backup system. It functions as a dual-mode extension: a **Local Copilot** for client-side chat exploration, and a full **Agent Mode** that connects to a local Python backend (using the **OpenAI Agents SDK**) for remote tool execution, multimodal media transcription, and persistent memory.

---

## 🚀 Key Features

### 📦 Chat Backup & Export
* **JSON Export**: Full structured message history (text, stamps, status, sender details).
* **Interactive HTML Export**: A clean, responsive conversation UI with search, media markers, and styled chat bubbles for local archiving.
* **CSV Export**: Clean spreadsheet-ready tabular format.

### 🧠 Dual-Mode AI Integration

#### 1. Local Copilot (Client-Side)
* Direct integration inside the WhatsApp Web sidebar.
* Scopes queries to user-selected date ranges (e.g. last 7 days, 30 days, or custom).
* Runs completely client-side in the browser using your Gemini API Key.

#### 2. Agent Mode (Autonomous Backend)
* Connects the extension to a local FastAPI Python server powered by **OpenAI Agents SDK + LiteLLM → Gemini**.
* **Zero Bulk Dumping**: The agent calls search and pagination tools on-demand, fetching only the specific messages it needs.
* **Multimodal Media Transcription**: Decrypts and transcribes/describes voice notes (`.ogg`), video messages (`.mp4`, `.3gp`), and images (`.jpg`, `.png`, `.webp`) using Gemini's native audio and visual understanding.
* **Automatic File Cleanup**: Temporary media is auto-deleted from your local disk and the Gemini Cloud API instantly after processing.
* **Persistent SQLite Memory**: Retains conversation history across reconnects using a local SQLite session database.
* **Structured Long-Term Memory (Context Compaction)**:
  - When history exceeds 50 messages, the backend automatically runs a compaction loop.
  - Summarizes older messages and updates a human-editable Markdown memory file (`data/memory.md`).
  - Prunes the SQLite database while keeping the last 10 messages raw for immediate conversational flow.
  - You can edit `data/memory.md` manually to change or add facts the agent should remember!

---

## 🔒 Security & Permission Model

Your privacy is authoritative. The extension acts as a gatekeeper:
* **`list_chats`**: Runs freely so the agent can help you navigate chat names.
* **Content Reading (`get_messages`, `search_messages`, `transcribe_media`)**: Renders an inline permission prompt in WhatsApp Web: _"Agent wants to read 「Group Name」 — [Allow once] [Always allow] [Deny]"_.
* Grants are persisted locally in `chrome.storage.local`. Denials are respected gracefully, and the agent adjusts its plan immediately.

---

## 🛠️ Architecture

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

## ⚙️ Setup & Installation

### 1. Load Chrome Extension
1. Open Chrome and go to `chrome://extensions`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** (top-left) and select this root folder.

### 2. Start Python Backend
Make sure you have **[uv](https://docs.astral.sh/uv/)** installed.

```bash
cd backend
cp .env.example .env          # Add your GEMINI_API_KEY
uv sync                       # Install all managed dependencies
uv run fastapi dev main.py    # Starts development server on port 8787
```

### 3. Usage
1. Open <https://web.whatsapp.com> and open any chat.
2. Click the green **⤓ Export chat** button (bottom-right) to slide out the sidebar.
3. Switch the toggle from **Local** to **Agent**.
4. The connection status indicator will turn **🟢 green**. Start chatting!

---

## 🗺️ Project Status

- [x] **M1: Core Exporter** — JSON, CSV, and HTML text export.
- [x] **Local Copilot** — In-extension Gemini chat client.
- [x] **Agent Mode WebSocket Bridge** — Bidirectional RPC tool execution.
- [x] **Secure Permissions** — Browser-side permissions gate.
- [x] **Multimodal Media Support** — Real-time voice note and video transcription.
- [x] **Structured Memory** — Markdown-based context compaction and persistence.


<p align="center">
  <img src="assets/logo.svg" alt="WAgent Logo" width="96" height="96">
</p>

# WAgent — WhatsApp agent that asks before it reads

A Chrome extension that puts an AI agent inside your own WhatsApp Web session. It answers questions about your chats — "did anything important happen in the finance group this week?" — without you scrolling through hundreds of messages.

Three things make it different from a chat summarizer:

1. **It asks permission, per chat, and you watch it ask.** Before the agent reads any conversation or transcribes any media, a prompt appears on the page: *"Agent wants to read [Chat Name]"* — Allow once, Always allow, or Deny. Nothing is read silently.
2. **You can read the code.** It's open source. The whole point of a tool that touches your private messages is that you can audit exactly what it does. Nothing is hidden in a server you can't see.
3. **The brain runs on your own machine, by default.** The one-command Windows installer sets up a local model (Gemma 4 via Ollama) as the agent's default text model — your message text never leaves your computer, out of the box. Prefer cloud Gemini for speed/quality instead? Switch anytime, one line.

It runs *inside* your existing, already-logged-in WhatsApp Web tab. It does not link a new device, scan a QR code, or open a second session — so it behaves like you using WhatsApp Web, not like a bot logging in beside you.

---

## What it does

* **Answers questions on demand.** The agent searches and paginates through messages by keyword, sender, or date instead of dumping whole chats into a model. Ask it what you missed; it fetches only what it needs.
* **Understands media.** It transcribes voice notes, describes videos and images, and can read the text of any link shared in a chat.
* **Remembers across sessions.** Older conversation gets condensed into an editable markdown file (`data/memory.md`) so the agent keeps context over time. Open the file and edit it yourself to teach it facts.
* **Exports your history.** Any chat to JSON (raw logs), HTML (a clean local viewer), or CSV.

---

## Privacy: what's local and what isn't

Be precise about this, because "private" claims are easy to overstate.

| Part | Today | Notes |
|------|-------|-------|
| **Text agent** | **Local by default (Windows installer)** | `install.ps1` sets up a local model (`ollama_chat/gemma4:e2b`) as the default — your message text never leaves your machine. Manual setup (`.env.example`) defaults to cloud Gemini instead; switch either way anytime by setting `AGENT_MODEL=ollama_chat/<model>` in `.env` or the extension's Agent settings. Verify with `uv run python verify_local.py`. |
| **Media transcription** | **Cloud (Gemini) only, for now** | Voice notes, video, and images are uploaded to Google Gemini for transcription, then deleted from disk and from Gemini's API. This needs `GEMINI_API_KEY` even if the text model is local. |
| **Message data** | **Stays in your browser + local backend** | Messages live in your WhatsApp Web session and a local SQLite DB. They're only sent to a model when the agent reads them through a tool you approved. |

**Shipped:** the local text agent (Gemma 4 via Ollama, `ollama_chat/gemma4:e2b`) — the Windows installer sets this as the default. **On the roadmap:** wiring that same local model into media transcription (Gemma 4 also supports images, audio, and video). It's technically possible today but not wired up yet, and a small on-device model transcribes less accurately than cloud Gemini, so it'll be a privacy-vs-quality choice, not a strict upgrade. Until then, media transcription is cloud-only, regardless of which text model you use.

---

## Honest caveat: built on WhatsApp Web internals

This hooks into WhatsApp Web's front-end via [WA-JS](https://github.com/wppconnect-team/wa-js). WhatsApp ships front-end changes that can break those hooks, so expect occasional breakage after a WhatsApp update until the hooks are patched. Because it rides your existing session rather than linking a new device, account-ban risk is low — but automating WhatsApp Web is still against WhatsApp's Terms of Service, so use a personal account you're comfortable with and understand the tradeoff.

---

## Two modes

1. **Manual mode** — export any chat to JSON, HTML, or CSV, scoped to a date range (last 7 / 30 days or a custom range). Runs entirely in the browser — no backend, no API key. Just export.
2. **Agent Mode** — connects the sidebar to a local Python backend (OpenAI Agents SDK). This is where on-demand querying, media transcription, link reading, and long-term memory live.

---

## Architecture

```
WhatsApp Web (Chrome Extension)              Local Python Backend
┌──────────────────────────────┐             ┌──────────────────────────────┐
│ content.js (Isolated)        │             │ FastAPI  ws://127.0.0.1:8787 │
│  • Manual / Agent Sidebar UI │             │  • Agents SDK Runner         │
│  • Permissions Gate & Store  │◀─WebSocket─▶│  • Text: LiteLLM             │
│  • Tool RPC Dispatcher       │             │    (Gemini OR local Ollama)  │
│ inject.js (Main / WA-JS)     │             │  • Media: Gemini (genai SDK) │
│  • WA-JS hooks & downloads   │             │  • data/ memory.md + SQLite  │
└──────────────────────────────┘             └──────────────────────────────┘
```

---

## Permissions model

The extension is the gatekeeper for your data:

* Navigating chat lists runs without prompts, so the agent can find chats by name (names only, never message content).
* Reading messages or transcribing media triggers an on-page prompt: *"Agent wants to read [Chat Name]"* — Allow once, Always allow, or Deny.
* Permissions are stored in your local browser storage. Denials are handled gracefully, and the agent stops asking once you say no.

---

## Setup

### 1. Load the extension
1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** (top left) and select this folder.

### 2. Set up the backend

**Windows — one command does everything** (installs `uv` if missing, installs
dependencies, creates `.env`, installs Ollama + the local Gemma 4 model and
makes it the default agent model — fully local text AI out of the box — and
sets the backend to auto-start hidden at login so it survives reboots with no
terminal):

```powershell
cd backend
powershell -ExecutionPolicy Bypass -File install.ps1
```

Heads-up: the local model is a **7.2 GB download**. To skip it and use cloud
Gemini instead, run `install.ps1 -SkipLocal`. You can switch models anytime in
the extension's Agent settings (gear icon). Undo the auto-start anytime with
`uninstall-autostart.ps1`. Logs live in `data/backend.log`.

**Manual / Mac / Linux** — you need the [`uv`](https://docs.astral.sh/uv/) package manager:

```bash
cd backend
cp .env.example .env          # optional: set GEMINI_API_KEY / AGENT_MODEL here
uv sync                       # install dependencies
uv run fastapi dev main.py --port 8787    # dev server (the extension expects port 8787)
```

The `.env` key/model are optional — you can instead type your own API key and pick
a model (cloud or local) in the extension's **Agent settings** (the gear icon in
Agent mode). Web settings override `.env`; leave them blank to use `.env`. Hit
**Refresh models** there to pull the real, current model list for your key
(Gemini) or whatever's actually pulled (Ollama) straight from the provider —
no more guessing which model names are still valid.

**Optional — run the text agent fully local:**

```bash
# install Ollama (https://ollama.com), then:
ollama pull gemma4:e2b
# in backend/.env set:  AGENT_MODEL=ollama_chat/gemma4:e2b
uv run python verify_local.py   # confirms text stays on your machine
```

Note: media transcription still uses Gemini even with a local text model (see the privacy table above).

### 3. Run it
1. Open https://web.whatsapp.com and open a chat.
2. Click the green **Export chat** button (bottom right) to open the sidebar.
3. Toggle from **Manual** to **Agent**. The status light turns green when connected.

---

## Project status

- [x] Text export to JSON, CSV, and HTML
- [x] Manual mode: in-browser, date-scoped chat export (JSON/HTML/CSV)
- [x] Agent Mode: bidirectional WebSocket bridge
- [x] Permissions gate: per-chat authorization store
- [x] Multimodal transcription (voice, video, images) — via cloud Gemini
- [x] Structured memory: markdown context compaction
- [x] Local text model option (Ollama via LiteLLM)
- [ ] Fully-local media transcription (Gemma 4 on Ollama)
- [ ] Lower-friction first-run setup

---

## License

Copyright (C) 2026 devv-shayan.

Licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0). See
[LICENSE](LICENSE) for the full text.

In plain terms: you're free to use, self-host, study, and modify this. But if you
run a modified version as a network service, the AGPL requires you to make your
modified source available to its users. That keeps the project open and stops
anyone from taking it closed-source into a hosted product without giving back.

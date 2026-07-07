/*
 * content.js  —  runs in the ISOLATED world.
 *
 * Can't see WhatsApp's JS, but shares the DOM (so it can add our button) and
 * talks to inject.js over window.postMessage. It formats the data inject.js
 * returns into JSON + HTML files and triggers the downloads.
 */
(function () {
  "use strict";
  const TAG = "[WA-Backup:content]";

  // --- bridge to inject.js (promise per request) ----------------------------
  function callInject(action, payload) {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      function onMsg(ev) {
        if (ev.source !== window) return;
        const d = ev.data;
        if (!d || d.__wabackup !== "response" || d.id !== id) return;
        window.removeEventListener("message", onMsg);
        d.ok ? resolve(d.result) : reject(new Error(d.error || "unknown error"));
      }
      window.addEventListener("message", onMsg);
      window.postMessage({ __wabackup: "request", id, action, payload }, "*");
    });
  }

  // --- UI -------------------------------------------------------------------
  function makeButton() {
    if (document.getElementById("wa-backup-btn")) return;
    const btn = document.createElement("button");
    btn.id = "wa-backup-btn";
    btn.textContent = "⤓ Export chat";
    btn.addEventListener("click", togglePanel);
    document.body.appendChild(btn);
  }

  let conversationHistory = []; // stores { role: 'user'|'model', parts: [{ text: '...' }] }
  let chatTranscriptCache = null; // cached string transcript
  let chatDataCache = null; // cached raw exported chat data object
  let currentMode = 'local'; // 'local' | 'agent'
  let agentClient = null; // AgentClient instance (lazy)

  function adjustWhatsAppLayout(isOpen) {
    const app = document.getElementById("app");
    if (app) {
      app.style.transition = "width 0.25s cubic-bezier(0.4, 0, 0.2, 1)";
      if (isOpen) {
        app.style.width = "calc(100% - 400px)";
      } else {
        app.style.width = "";
      }
    }
  }

  function togglePanel() {
    const existing = document.getElementById("wa-backup-sidebar");
    if (existing) {
      if (agentClient) agentClient.disconnect();
      existing.remove();
      adjustWhatsAppLayout(false);
      return;
    }
    adjustWhatsAppLayout(true);
    const sidebar = document.createElement("div");
    sidebar.id = "wa-backup-sidebar";
    sidebar.innerHTML = `
      <div class="wab-sidebar-header">
        <div class="wab-sidebar-title">
          <span class="wab-accent-dot" id="wab-title-dot"></span> Chat Copilot
        </div>
        <div class="wab-sidebar-actions">
          <div class="wab-mode-toggle">
            <button class="wab-mode-btn active" data-mode="local">Local</button>
            <button class="wab-mode-btn" data-mode="agent">Agent</button>
          </div>
          <button class="wab-icon-btn" id="wab-settings-toggle" title="Settings">⚙️</button>
          <button class="wab-icon-btn" id="wab-sidebar-close" title="Close Panel">&times;</button>
        </div>
      </div>

      <div class="wab-sidebar-content">
        <!-- Settings section -->
        <div id="wab-settings-section" class="wab-section collapsed">
          <div class="wab-section-title">Configuration</div>
          
          <div class="wab-settings-group">
            <div class="wab-sub-title">Export Formats</div>
            <div class="wab-hint">Uses the date range selected in the main panel.</div>
            <div class="wab-formats">
              <label><input type="checkbox" id="wab-fmt-json" checked> JSON</label>
              <label><input type="checkbox" id="wab-fmt-html" checked> HTML</label>
              <label><input type="checkbox" id="wab-fmt-csv"> CSV</label>
            </div>
            <button id="wab-go">Export Files</button>
          </div>

          <div class="wab-settings-group" style="margin-top: 12px;">
            <div class="wab-sub-title">Gemini API Key</div>
            <div class="wab-field-col">
              <input type="password" id="wab-gemini-key" placeholder="Enter API Key">
            </div>
            <div class="wab-sub-title">Model</div>
            <div class="wab-field-col">
              <select id="wab-gemini-model">
                <option value="gemini-3.5-flash">Gemini 3.5 Flash (Recommended)</option>
                <option value="gemini-3.5-pro">Gemini 3.5 Pro</option>
                <option value="gemini-3.1-pro">Gemini 3.1 Pro (Reasoning)</option>
                <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash-Lite</option>
                <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
              </select>
            </div>
          </div>
        </div>

        <!-- Chat / Summary Container -->
        <div class="wab-chat-container">
          <!-- Welcome landing view -->
          <div id="wab-chat-welcome" class="wab-welcome-state">
            <div class="wab-welcome-icon">💬</div>
            <h3>Chat Copilot</h3>
            <p>Pick how much of this chat to load, then summarize or ask questions.</p>

            <div class="wab-range-picker">
              <div class="wab-presets">
                <button class="wab-preset-btn" data-days="7">7 days</button>
                <button class="wab-preset-btn" data-days="30">30 days</button>
                <button class="wab-preset-btn" data-days="90">3 months</button>
                <button class="wab-preset-btn active" data-days="">Everything</button>
              </div>
              <label class="wab-field">From
                <input type="date" id="wab-from">
              </label>
              <label class="wab-field">To
                <input type="date" id="wab-to">
              </label>
              <div class="wab-hint">Empty = full history</div>
              <button id="wab-load">Load messages</button>
            </div>

            <div id="wab-loaded-info" class="hidden"></div>

            <div id="wab-welcome-actions" class="hidden">
            
            <button id="wab-summarize">Summarize Chat</button>

            <div class="wab-suggestions">
              <div class="wab-suggest-title">Try asking:</div>
              <button class="wab-suggest-btn" data-query="What are the key decisions made in this chat?">Decisions made</button>
              <button class="wab-suggest-btn" data-query="List all action items and who they are assigned to.">Action items</button>
              <button class="wab-suggest-btn" data-query="What was the main topic of conversation?">Main topic</button>
              <button class="wab-suggest-btn" data-query="Give me a summary of the sentiment in this chat.">Sentiment summary</button>
            </div>
            </div>
          </div>

          <!-- Chat history view -->
          <div id="wab-chat-messages" class="wab-messages-list hidden"></div>
        </div>
      </div>

      <!-- Status line: lives OUTSIDE the welcome view so it stays visible
           during Q&A (welcome gets hidden once a conversation starts). -->
      <div class="wab-status" id="wab-status"></div>

      <!-- Text input area sticky at the bottom -->
      <div class="wab-chat-input-area hidden" id="wab-chat-input-bar">
        <textarea id="wab-query-input" placeholder="Ask anything about this chat... (Press Enter)"></textarea>
        <button id="wab-query-send" title="Send query">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"></path>
          </svg>
        </button>
      </div>

      <!-- ======= Agent Mode Views (hidden by default) ======= -->
      <div id="wab-agent-container" class="wab-sidebar-content" style="display:none;">
        <div class="wab-chat-container">
          <div id="wab-agent-welcome" class="wab-agent-welcome">
            <div class="wab-welcome-icon">🤖</div>
            <h3>WhatsApp Agent</h3>
            <p>Ask me anything about your chats. I'll search and fetch what's needed.</p>
            <div class="wab-agent-suggestions">
              <div class="wab-suggest-title">Try asking:</div>
              <button class="wab-suggest-btn wab-agent-suggest" data-query="What chats do I have?">What chats do I have?</button>
              <button class="wab-suggest-btn wab-agent-suggest" data-query="Summarize the most recent conversation">Summarize recent conversation</button>
              <button class="wab-suggest-btn wab-agent-suggest" data-query="Any unread messages?">Any unread messages?</button>
            </div>
          </div>
          <div id="wab-agent-messages" class="wab-messages-list hidden"></div>
        </div>
      </div>
      <div class="wab-agent-status" id="wab-agent-status"></div>
      <div class="wab-chat-input-area hidden" id="wab-agent-input-bar">
        <textarea id="wab-agent-input" placeholder="Ask about your chats... (Press Enter)"></textarea>
        <button id="wab-agent-send" title="Send">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"></path>
          </svg>
        </button>
      </div>
    `;

    document.body.appendChild(sidebar);

    // Close actions
    const closeBtn = document.getElementById("wab-sidebar-close");
    closeBtn.addEventListener("click", () => {
      if (agentClient) agentClient.disconnect();
      sidebar.remove();
      adjustWhatsAppLayout(false);
    });

    // Settings panel toggle
    const settingsToggle = document.getElementById("wab-settings-toggle");
    settingsToggle.addEventListener("click", () => {
      const settingsSection = document.getElementById("wab-settings-section");
      settingsSection.classList.toggle("collapsed");
    });

    // Mode toggle (Local / Agent)
    sidebar.querySelectorAll(".wab-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-mode");
        if (mode === currentMode) return;
        sidebar.querySelectorAll(".wab-mode-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        switchMode(mode);
      });
    });

    // Agent suggestion buttons
    sidebar.querySelectorAll(".wab-agent-suggest").forEach((btn) => {
      btn.addEventListener("click", () => {
        const query = btn.getAttribute("data-query");
        if (query) onAgentQuerySubmit(query);
      });
    });

    // Agent input handling
    const agentInput = document.getElementById("wab-agent-input");
    const agentSend = document.getElementById("wab-agent-send");
    agentInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const q = agentInput.value.trim();
        if (q) { agentInput.value = ""; onAgentQuerySubmit(q); }
      }
    });
    agentSend.addEventListener("click", () => {
      const q = agentInput.value.trim();
      if (q) { agentInput.value = ""; onAgentQuerySubmit(q); }
    });

    // Wire up exporter
    document.getElementById("wab-go").addEventListener("click", onExportClick);
    
    // Wire up range presets + the Load step (step 1 of the copilot flow)
    sidebar.querySelectorAll(".wab-preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        sidebar.querySelectorAll(".wab-preset-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        applyPresetDays(btn.getAttribute("data-days"));
      });
    });
    // Typing a manual date deselects any preset chip
    ["wab-from", "wab-to"].forEach((fid) => {
      document.getElementById(fid)?.addEventListener("input", () => {
        sidebar.querySelectorAll(".wab-preset-btn").forEach((b) => b.classList.remove("active"));
      });
    });
    document.getElementById("wab-load").addEventListener("click", onLoadClick);

    // Wire up summarizer
    document.getElementById("wab-summarize").addEventListener("click", () => onSummarizeClick());

    // Wire up suggestion buttons
    const suggestBtns = sidebar.querySelectorAll(".wab-suggest-btn");
    suggestBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const query = btn.getAttribute("data-query");
        if (query) {
          onQuerySubmit(query);
        }
      });
    });

    // Wire up Chat input submission
    const queryInput = document.getElementById("wab-query-input");
    const querySend = document.getElementById("wab-query-send");

    queryInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const query = queryInput.value.trim();
        if (query) {
          queryInput.value = "";
          onQuerySubmit(query);
        }
      }
    });

    querySend.addEventListener("click", () => {
      const query = queryInput.value.trim();
      if (query) {
        queryInput.value = "";
        onQuerySubmit(query);
      }
    });

    // Save inputs automatically on change
    document.getElementById("wab-gemini-key")?.addEventListener("input", (e) => {
      chrome.storage.local.set({ geminiKey: e.target.value });
    });
    document.getElementById("wab-gemini-model")?.addEventListener("change", (e) => {
      chrome.storage.local.set({ geminiModel: e.target.value });
    });

    // Populate inputs from local storage
    chrome.storage.local.get(["geminiKey", "geminiModel"], (res) => {
      const keyInput = document.getElementById("wab-gemini-key");
      const modelSelect = document.getElementById("wab-gemini-model");
      if (keyInput && res.geminiKey) keyInput.value = res.geminiKey;
      if (modelSelect && res.geminiModel) modelSelect.value = res.geminiModel;
    });

    // Reset session caches on panel load
    conversationHistory = [];
    chatTranscriptCache = null;
    chatDataCache = null;
  }

  function setStatus(text, busy) {
    const el = document.getElementById("wab-status");
    if (el) el.textContent = text;
    const go = document.getElementById("wab-go");
    if (go) go.disabled = !!busy;
    const sum = document.getElementById("wab-summarize");
    if (sum) sum.disabled = !!busy;
  }

  // Date inputs are local dates; convert to inclusive unix-seconds bounds:
  // "from" = 00:00:00.000 local, "to" = 23:59:59.999 local that day.
  function readRange() {
    const from = document.getElementById("wab-from")?.value;
    const to = document.getElementById("wab-to")?.value;
    const startTs = from
      ? Math.floor(new Date(from + "T00:00:00").getTime() / 1000)
      : null;
    const endTs = to
      ? Math.floor(new Date(to + "T23:59:59.999").getTime() / 1000)
      : null;
    if (startTs !== null && endTs !== null && startTs > endTs)
      throw new Error("'From' date is after 'To' date");
    return { startTs, endTs };
  }

  async function onExportClick() {
    try {
      const formats = {
        json: document.getElementById("wab-fmt-json")?.checked,
        html: document.getElementById("wab-fmt-html")?.checked,
        csv: document.getElementById("wab-fmt-csv")?.checked,
      };
      if (!formats.json && !formats.html && !formats.csv)
        throw new Error("Pick at least one format");
      const range = readRange();

      setStatus("⏳ Reading messages…", true);
      const data = await callInject("exportActiveChat", range);
      if (data.messageCount === 0)
        throw new Error(`No messages in that range (chat has ${data.totalInChat})`);

      const base = safeName(data.chat.name) + "_" + stamp();
      if (formats.json)
        download(base + ".json", JSON.stringify(data, null, 2), "application/json");
      if (formats.html) download(base + ".html", renderHtml(data), "text/html");
      if (formats.csv) download(base + ".csv", renderCsv(data), "text/csv");

      setStatus(`✓ Exported ${data.messageCount} of ${data.totalInChat} messages`, false);
    } catch (err) {
      console.error(TAG, err);
      setStatus("✗ " + err.message, false);
    }
  }

  // --- output builders ------------------------------------------------------
  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // Map message type to a human-friendly badge shown when there's no text/thumb.
  const TYPE_BADGES = {
    image: "📷 Image", video: "🎬 Video", sticker: "🏷️ Sticker",
    document: "📎 Document", ptt: "🎤 Voice note", audio: "🎵 Audio",
    vcard: "👤 Contact card", location: "📍 Location",
    gp2: "👥 Group event", revoked: "🚫 Deleted message",
    e2e_notification: "🔒 Encryption notice",
  };

  // Render the quoted/replied-to message bubble (the grey box above the reply).
  function renderQuotedBubble(q) {
    if (!q) return "";
    const who = q.senderName || q.participant || "Someone";
    const qBadge = TYPE_BADGES[q.type];
    const preview = q.body
      ? escapeHtml(q.body.length > 120 ? q.body.slice(0, 120) + "…" : q.body)
      : q.caption
        ? escapeHtml(q.caption.length > 120 ? q.caption.slice(0, 120) + "…" : q.caption)
        : escapeHtml(qBadge || `[${q.type}]`);
    return `<div class="quoted">
      <div class="quoted-sender">${escapeHtml(who)}</div>
      <div class="quoted-text">${preview}</div>
    </div>`;
  }

  function renderMessageContent(m) {
    let html = renderQuotedBubble(m.quotedMsg);
    // 1. If we have a thumbnail, show the actual image
    if (m.thumbnail) {
      const img = `<img src="data:image/jpeg;base64,${m.thumbnail}" style="max-width:260px;border-radius:6px;display:block;margin:4px 0" alt="${escapeHtml(m.type || 'media')}">`;
      const cap = m.caption ? `<div class="text">${escapeHtml(m.caption)}</div>` : "";
      return html + img + cap;
    }
    // 2. Text message — use body
    if (m.body) return html + `<div class="text">${escapeHtml(m.body)}</div>`;
    // 3. Caption-only (e.g. document with no inline thumb)
    if (m.caption) return html + `<div class="text">${escapeHtml(m.caption)}</div>`;
    // 4. Fallback: human-friendly type badge
    const badge = TYPE_BADGES[m.type] || `[${m.type}]`;
    return html + `<div class="text type-badge">${escapeHtml(badge)}</div>`;
  }

  function renderHtml(data) {
    const rows = data.messages
      .map((m) => {
        const who = m.fromMe ? "me" : "them";
        const name = m.fromMe ? "You" : m.senderName || m.author || "Contact";
        const time = m.time ? new Date(m.time).toLocaleString() : "";
        return `<div class="msg ${who}">
          <div class="meta">${escapeHtml(name)} · ${escapeHtml(time)}</div>
          ${renderMessageContent(m)}
        </div>`;
      })
      .join("\n");

    return `<!doctype html><html><head><meta charset="utf-8">
<title>${escapeHtml(data.chat.name)} — WhatsApp export</title>
<style>
  body{font-family:system-ui,Segoe UI,sans-serif;background:#e5ddd5;margin:0;padding:24px}
  h1{font-size:18px}
  .wrap{max-width:720px;margin:0 auto}
  .msg{max-width:75%;margin:6px 0;padding:8px 10px;border-radius:8px;background:#fff;box-shadow:0 1px 1px rgba(0,0,0,.1)}
  .msg.me{margin-left:auto;background:#dcf8c6}
  .meta{font-size:11px;color:#667;margin-bottom:2px}
  .text{white-space:pre-wrap;word-wrap:break-word}
  .type-badge{color:#888;font-style:italic;font-size:13px}
  img{max-width:100%}
  .quoted{background:#f0f0f0;border-left:3px solid #25d366;border-radius:6px;padding:4px 8px;margin-bottom:4px;font-size:12px}
  .msg.me .quoted{background:#c8edb8;border-left-color:#128c7e}
  .quoted-sender{font-weight:600;color:#128c7e;margin-bottom:1px}
  .quoted-text{color:#555;white-space:pre-wrap;word-wrap:break-word;max-height:60px;overflow:hidden}
</style></head><body><div class="wrap">
<h1>${escapeHtml(data.chat.name)}</h1>
<p>${data.messageCount} messages${rangeLabel(data.range)} · exported ${escapeHtml(data.exportedAt)}</p>
${rows}
</div></body></html>`;
  }

  function rangeLabel(range) {
    if (!range || (range.startTs === null && range.endTs === null)) return "";
    const d = (ts) => (ts === null ? "…" : new Date(ts * 1000).toLocaleDateString());
    return escapeHtml(` (${d(range.startTs)} – ${d(range.endTs)})`);
  }

  function renderCsv(data) {
    const cols = ["time", "senderName", "author", "fromMe", "type", "body", "caption", "filename", "replyTo"];
    const head = cols.join(",");
    const rows = data.messages.map((m) => {
      // For CSV, use body if present, otherwise caption, otherwise a type tag.
      // Never dump base64 thumbnails into a spreadsheet cell.
      const q = m.quotedMsg;
      const replyTo = q
        ? `${q.senderName || q.participant || "?"}: ${(q.body || q.caption || `[${q.type}]`).slice(0, 80)}`
        : "";
      const csvRow = { ...m, body: m.body || m.caption || `[${m.type}]`, replyTo };
      return cols.map((c) => csvCell(csvRow[c])).join(",");
    });
    // ﻿ BOM so Excel detects UTF-8 (otherwise emoji/urdu turn to mojibake)
    return "\u{FEFF}" + [head, ...rows].join("\r\n");
  }

  // RFC 4180: wrap in quotes if the value contains comma/quote/newline;
  // double any quotes inside.
  function csvCell(v) {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // --- helpers --------------------------------------------------------------
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function safeName(s) {
    return String(s || "chat").replace(/[^\w\-]+/g, "_").slice(0, 60);
  }
  function stamp() {
    return new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  }

  // --- AI Copilot Chat Engine -----------------------------------------------

  function toDateInputValue(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // Fill From/To from a preset chip. Empty days = full history.
  function applyPresetDays(days) {
    const from = document.getElementById("wab-from");
    const to = document.getElementById("wab-to");
    if (!from || !to) return;
    if (!days) {
      from.value = "";
      to.value = "";
      return;
    }
    const now = new Date();
    to.value = toDateInputValue(now);
    from.value = toDateInputValue(
      new Date(now.getTime() - (Number(days) - 1) * 86400000)
    );
  }

  // Fetches the active chat for the current range and prepares the AI
  // transcript (asking the user about truncation if it's oversized).
  async function loadTranscript() {
    const range = readRange();
    setStatus("Reading messages…", true);
    const data = await callInject("exportActiveChat", range);
    if (data.messageCount === 0)
      throw new Error(`No messages in that range (chat has ${data.totalInChat})`);
    chatDataCache = data;
    chatTranscriptCache = await prepareTranscript(data);
    return data;
  }

  // Step 1 of the copilot flow: the user picked a range and explicitly loads
  // it. Only then do Summarize / suggestions / the input bar appear.
  async function onLoadClick() {
    const btn = document.getElementById("wab-load");
    try {
      btn.disabled = true;
      // A (re)load resets the session: new scope = new conversation.
      conversationHistory = [];
      chatTranscriptCache = null;
      chatDataCache = null;
      const msgList = document.getElementById("wab-chat-messages");
      if (msgList) msgList.innerHTML = "";

      const data = await loadTranscript();

      const info = document.getElementById("wab-loaded-info");
      info.textContent = `✓ ${data.messageCount} of ${data.totalInChat} messages loaded from “${data.chat.name}”`;
      info.classList.remove("hidden");
      document.getElementById("wab-welcome-actions").classList.remove("hidden");
      document.getElementById("wab-chat-input-bar").classList.remove("hidden");
      btn.textContent = "Reload";
      setStatus("Ready — summarize or ask anything", false);
    } catch (err) {
      console.error(TAG, err);
      setStatus("✗ " + err.message, false);
    } finally {
      btn.disabled = false;
    }
  }

  async function onSummarizeClick() {
    try {
      const key = document.getElementById("wab-gemini-key")?.value?.trim();
      const model = document.getElementById("wab-gemini-model")?.value;
      if (!key) {
        document.getElementById("wab-settings-section")?.classList.remove("collapsed");
        throw new Error("Please enter your Gemini API Key first (under settings ⚙️)");
      }

      // Transition layout
      document.getElementById("wab-chat-welcome").style.display = "none";
      const messagesList = document.getElementById("wab-chat-messages");
      const inputBar = document.getElementById("wab-chat-input-bar");
      messagesList.classList.remove("hidden");
      inputBar.classList.remove("hidden");

      // Loading bubble
      const loading = appendLoadingBubble();

      // Safety net — normally the Load step (step 1) already prepared this.
      if (!chatTranscriptCache) {
        try {
          await loadTranscript();
        } catch (e) {
          loading.remove();
          document.getElementById("wab-chat-welcome").style.display = "flex";
          messagesList.classList.add("hidden");
          inputBar.classList.add("hidden");
          throw e;
        }
      }

      setStatus("Generating summary...", true);

      const summaryPrompt = `You are an expert chat analyst. Summarize the following WhatsApp chat transcript.
Structure your summary professionally using these exact sections:

# AI Summary: ${chatDataCache.chat.name}

## 1. Executive Summary
Provide a concise 2-3 sentence overview of the conversation's purpose and general outcome.

## 2. Key Discussion Topics
Highlight the main themes and topics discussed in bullet points, including what was said or debated about each.

## 3. Decisions & Agreements
List any concrete decisions, alignments, or agreements made between participants. If none, state "No explicit decisions made."

## 4. Action Items & Next Steps
Create a checklist of tasks, assignments, and unresolved issues with assignees if mentioned.

## 5. Sentiment & Activity
Describe the general tone of the conversation and note the most active participants.

Keep it clean, organized, and do not include greeting exchanges. Use clear bullet points and bold text where relevant.

Transcript:
${chatTranscriptCache}`;

      conversationHistory = [
        {
          role: "user",
          parts: [{ text: summaryPrompt }]
        }
      ];

      const responseText = await callGeminiChatAPI(key, model, conversationHistory);

      conversationHistory.push({
        role: "model",
        parts: [{ text: responseText }]
      });

      loading.remove();

      const uniqueId = "sum_" + Date.now();
      const htmlContent = `
        <div class="wab-summary-text">${parseMarkdownToHtml(responseText)}</div>
        <div class="wab-bubble-actions">
          <button class="wab-bubble-btn" id="wab-copy-${uniqueId}">Copy summary</button>
          <button class="wab-bubble-btn" id="wab-download-${uniqueId}">Download TXT</button>
        </div>
      `;

      appendMessageBubble("ai", htmlContent);

      document.getElementById(`wab-copy-${uniqueId}`).addEventListener("click", async () => {
        const btn = document.getElementById(`wab-copy-${uniqueId}`);
        try {
          await navigator.clipboard.writeText(responseText);
          btn.textContent = "Copied!";
        } catch (e) {
          console.error(TAG, "clipboard", e);
          btn.textContent = "Copy failed";
        }
        setTimeout(() => (btn.textContent = "Copy summary"), 2000);
      });

      document.getElementById(`wab-download-${uniqueId}`).addEventListener("click", () => {
        download(`${safeName(chatDataCache.chat.name)}_summary.txt`, responseText, "text/plain");
      });

      setStatus("Summary ready", false);
    } catch (err) {
      console.error(TAG, err);
      setStatus("Error: " + err.message, false);
    }
  }

  async function onQuerySubmit(query) {
    try {
      const key = document.getElementById("wab-gemini-key")?.value?.trim();
      const model = document.getElementById("wab-gemini-model")?.value;
      if (!key) {
        document.getElementById("wab-settings-section")?.classList.remove("collapsed");
        throw new Error("Please enter your Gemini API Key first (under settings ⚙️)");
      }

      // Transition layout if welcome is visible
      if (document.getElementById("wab-chat-welcome").style.display !== "none") {
        document.getElementById("wab-chat-welcome").style.display = "none";
        document.getElementById("wab-chat-messages").classList.remove("hidden");
        document.getElementById("wab-chat-input-bar").classList.remove("hidden");
      }

      // Render user question bubble
      appendMessageBubble("user", `<p>${escapeHtml(query)}</p>`);

      // Render loading bubble
      const loading = appendLoadingBubble();

      // Safety net — normally the Load step (step 1) already prepared this.
      if (!chatTranscriptCache) {
        try {
          await loadTranscript();
        } catch (e) {
          loading.remove();
          throw e;
        }
      }

      setStatus("Thinking...", true);

      if (conversationHistory.length === 0) {
        const initialPrompt = `You are an expert chat assistant. You are provided with a WhatsApp chat transcript.
Answer the user's question about the chat transcript. Be helpful, concise, and refer to facts in the transcript.

Chat Name: ${chatDataCache.chat.name}

Transcript:
${chatTranscriptCache}

User Question: ${query}`;

        conversationHistory.push({
          role: "user",
          parts: [{ text: initialPrompt }]
        });
      } else {
        conversationHistory.push({
          role: "user",
          parts: [{ text: query }]
        });
      }

      const reply = await callGeminiChatAPI(key, model, conversationHistory);

      conversationHistory.push({
        role: "model",
        parts: [{ text: reply }]
      });

      loading.remove();

      appendMessageBubble("ai", parseMarkdownToHtml(reply));
      setStatus("Ready", false);
    } catch (err) {
      console.error(TAG, err);
      setStatus("Error: " + err.message, false);
      
      const list = document.getElementById("wab-chat-messages");
      const loadingBubble = list?.querySelector(".wab-chat-bubble.loading");
      if (loadingBubble) loadingBubble.remove();

      appendMessageBubble("ai", `<p style="color:var(--wab-danger)">Error: ${escapeHtml(err.message)}</p>`);
    }
  }

  function appendMessageBubble(role, htmlContent) {
    const list = document.getElementById("wab-chat-messages");
    if (!list) return null;

    const bubble = document.createElement("div");
    bubble.className = `wab-chat-bubble ${role}`;
    bubble.innerHTML = htmlContent;
    list.appendChild(bubble);

    // Scroll to bottom
    list.scrollTop = list.scrollHeight;
    return bubble;
  }

  function appendLoadingBubble() {
    const html = `
      <span>Thinking</span>
      <span class="wab-dot-loader"></span>
      <span class="wab-dot-loader"></span>
      <span class="wab-dot-loader"></span>
    `;
    const bubble = appendMessageBubble("ai loading", html);
    return bubble;
  }

  // Soft budget for what we send to the model. ~4 chars/token means 200k
  // chars ≈ 50k tokens. Going over doesn't auto-truncate — it asks the USER
  // what to do (recent only / full anyway / cancel), because it's their
  // context window and their API bill.
  const AI_TRANSCRIPT_CHAR_LIMIT = 200000;

  function buildTranscriptLines(data) {
    return data.messages.map((m) => {
      const sender = m.fromMe ? "You" : m.senderName || m.author || "Contact";
      const time = m.time ? new Date(m.time).toLocaleString() : "";
      let content = m.body || m.caption || `[${m.type}]`;
      if (m.quotedMsg) {
        const quotedSender = m.quotedMsg.senderName || m.quotedMsg.participant || "Someone";
        const quotedBody = m.quotedMsg.body || m.quotedMsg.caption || `[${m.quotedMsg.type}]`;
        content = `(Replying to ${quotedSender}: "${quotedBody.slice(0, 50)}") ${content}`;
      }
      return `[${time}] ${sender}: ${content}`;
    });
  }

  // Shows an inline choice bubble and resolves with "recent" | "full" | "cancel".
  // Hides any "Thinking…" loader while waiting so the UI isn't misleading.
  function askTruncationChoice(droppedCount, keptCount, totalCount) {
    return new Promise((resolve) => {
      const loadingEl = document.querySelector("#wab-chat-messages .wab-chat-bubble.loading");
      if (loadingEl) loadingEl.style.display = "none";

      const bubble = document.createElement("div");
      bubble.className = "wab-chat-bubble ai";
      bubble.innerHTML =
        `<p><strong>This chat is large.</strong> All ${totalCount} messages exceed the
         recommended context size for the model — sending everything may fail or cost more.</p>
        <div class="wab-bubble-actions" style="flex-wrap:wrap">
          <button class="wab-bubble-btn" data-choice="recent">Use recent ${keptCount} messages</button>
          <button class="wab-bubble-btn" data-choice="full">Send full anyway</button>
          <button class="wab-bubble-btn" data-choice="cancel">Cancel</button>
        </div>`;

      // Host the prompt wherever the user currently is: the welcome view
      // (Load step — messages list still hidden) or the conversation list.
      const welcome = document.getElementById("wab-chat-welcome");
      if (welcome && welcome.style.display !== "none") {
        welcome.appendChild(bubble);
      } else {
        const list = document.getElementById("wab-chat-messages");
        list.appendChild(bubble);
        list.scrollTop = list.scrollHeight;
      }

      const done = (choice) => {
        bubble.remove();
        if (loadingEl) loadingEl.style.display = "";
        resolve(choice);
      };
      bubble.querySelectorAll("[data-choice]").forEach((b) =>
        b.addEventListener("click", () => done(b.getAttribute("data-choice")))
      );
    });
  }

  // Builds the transcript. If it's over budget, asks the user how to proceed.
  // Throws on cancel (caller's catch shows it in the status line).
  async function prepareTranscript(data) {
    const lines = buildTranscriptLines(data);
    const totalLen = lines.reduce((sum, l) => sum + l.length + 1, 0);
    if (totalLen <= AI_TRANSCRIPT_CHAR_LIMIT) return lines.join("\n");

    // Work out how many of the newest messages fit the budget.
    let total = 0;
    let firstKept = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      total += lines[i].length + 1;
      if (total > AI_TRANSCRIPT_CHAR_LIMIT) break;
      firstKept = i;
    }
    const dropped = firstKept;
    const keptCount = lines.length - firstKept;

    setStatus("Waiting for your choice…", false);
    const choice = await askTruncationChoice(dropped, keptCount, lines.length);

    if (choice === "cancel")
      throw new Error("Cancelled. Narrow the date range in ⚙️ settings and try again.");
    if (choice === "full") return lines.join("\n");

    const kept = lines.slice(firstKept);
    const note =
      `[NOTE: At the user's request this transcript contains only the most recent ` +
      `${keptCount} messages; the oldest ${dropped} were omitted. If asked about older ` +
      `history, say it isn't included and suggest narrowing the export date range.]\n\n`;
    return note + kept.join("\n");
  }

  async function callGeminiChatAPI(key, model, contents) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Key goes in a header, not the URL — keeps it out of request logs.
        "x-goog-api-key": key,
      },
      body: JSON.stringify({ contents })
    });

    if (!response.ok) {
      let errText = "";
      try {
        const errJson = await response.json();
        errText = errJson.error?.message || response.statusText;
      } catch (e) {
        errText = response.statusText;
      }
      // Token/context overflows get a hint the user can actually act on.
      if (/token|context|too (?:long|large)|exceeds/i.test(errText)) {
        errText += " — try narrowing the export date range (⚙️ settings) to shrink the transcript.";
      }
      throw new Error(`Gemini API: ${errText}`);
    }

    const resJson = await response.json();
    const text = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error("No response content from Gemini");
    }
    return text;
  }

  function parseMarkdownToHtml(md) {
    let html = escapeHtml(md);

    // Convert headers: ### Title, ## Title, # Title
    html = html.replace(/^### (.*?)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.*?)$/gm, "<h2>$1</h2>");
    html = html.replace(/^# (.*?)$/gm, "<h1>$1</h1>");

    // Convert bold: **text**
    html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");

    // Convert lists: * item or - item
    html = html.replace(/^[*-] (.*?)$/gm, "<li>$1</li>");

    // Convert paragraphs
    html = html.split("\n").map(line => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("<h") || trimmed.startsWith("<li")) return line;
      return `<p>${line}</p>`;
    }).join("\n");

    // Wrap consecutive <li> runs in a <ul> — bare <li> is invalid HTML and
    // renders with inconsistent bullets/indentation.
    html = html.replace(/(?:<li>.*<\/li>\n?)+/g, (run) => `<ul>${run}</ul>`);

    return html;
  }

  // --- Agent Mode Logic -------------------------------------------------------

  // Tools that require per-chat permission (they read message content).
  const PERMISSION_TOOLS = new Set([
    "getMessages", "searchMessages", "downloadMedia", "exportChat", "exportActiveChat"
  ]);

  // Switch between Local and Agent mode views.
  function switchMode(mode) {
    currentMode = mode;
    const sidebar = document.getElementById("wa-backup-sidebar");
    if (!sidebar) return;

    // Local mode containers
    const localContent = sidebar.querySelector(".wab-sidebar-content:not(#wab-agent-container)");
    const localStatus = document.getElementById("wab-status");
    const localInput = document.getElementById("wab-chat-input-bar");
    const settingsBtn = document.getElementById("wab-settings-toggle");

    // Agent mode containers
    const agentContainer = document.getElementById("wab-agent-container");
    const agentStatus = document.getElementById("wab-agent-status");
    const agentInput = document.getElementById("wab-agent-input-bar");

    // Header dot: swap between accent dot and connection dot
    const titleDot = document.getElementById("wab-title-dot");

    if (mode === "agent") {
      // Hide local, show agent
      if (localContent) localContent.style.display = "none";
      if (localStatus) localStatus.style.display = "none";
      if (localInput) localInput.style.display = "none";
      if (settingsBtn) settingsBtn.style.display = "none";
      if (agentContainer) agentContainer.style.display = "flex";
      if (agentInput) agentInput.classList.remove("hidden");
      if (titleDot) {
        titleDot.className = "wab-conn-dot connecting";
      }
      // Connect to backend
      ensureAgentClient();
    } else {
      // Hide agent, show local
      if (agentContainer) agentContainer.style.display = "none";
      if (agentStatus) agentStatus.textContent = "";
      if (agentInput) agentInput.classList.add("hidden");
      if (localContent) localContent.style.display = "flex";
      if (localStatus) localStatus.style.display = "";
      if (localInput) localInput.style.display = "";
      if (settingsBtn) settingsBtn.style.display = "";
      if (titleDot) {
        titleDot.className = "wab-accent-dot";
      }
      // Don't disconnect — keep alive so switching back is instant
    }
  }

  function ensureAgentClient() {
    if (!agentClient) {
      agentClient = new AgentClient("ws://127.0.0.1:8787/ws");
    }
    if (!agentClient.isConnected()) {
      agentClient.connect();
    }
  }

  // --- Permission Gate --------------------------------------------------------

  // Load persisted permission grants. Returns { [chatId]: "always" }.
  async function loadGrants() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["chatGrants"], (res) => {
        resolve(res.chatGrants || {});
      });
    });
  }

  async function saveGrant(chatId, grant) {
    const grants = await loadGrants();
    grants[chatId] = grant;
    return new Promise((resolve) => {
      chrome.storage.local.set({ chatGrants: grants }, resolve);
    });
  }

  // Prompt the user for permission. Returns "allow_once" | "always" | "deny".
  // Renders an inline bubble in the agent messages area. Resolves on click
  // or after a 2-minute timeout (→ deny).
  function askPermission(chatName, chatId) {
    return new Promise((resolve) => {
      const list = document.getElementById("wab-agent-messages");
      if (!list) { resolve("deny"); return; }

      const bubble = document.createElement("div");
      bubble.className = "wab-permission-bubble";
      bubble.innerHTML = `
        <div class="wab-perm-text">
          <span class="wab-perm-icon">🔒</span>
          Agent wants to read <span class="wab-perm-chat-name">「${escapeHtml(chatName || chatId)}」</span>
        </div>
        <div class="wab-perm-actions">
          <button class="wab-perm-btn allow" data-choice="allow_once">Allow once</button>
          <button class="wab-perm-btn allow" data-choice="always">Always allow</button>
          <button class="wab-perm-btn deny" data-choice="deny">Deny</button>
        </div>
      `;
      list.appendChild(bubble);
      list.scrollTop = list.scrollHeight;

      let resolved = false;
      const done = (choice) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        bubble.remove();
        resolve(choice);
      };
      bubble.querySelectorAll("[data-choice]").forEach((btn) =>
        btn.addEventListener("click", () => done(btn.getAttribute("data-choice")))
      );
      const timer = setTimeout(() => done("deny"), 120000); // 2 min timeout
    });
  }

  // Check permission for a tool call. Returns true if allowed, false if denied.
  // For "always" grants, no prompt is shown.
  async function checkPermission(toolName, args) {
    if (!PERMISSION_TOOLS.has(toolName)) return true; // no permission needed

    const chatId = args.chatId || args.chat_id;
    if (!chatId) return true; // no chat context → allow (e.g. activeChat)

    const grants = await loadGrants();
    if (grants[chatId] === "always") return true;

    // Need to resolve chat name for the prompt. Try to find it via listChats cache
    // or just use the chatId.
    let chatName = chatId;
    try {
      const chats = await callInject("listChats", {});
      const match = chats.find((c) => c.id === chatId);
      if (match) chatName = match.name;
    } catch (e) { /* use chatId as fallback */ }

    const choice = await askPermission(chatName, chatId);
    if (choice === "always") {
      await saveGrant(chatId, "always");
      return true;
    }
    if (choice === "allow_once") return true;
    return false; // deny
  }

  // --- Tool Executor ----------------------------------------------------------

  // Execute a tool call from the backend agent. Dispatches to callInject() for
  // WA-JS tools, handles exportChat locally.
  async function executeToolCall(name, args) {
    // Permission check first
    const allowed = await checkPermission(name, args);
    if (!allowed) {
      return { denied: true, error: `User denied access to chat ${args.chatId || args.chat_id || ""}` };
    }

    // Map agent tool names to inject.js action names
    // The backend sends tool names like "list_chats" but inject.js expects "listChats"
    const actionMap = {
      list_chats: "listChats",
      get_messages: "getMessages",
      search_messages: "searchMessages",
      download_media: "downloadMedia",
      get_active_chat: "activeChat",
      export_chat: "exportChat",
      // Direct names also work (in case backend sends camelCase)
      listChats: "listChats",
      getMessages: "getMessages",
      searchMessages: "searchMessages",
      downloadMedia: "downloadMedia",
      activeChat: "activeChat",
      exportChat: "exportChat",
    };

    const action = actionMap[name];
    if (!action) {
      throw new Error(`Unknown tool: ${name}`);
    }

    // exportChat is handled locally using existing exporter
    if (action === "exportChat") {
      return await handleExportChat(args);
    }

    // Map snake_case args to camelCase for inject.js
    const mappedArgs = {};
    for (const [key, value] of Object.entries(args || {})) {
      const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      mappedArgs[camelKey] = value;
    }

    return await callInject(action, mappedArgs);
  }

  // Export a chat using the existing renderHtml/renderCsv/download machinery.
  async function handleExportChat(args) {
    const { chat_id, chatId, format = "html" } = args;
    const cid = chat_id || chatId;
    if (!cid) throw new Error("chatId required for export");

    // Fetch all messages from the chat
    const data = await callInject("getMessages", { chatId: cid, limit: 200 });
    if (!data || !data.messages || data.messages.length === 0) {
      return { success: false, error: "No messages found" };
    }

    // Build an export-compatible data object
    const exportData = {
      exportedAt: new Date().toISOString(),
      chat: data.chat,
      range: { startTs: null, endTs: null },
      totalInChat: data.totalInChat,
      messageCount: data.messages.length,
      messages: data.messages,
    };

    const base = safeName(exportData.chat.name) + "_" + stamp();
    const fmt = String(format).toLowerCase();
    if (fmt === "json") {
      download(base + ".json", JSON.stringify(exportData, null, 2), "application/json");
    } else if (fmt === "csv") {
      download(base + ".csv", renderCsv(exportData), "text/csv");
    } else {
      download(base + ".html", renderHtml(exportData), "text/html");
    }
    return { success: true, format: fmt, messageCount: exportData.messageCount };
  }

  // --- AgentClient (WebSocket) ------------------------------------------------

  class AgentClient {
    constructor(url) {
      this.url = url;
      this.ws = null;
      this._reconnectTimer = null;
      this._reconnectDelay = 1000;
      this._maxReconnectDelay = 15000;
      this._pendingToolCalls = new Map(); // id -> resolve/reject
    }

    connect() {
      if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
        return;
      }
      this._updateConnectionDot("connecting");
      try {
        this.ws = new WebSocket(this.url);
      } catch (e) {
        console.error(TAG, "WebSocket construction error:", e);
        this._updateConnectionDot("disconnected");
        this._scheduleReconnect();
        return;
      }

      this.ws.onopen = () => {
        console.log(TAG, "Agent WebSocket connected");
        this._updateConnectionDot("connected");
        this._reconnectDelay = 1000; // reset backoff
      };

      this.ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          this._handleMessage(msg);
        } catch (e) {
          console.error(TAG, "Agent WS parse error:", e);
        }
      };

      this.ws.onclose = (ev) => {
        console.log(TAG, "Agent WebSocket closed:", ev.code, ev.reason);
        this._updateConnectionDot("disconnected");
        // Reject any pending tool call futures
        for (const [id, { reject }] of this._pendingToolCalls) {
          reject(new Error("WebSocket disconnected"));
        }
        this._pendingToolCalls.clear();
        if (currentMode === "agent") this._scheduleReconnect();
      };

      this.ws.onerror = (ev) => {
        console.error(TAG, "Agent WebSocket error:", ev);
      };
    }

    disconnect() {
      clearTimeout(this._reconnectTimer);
      if (this.ws) {
        this.ws.onclose = null; // prevent reconnect
        this.ws.close();
        this.ws = null;
      }
      this._updateConnectionDot("disconnected");
    }

    isConnected() {
      return this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    send(obj) {
      if (!this.isConnected()) {
        console.warn(TAG, "Agent WS not connected, cannot send");
        return false;
      }
      this.ws.send(JSON.stringify(obj));
      return true;
    }

    sendUserMessage(text) {
      return this.send({ type: "user_message", text });
    }

    _scheduleReconnect() {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = setTimeout(() => {
        console.log(TAG, `Agent WS reconnecting (delay: ${this._reconnectDelay}ms)...`);
        this.connect();
      }, this._reconnectDelay);
      this._reconnectDelay = Math.min(this._reconnectDelay * 1.5, this._maxReconnectDelay);
    }

    _updateConnectionDot(state) {
      const dot = document.getElementById("wab-title-dot");
      if (!dot || currentMode !== "agent") return;
      dot.className = "wab-conn-dot " + state;
    }

    async _handleMessage(msg) {
      switch (msg.type) {
        case "assistant_message":
          // Final response from the agent — render as AI bubble
          this._removeLoadingBubble();
          this._setAgentStatus("");
          appendAgentBubble("ai", parseMarkdownToHtml(msg.text));
          break;

        case "assistant_delta":
          // Streaming text token — append to current streaming bubble
          this._appendDelta(msg.text);
          break;

        case "agent_status":
          // Status update (e.g. "searching Investing 101…")
          this._setAgentStatus(msg.text);
          break;

        case "tool_call":
          // Agent wants to execute a tool via the extension
          await this._handleToolCall(msg);
          break;

        default:
          console.warn(TAG, "Unknown agent message type:", msg.type);
      }
    }

    async _handleToolCall(msg) {
      const { id, name, args } = msg;
      this._setAgentStatus(`Using ${name}...`);
      try {
        const result = await executeToolCall(name, args);
        this.send({ type: "tool_result", id, ok: true, result });
      } catch (err) {
        console.error(TAG, `Tool ${name} error:`, err);
        this.send({ type: "tool_result", id, ok: false, error: String(err.message || err) });
      }
    }

    _setAgentStatus(text) {
      const el = document.getElementById("wab-agent-status");
      if (!el) return;
      if (text) {
        el.innerHTML = `<span class="wab-status-spinner"></span> ${escapeHtml(text)}`;
      } else {
        el.textContent = "";
      }
    }

    _removeLoadingBubble() {
      const list = document.getElementById("wab-agent-messages");
      if (!list) return;
      const loading = list.querySelector(".wab-chat-bubble.loading");
      if (loading) loading.remove();
    }

    // Streaming delta support: append tokens to an accumulation bubble.
    _streamBubble = null;
    _streamText = "";

    _appendDelta(text) {
      if (!text) return;
      const list = document.getElementById("wab-agent-messages");
      if (!list) return;

      this._removeLoadingBubble();
      this._streamText += text;

      if (!this._streamBubble || !this._streamBubble.parentNode) {
        this._streamBubble = document.createElement("div");
        this._streamBubble.className = "wab-chat-bubble ai streaming";
        list.appendChild(this._streamBubble);
      }
      this._streamBubble.innerHTML = parseMarkdownToHtml(this._streamText);
      list.scrollTop = list.scrollHeight;
    }

    // Call when the final message arrives to finalize stream
    _finalizeStream() {
      if (this._streamBubble) {
        this._streamBubble.classList.remove("streaming");
        this._streamBubble = null;
        this._streamText = "";
      }
    }
  }

  // --- Agent Chat UI Helpers --------------------------------------------------

  function appendAgentBubble(role, htmlContent) {
    const list = document.getElementById("wab-agent-messages");
    if (!list) return null;

    // If we have a streaming bubble, finalize it (the final message replaces it)
    if (agentClient && agentClient._streamBubble) {
      agentClient._streamBubble.remove();
      agentClient._streamBubble = null;
      agentClient._streamText = "";
    }

    const bubble = document.createElement("div");
    bubble.className = `wab-chat-bubble ${role}`;
    bubble.innerHTML = htmlContent;
    list.appendChild(bubble);
    list.scrollTop = list.scrollHeight;
    return bubble;
  }

  function appendAgentLoadingBubble() {
    const list = document.getElementById("wab-agent-messages");
    if (!list) return null;
    const bubble = document.createElement("div");
    bubble.className = "wab-chat-bubble ai loading";
    bubble.innerHTML = `
      <span>Thinking</span>
      <span class="wab-dot-loader"></span>
      <span class="wab-dot-loader"></span>
      <span class="wab-dot-loader"></span>
    `;
    list.appendChild(bubble);
    list.scrollTop = list.scrollHeight;
    return bubble;
  }

  async function onAgentQuerySubmit(query) {
    if (!agentClient || !agentClient.isConnected()) {
      ensureAgentClient();
      // Wait briefly for connection
      await new Promise((r) => setTimeout(r, 500));
      if (!agentClient || !agentClient.isConnected()) {
        appendAgentBubble("ai", `<p style="color:var(--wab-danger)">Not connected to agent backend. Make sure the server is running at ws://127.0.0.1:8787</p>`);
        return;
      }
    }

    // Hide welcome, show messages
    const welcome = document.getElementById("wab-agent-welcome");
    const messages = document.getElementById("wab-agent-messages");
    if (welcome) welcome.style.display = "none";
    if (messages) messages.classList.remove("hidden");

    // Show user bubble
    appendAgentBubble("user", `<p>${escapeHtml(query)}</p>`);
    appendAgentLoadingBubble();

    // Send to backend
    const sent = agentClient.sendUserMessage(query);
    if (!sent) {
      const list = document.getElementById("wab-agent-messages");
      const loading = list?.querySelector(".wab-chat-bubble.loading");
      if (loading) loading.remove();
      appendAgentBubble("ai", `<p style="color:var(--wab-danger)">Failed to send message. Check connection.</p>`);
    }
  }


  // WhatsApp is a single-page app; the body persists, so add the button once
  // the page is interactive and keep it alive if React re-renders.
  makeButton();
  setInterval(makeButton, 3000);
  console.log(TAG, "loaded");
})();

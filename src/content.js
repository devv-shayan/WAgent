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

  // --- Icons (Lucide) -------------------------------------------------------
  // Inlined Lucide SVG paths (the same set lucide-react wraps). Vanilla-JS
  // friendly: no build step, and stroke="currentColor" makes them theme-aware.
  const ICONS = {
    settings:
      '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    send: '<path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9Z"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    "message-square":
      '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
    "triangle-alert":
      '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  };

  function icon(name, size = 20) {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
      `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
      `stroke-linecap="round" stroke-linejoin="round" class="wab-svg-icon" aria-hidden="true">` +
      `${ICONS[name] || ""}</svg>`
    );
  }

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
    const logoUrl = chrome.runtime.getURL("assets/icon-32.png");
    btn.innerHTML = `<img src="${logoUrl}" alt="" width="20" height="20" class="wab-fab-logo"> WAgent`;
    btn.addEventListener("click", togglePanel);
    document.body.appendChild(btn);
  }

  let currentMode = 'local'; // 'local' (Manual/export) | 'agent'
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
          <img src="${chrome.runtime.getURL("assets/logo.svg")}" alt="WAgent" width="22" height="22" class="wab-title-logo">
          <span id="wab-title-dot" class="wab-title-status-dot"></span>
          WAgent
        </div>
        <div class="wab-sidebar-actions">
          <div class="wab-mode-toggle">
            <button class="wab-mode-btn active" data-mode="local">Manual</button>
            <button class="wab-mode-btn" data-mode="agent">Agent</button>
          </div>
          <button class="wab-icon-btn" id="wab-agent-settings-toggle" title="Agent settings" style="display:none">${icon("settings", 18)}</button>
          <button class="wab-icon-btn" id="wab-sidebar-close" title="Close Panel">${icon("x", 18)}</button>
        </div>
      </div>

      <!-- ======= Manual Mode: export only ======= -->
      <div class="wab-sidebar-content">
        <div class="wab-chat-container">
          <div id="wab-chat-welcome" class="wab-welcome-state">
            <div class="wab-welcome-icon">${icon("download", 40)}</div>
            <h3>Export chat</h3>
            <p>Pick a date range and one or more formats, then export this chat to a file.</p>

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
              
              <div class="wab-formats">
                <label><input type="checkbox" id="wab-fmt-json" checked> JSON</label>
                <label><input type="checkbox" id="wab-fmt-html" checked> HTML</label>
                <label><input type="checkbox" id="wab-fmt-csv"> CSV</label>
              </div>
              <button id="wab-go">Export</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Export status line -->
      <div class="wab-status" id="wab-status"></div>

      <!-- ======= Agent Mode Views (hidden by default) ======= -->
      <div id="wab-agent-container" class="wab-sidebar-content" style="display:none;">
        <div id="wab-agent-settings" class="wab-agent-settings collapsed">
          <div class="wab-sub-title">API key</div>
          <input type="password" id="wab-agent-key" placeholder="Your API key (not needed for local models)">
          <div class="wab-sub-title">Model</div>
          <select id="wab-agent-model">
            <option value="">Backend default (.env)</option>
            <optgroup label="Gemini (cloud)">
              <option value="gemini/gemini-3.5-flash">Gemini 3.5 Flash (Recommended)</option>
              <option value="gemini/gemini-3.5-pro">Gemini 3.5 Pro</option>
              <option value="gemini/gemini-3.1-pro">Gemini 3.1 Pro (Reasoning)</option>
              <option value="gemini/gemini-3.1-flash-lite">Gemini 3.1 Flash-Lite</option>
              <option value="gemini/gemini-2.5-flash">Gemini 2.5 Flash</option>
              <option value="gemini/gemini-2.5-pro">Gemini 2.5 Pro</option>
            </optgroup>
            <optgroup label="Local (Ollama)">
              <option value="ollama/llama3.1">Llama 3.1</option>
              <option value="ollama/gemma4:e4b">Gemma 4</option>
            </optgroup>
          </select>
          <input type="text" id="wab-agent-model-custom" placeholder="Custom model (optional), e.g. ollama/qwen3">
          <div class="wab-hint">Web settings override .env. Leave everything blank to use the backend's .env.</div>
        </div>
        <div class="wab-chat-container">
          <div id="wab-agent-welcome" class="wab-agent-welcome">
            <div class="wab-welcome-icon"><img src="${chrome.runtime.getURL("assets/icon-128.png")}" alt="WAgent" width="48" height="48" class="wab-welcome-logo"></div>
            <h3>Agent mode</h3>
            <p>Ask me anything about your chats. I'll search and fetch what's needed.</p>
            <div id="wab-agent-conn-banner" class="wab-conn-banner hidden"></div>
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
        <button id="wab-agent-send" title="Send">${icon("send")}</button>
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

    // Mode toggle (Manual / Agent)
    sidebar.querySelectorAll(".wab-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-mode");
        if (mode === currentMode) return;
        sidebar.querySelectorAll(".wab-mode-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        switchMode(mode);
        chrome.storage.local.set({ lastMode: mode });
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

    // Wire up the exporter (Manual mode = export only)
    document.getElementById("wab-go").addEventListener("click", onExportClick);

    // Range presets for export
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

    // Agent settings panel: gear toggles it; fields persist to storage and are
    // sent with each agent message (web overrides .env).
    document.getElementById("wab-agent-settings-toggle")?.addEventListener("click", () => {
      document.getElementById("wab-agent-settings")?.classList.toggle("collapsed");
    });
    const agentKeyEl = document.getElementById("wab-agent-key");
    const agentModelEl = document.getElementById("wab-agent-model");
    const agentModelCustomEl = document.getElementById("wab-agent-model-custom");
    agentKeyEl?.addEventListener("input", (e) => chrome.storage.local.set({ agentKey: e.target.value }));
    agentModelEl?.addEventListener("change", (e) => chrome.storage.local.set({ agentModel: e.target.value }));
    agentModelCustomEl?.addEventListener("input", (e) => chrome.storage.local.set({ agentModelCustom: e.target.value }));

    // Restore agent settings, then land in the last-used mode. Agent-first:
    // first-ever open defaults to Agent (the point of the product); a user who
    // prefers Manual export keeps landing there after one toggle.
    chrome.storage.local.get(["lastMode", "agentKey", "agentModel", "agentModelCustom"], (res) => {
      if (agentKeyEl && res.agentKey) agentKeyEl.value = res.agentKey;
      if (agentModelEl && res.agentModel) agentModelEl.value = res.agentModel;
      if (agentModelCustomEl && res.agentModelCustom) agentModelCustomEl.value = res.agentModelCustom;

      const startMode = res.lastMode === "local" ? "local" : "agent";
      if (startMode !== currentMode) {
        const targetBtn = sidebar.querySelector(`.wab-mode-btn[data-mode="${startMode}"]`);
        const otherBtn = sidebar.querySelector(
          `.wab-mode-btn[data-mode="${startMode === "agent" ? "local" : "agent"}"]`
        );
        if (targetBtn && otherBtn) {
          otherBtn.classList.remove("active");
          targetBtn.classList.add("active");
        }
        switchMode(startMode);
      }
    });
  }

  function setStatus(text, busy) {
    const el = document.getElementById("wab-status");
    if (el) el.textContent = text;
    const go = document.getElementById("wab-go");
    if (go) go.disabled = !!busy;
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

      setStatus("Reading messages…", true);
      const data = await callInject("exportActiveChat", range);
      if (data.messageCount === 0)
        throw new Error(`No messages in that range (chat has ${data.totalInChat})`);

      const base = safeName(data.chat.name) + "_" + stamp();
      if (formats.json)
        download(base + ".json", JSON.stringify(data, null, 2), "application/json");
      if (formats.html) download(base + ".html", renderHtml(data), "text/html");
      if (formats.csv) download(base + ".csv", renderCsv(data), "text/csv");

      setStatus(`Exported ${data.messageCount} of ${data.totalInChat} messages`, false);
    } catch (err) {
      console.error(TAG, err);
      setStatus("Error: " + err.message, false);
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
    image: "Image", video: "Video", sticker: "Sticker",
    document: "Document", ptt: "Voice note", audio: "Audio",
    vcard: "Contact card", location: "Location",
    gp2: "Group event", revoked: "Deleted message",
    e2e_notification: "Encryption notice",
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

  // Switch between Manual (export) and Agent mode views.
  function switchMode(mode) {
    currentMode = mode;
    const sidebar = document.getElementById("wa-backup-sidebar");
    if (!sidebar) return;

    // Manual (export) containers
    const localContent = sidebar.querySelector(".wab-sidebar-content:not(#wab-agent-container)");
    const localStatus = document.getElementById("wab-status");

    // Agent mode containers
    const agentContainer = document.getElementById("wab-agent-container");
    const agentStatus = document.getElementById("wab-agent-status");
    const agentInput = document.getElementById("wab-agent-input-bar");
    const agentSettingsBtn = document.getElementById("wab-agent-settings-toggle");

    // Header dot: swap between accent dot and connection dot
    const titleDot = document.getElementById("wab-title-dot");

    if (mode === "agent") {
      // Hide manual, show agent
      if (localContent) localContent.style.display = "none";
      if (localStatus) localStatus.style.display = "none";
      if (agentContainer) agentContainer.style.display = "flex";
      if (agentInput) agentInput.classList.remove("hidden");
      if (agentSettingsBtn) agentSettingsBtn.style.display = "";
      if (titleDot) {
        titleDot.className = "wab-conn-dot connecting";
      }
      // Connect to backend
      ensureAgentClient();
    } else {
      // Hide agent, show manual
      if (agentContainer) agentContainer.style.display = "none";
      if (agentStatus) agentStatus.textContent = "";
      if (agentInput) agentInput.classList.add("hidden");
      if (agentSettingsBtn) agentSettingsBtn.style.display = "none";
      // collapse the settings panel so it isn't open next time
      document.getElementById("wab-agent-settings")?.classList.add("collapsed");
      if (localContent) localContent.style.display = "flex";
      if (localStatus) localStatus.style.display = "";
      if (titleDot) {
        titleDot.className = "wab-title-status-dot";
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

  // First-run empty state for Agent mode: tell the user, in plain language,
  // whether the local backend is reachable and what to do if it isn't. Without
  // this, a missing backend is invisible until a query silently fails.
  function updateAgentConnBanner(state) {
    const banner = document.getElementById("wab-agent-conn-banner");
    if (!banner) return;
    if (state === "connected") {
      banner.classList.add("hidden");
      banner.innerHTML = "";
    } else if (state === "connecting") {
      banner.classList.remove("hidden");
      banner.innerHTML = `<span class="wab-status-spinner"></span> Connecting to the local backend…`;
    } else {
      // disconnected
      banner.classList.remove("hidden");
      banner.innerHTML =
        `<span class="wab-banner-icon">${icon("triangle-alert", 16)}</span>` +
        `<strong>Backend not detected.</strong> Start it with ` +
        `<code>uv run fastapi dev main.py</code> in the <code>backend</code> folder — ` +
        `it connects automatically once it's up. No backend? Switch to <strong>Manual</strong> ` +
        `mode above; it runs in your browser with your own API key, no server needed.`;
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
          <span class="wab-perm-icon">${icon("lock", 16)}</span>
          Agent wants to read <span class="wab-perm-chat-name">${escapeHtml(chatName || chatId)}</span>
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
      throw new Error("Unknown action");
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
      // Web-first model/key: custom text beats the dropdown; blank => backend
      // uses its .env defaults. For local (ollama/*) models no key is needed.
      const sel = document.getElementById("wab-agent-model")?.value || "";
      const custom = document.getElementById("wab-agent-model-custom")?.value?.trim() || "";
      const model = custom || sel || undefined;
      const apiKey = document.getElementById("wab-agent-key")?.value?.trim() || undefined;
      return this.send({ type: "user_message", text, model, apiKey });
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
      if (currentMode !== "agent") return;
      const dot = document.getElementById("wab-title-dot");
      if (dot) dot.className = "wab-conn-dot " + state;
      updateAgentConnBanner(state);
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
      const friendly = {
        list_chats: "Listing chats",
        get_messages: "Fetching messages",
        search_messages: "Searching messages",
        get_active_chat: "Checking active chat",
        transcribe_media: "Processing media",
        visit_url: "Reading webpage",
        export_chat: "Exporting chat",
        // camelCase variants (from inject.js action names)
        listChats: "Listing chats",
        getMessages: "Fetching messages",
        searchMessages: "Searching messages",
        downloadMedia: "Downloading media",
        activeChat: "Checking active chat",
        exportChat: "Exporting chat",
      }[name] || "Working";
      this._setAgentStatus(`${friendly}…`);
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

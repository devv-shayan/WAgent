/*
 * inject.js  —  runs in the PAGE's world (MAIN).
 *
 * This is the only place that can see WhatsApp's internal state. The vendored
 * WA-JS library (loaded just before this file) hooks WhatsApp's webpack modules
 * and exposes them as `window.WPP`. We use that to read chats/messages.
 *
 * We CANNOT call chrome.* APIs here (wrong world), so we only compute data and
 * hand it back to content.js over window.postMessage.
 */
(function () {
  "use strict";
  const TAG = "[WA-Backup:inject]";

  // --- request/response bridge with content.js ------------------------------
  window.addEventListener("message", async (ev) => {
    if (ev.source !== window) return;
    const req = ev.data;
    if (!req || req.__wabackup !== "request") return;

    const { id, action, payload } = req;
    try {
      const result = await handle(action, payload);
      reply(id, true, result);
    } catch (err) {
      console.error(TAG, action, err);
      reply(id, false, null, String((err && err.message) || err));
    }
  });

  function reply(id, ok, result, error) {
    window.postMessage({ __wabackup: "response", id, ok, result, error }, "*");
  }

  // --- actions --------------------------------------------------------------
  async function handle(action, payload) {
    switch (action) {
      case "ping":
        return { hasWPP: !!window.WPP, ready: isReady() };
      case "activeChat":
        return getActiveChat();
      case "exportActiveChat":
        return exportActiveChat(payload);
      // --- agent tools ---
      case "listChats":
        return listChats();
      case "getMessages":
        return getMessagesAction(payload);
      case "searchMessages":
        return searchMessagesAction(payload);
      case "downloadMedia":
        return downloadMediaAction(payload);
      default:
        throw new Error("unknown action");
    }
  }

  function isReady() {
    return !!(window.WPP && window.WPP.isReady);
  }

  async function waitReady(timeoutMs = 60000) {
    if (isReady()) return;
    if (!window.WPP) throw new Error("WA-JS not loaded (window.WPP missing)");
    await new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("timed out waiting for WhatsApp to be ready")),
        timeoutMs
      );
      window.WPP.on("ready", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  function getActiveChat() {
    const chat = window.WPP?.chat?.getActiveChat?.();
    if (!chat) return null;
    return { id: chat.id?._serialized, name: chatTitle(chat) };
  }

  function chatTitle(chat) {
    return (
      chat.formattedTitle ||
      chat.name ||
      chat.contact?.pushname ||
      chat.contact?.formattedName ||
      chat.id?.user ||
      chat.id?._serialized ||
      "chat"
    );
  }

  // count: -1  => load the full history (WA-JS scrolls it back for us).
  // Shared by export + all agent read tools.
  async function loadAllMessages(chatId) {
    return await window.WPP.chat.getMessages(chatId, { count: -1 });
  }

  // Build a participant ID → display name lookup from ALL loaded messages.
  // Regular messages reliably carry senderObj with pushname/formattedName,
  // but quoted message objects almost never do — so quoted senders are
  // resolved against this map instead.
  function buildNameMap(all) {
    const myJid = window.WPP?.conn?.getMyUserId?.()?._serialized;
    const myLid = window.WPP?.conn?.getMyUserLid?.()?._serialized;
    const nameMap = new Map();
    if (myJid) nameMap.set(myJid, "You");
    if (myLid) nameMap.set(myLid, "You");
    for (const m of all) {
      const senderJid = getMsgSenderJid(m, myJid);
      const name = m.senderObj?.pushname || m.senderObj?.formattedName;
      if (senderJid && name && !nameMap.has(senderJid)) {
        nameMap.set(senderJid, name);
      }
    }
    return nameMap;
  }

  // For the messages being returned, resolve any quoted participants still
  // missing from nameMap via the WhatsApp contact store.
  async function resolveQuotedParticipants(messages, nameMap) {
    const missing = new Set();
    for (const m of messages) {
      const q = m.quotedMsg || m.quotedMsgObj;
      if (q || m.quotedStanzaID) {
        const participant = m.quotedParticipant?._serialized
          || m.quotedParticipant
          || q?.author?._serialized
          || q?.author
          || q?.from?._serialized
          || q?.from;
        if (participant && !nameMap.has(participant)) missing.add(participant);
      }
    }
    if (missing.size > 0 && window.WPP?.contact?.get) {
      try {
        await Promise.all(
          Array.from(missing).map(async (partId) => {
            try {
              const contact = await window.WPP.contact.get(partId);
              const name = contact?.name || contact?.pushname || contact?.formattedName;
              if (name) nameMap.set(partId, name);
            } catch (e) {
              // ignore per-contact resolution errors
            }
          })
        );
      } catch (e) {
        // ignore total resolution failure
      }
    }
  }

  // Pull the whole message history of the currently-open chat, optionally
  // filter it to a date range, and return plain JSON-serializable objects.
  //
  // payload: { startTs?: number, endTs?: number }  (unix SECONDS, inclusive)
  async function exportActiveChat(payload) {
    const { startTs = null, endTs = null } = payload || {};
    await waitReady();
    const chat = window.WPP?.chat?.getActiveChat?.();
    if (!chat) throw new Error("No chat is open. Open a chat first.");

    const chatId = chat.id._serialized;
    const all = await loadAllMessages(chatId);
    const messages = all.filter(
      (m) =>
        typeof m.t === "number" &&
        (startTs === null || m.t >= startTs) &&
        (endTs === null || m.t <= endTs)
    );
    const nameMap = buildNameMap(all);
    await resolveQuotedParticipants(messages, nameMap);

    return {
      exportedAt: new Date().toISOString(),
      chat: { id: chatId, name: chatTitle(chat) },
      range: { startTs, endTs },
      totalInChat: all.length,
      messageCount: messages.length,
      messages: messages.map((m) => serializeMessage(m, nameMap)),
    };
  }

  // --- agent tools ----------------------------------------------------------

  // Names + metadata only — never any message content. Safe to call without
  // a per-chat permission grant.
  async function listChats() {
    await waitReady();
    const chats = await window.WPP.chat.list();
    return chats.map((c) => ({
      id: c.id?._serialized ?? String(c.id),
      name: chatTitle(c),
      isGroup: !!c.isGroup,
      unreadCount: c.unreadCount ?? 0,
      lastMsgTs: c.t ?? c.lastReceivedKey?.t ?? null,
    }));
  }

  // Paginated message fetch. Loads full history then slices — returns the
  // most recent `limit` messages within the optional before/after window.
  async function getMessagesAction(payload) {
    const { chatId, limit = 50, beforeTs = null, afterTs = null } = payload || {};
    if (!chatId) throw new Error("chatId required");
    await waitReady();
    const all = await loadAllMessages(chatId);
    let msgs = all.filter(
      (m) =>
        typeof m.t === "number" &&
        (beforeTs === null || m.t < beforeTs) &&
        (afterTs === null || m.t > afterTs)
    );
    const capped = Math.min(Math.max(1, limit), 200);
    msgs = msgs.slice(-capped);
    const nameMap = buildNameMap(all);
    await resolveQuotedParticipants(msgs, nameMap);
    const chat = window.WPP?.chat?.get?.(chatId) || {};
    return {
      chat: { id: chatId, name: chatTitle(chat) },
      totalInChat: all.length,
      returned: msgs.length,
      messages: msgs.map((m) => serializeMessage(m, nameMap)),
    };
  }

  // Filter by text/sender/recency inside the MAIN world so only matching
  // messages cross the postMessage boundary (keeps the agent payload small).
  async function searchMessagesAction(payload) {
    const { chatId, query = "", sender = null, days = null, limit = 50 } = payload || {};
    if (!chatId) throw new Error("chatId required");
    await waitReady();
    const all = await loadAllMessages(chatId);
    const nameMap = buildNameMap(all);
    const myJid = window.WPP?.conn?.getMyUserId?.()?._serialized;
    const minTs = days ? Math.floor(Date.now() / 1000) - days * 86400 : null;
    const q = String(query).toLowerCase();
    const senderLc = sender ? String(sender).toLowerCase() : null;

    let hits = all.filter((m) => {
      if (typeof m.t !== "number") return false;
      if (minTs !== null && m.t < minTs) return false;
      // For media, body is a base64 thumbnail — search caption instead.
      const isMedia = MEDIA_TYPES.has(m.type);
      const text = (isMedia ? m.caption || "" : m.body || m.caption || "").toLowerCase();
      if (q && !text.includes(q)) return false;
      if (senderLc) {
        const sJid = getMsgSenderJid(m, myJid) || "";
        const sName = (
          nameMap.get(sJid) ||
          m.senderObj?.pushname ||
          m.senderObj?.formattedName ||
          ""
        ).toLowerCase();
        if (!sName.includes(senderLc) && !sJid.toLowerCase().includes(senderLc))
          return false;
      }
      return true;
    });
    const capped = Math.min(Math.max(1, limit), 200);
    hits = hits.slice(-capped);
    await resolveQuotedParticipants(hits, nameMap);
    const chat = window.WPP?.chat?.get?.(chatId) || {};
    return {
      chat: { id: chatId, name: chatTitle(chat) },
      matchCount: hits.length,
      messages: hits.map((m) => serializeMessage(m, nameMap)),
    };
  }

  // Decrypt + download a message's media, returned as base64 for the backend
  // (voice notes = type "ptt", audio/ogg opus; small enough to inline over WS).
  async function downloadMediaAction(payload) {
    const { chatId, messageId } = payload || {};
    if (!messageId) throw new Error("messageId required");
    await waitReady();

    let msg = null;
    if (window.WPP?.chat?.getMessageById) {
      try {
        msg = await window.WPP.chat.getMessageById(messageId);
      } catch (e) {
        /* fall through to scan */
      }
    }
    if (!msg && chatId) {
      const all = await loadAllMessages(chatId);
      msg = all.find((m) => (m.id?._serialized || m.id) === messageId);
    }
    if (!msg) throw new Error("message not found: " + messageId);

    // Hydrate chat reference if missing (crucial for some WPP.chat.downloadMedia paths)
    if (msg && !msg.chat && chatId) {
      try {
        msg.chat = window.WPP.chat.get(chatId);
      } catch (e) {
        // ignore hydration errors
      }
    }

    let blob = null;
    let lastError = null;

    // Try WPP.chat.downloadMedia with different parameter formats:
    // 1. Try passing the message model/object itself (works for videos if hydrated)
    try {
      blob = await window.WPP.chat.downloadMedia(msg);
    } catch (e) {
      lastError = e;
    }

    // 2. Try passing the message ID string directly (works for voice notes)
    if (!blob) {
      try {
        blob = await window.WPP.chat.downloadMedia(messageId);
      } catch (e) {
        lastError = e;
      }
    }

    // 3. Try passing the msg.id MsgKey object directly (alternative fallback)
    if (!blob && msg.id) {
      try {
        blob = await window.WPP.chat.downloadMedia(msg.id);
      } catch (e) {
        lastError = e;
      }
    }

    if (!blob) {
      throw new Error("Failed to download media: " + (lastError?.message || lastError));
    }

    const base64 = await blobToBase64(blob);
    return {
      messageId,
      type: msg.type ?? null,
      mimetype: msg.mimetype || blob.type || null,
      filename: msg.filename ?? null,
      durationSec: msg.duration ?? null,
      base64,
    };
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const res = String(reader.result); // data:<mime>;base64,XXXX
        const comma = res.indexOf(",");
        resolve(comma >= 0 ? res.slice(comma + 1) : res);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // Message types where WhatsApp stores a base64 JPEG *thumbnail* in `body`
  // instead of text. We must not treat that as message text.
  const MEDIA_TYPES = new Set(["image", "video", "sticker", "document"]);

  function getMsgSenderJid(m, myJid) {
    if (m.author) return m.author._serialized || m.author;
    if (m.id?.fromMe) return myJid || null;
    return m.from?._serialized || m.from || null;
  }

  function serializeMessage(m, nameMap) {
    const isMedia = MEDIA_TYPES.has(m.type);
    // Heuristic: base64 JPEG starts with /9j/ — only trust body-as-thumbnail
    // when the type says media AND the content looks like base64.
    const bodyIsThumb =
      isMedia && typeof m.body === "string" && /^[A-Za-z0-9+/=]{50,}$/.test(m.body);

    const myJid = window.WPP?.conn?.getMyUserId?.()?._serialized;
    const senderJid = getMsgSenderJid(m, myJid);

    return {
      id: m.id?._serialized ?? null,
      timestamp: m.t ?? null, // unix seconds
      time: m.t ? new Date(m.t * 1000).toISOString() : null,
      fromMe: !!m.id?.fromMe,
      author: senderJid,
      senderName: m.senderObj?.pushname || m.senderObj?.formattedName || null,
      type: m.type ?? null,
      // For media messages, body is the raw base64 thumbnail — move it to
      // its own field so renderers can display it as an image.
      body: bodyIsThumb ? null : (m.body ?? null),
      thumbnail: bodyIsThumb ? m.body : null,
      caption: m.caption ?? null,
      quotedMsg: serializeQuotedMsg(m, nameMap),
      hasMedia: !!(m.mediaData && m.mediaData.mediaStage !== "NONE"),
      mimetype: m.mimetype ?? null,
      filename: m.filename ?? null,
    };
  }

  // Extract the quoted/replied-to message info. WhatsApp stores this in
  // several places depending on version — we try them all.
  function serializeQuotedMsg(m, nameMap) {
    const q = m.quotedMsg || m.quotedMsgObj;
    const stanza = m.quotedStanzaID;
    if (!q && !stanza) return null;

    // Sender: quotedParticipant is the phone/lid of who sent the original
    const participant = m.quotedParticipant?._serialized
      || m.quotedParticipant
      || q?.author?._serialized
      || q?.author
      || q?.from?._serialized
      || q?.from
      || null;

    // Sender display name — try the quoted msg's own senderObj first,
    // but it's almost always empty. Fall back to our nameMap built from
    // all regular messages in the chat (where senderObj IS populated).
    const senderName = q?.senderObj?.pushname
      || q?.senderObj?.formattedName
      || (participant && nameMap.get(participant))
      || null;

    // Body: for media quoted messages the body is a thumbnail — same heuristic
    const qBody = q?.body ?? null;
    const qType = q?.type ?? null;
    const qIsMedia = qType && MEDIA_TYPES.has(qType);
    const qBodyIsThumb = qIsMedia && typeof qBody === "string"
      && /^[A-Za-z0-9+/=]{50,}$/.test(qBody);

    return {
      id: q?.id?._serialized || stanza || null,
      participant,
      senderName,
      type: qType,
      body: qBodyIsThumb ? null : qBody,
      caption: q?.caption ?? null,
    };
  }

  console.log(TAG, "loaded. WA-JS present:", !!window.WPP);
})();

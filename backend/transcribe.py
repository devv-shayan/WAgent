"""
Media transcription — local Ollama for images, Gemini for audio/video.

Flow:
  1. Check a local JSON cache (data/transcripts.json) keyed by message_id.
  2. If miss → ask the extension to download the media (base64).
  3. Decode and save the media file to data/media/<message_id>.<ext>.
  4. Describe/transcribe it:
     - Images: if MEDIA_MODEL is a local Ollama model (e.g. ollama_chat/gemma4:e2b),
       processed fully locally via Ollama's vision API — nothing leaves the machine.
     - Audio/video: always via cloud Gemini. Ollama's own API doesn't support
       audio/video input yet (as of this writing — see ollama/ollama#11798,
       #11243), even though Gemma 4's e2b/e4b variants can handle those
       modalities in principle. That's an Ollama API gap, not a model
       limitation, so this falls back to Gemini rather than pretending to be
       fully local.
  5. Clean up local and remote files.
  6. Cache the result and return it.
"""

from __future__ import annotations

import asyncio
import base64
import contextvars
import json
import logging
import os
from pathlib import Path
import time

import httpx
from google import genai

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Per-request media model override
# ---------------------------------------------------------------------------
# transcribe_media() is called several layers deep inside an Agents SDK tool
# call — there's no clean way to pass an extra parameter down through the
# LLM-driven tool-call chain. A contextvar carries the web UI's model choice
# down to here instead, scoped to the single agent run that set it (main.py's
# _run_agent sets this before each run; it doesn't leak across requests).
_media_model_override: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "media_model_override", default=None
)


def set_media_model_override(model: str | None) -> None:
    """Called once per agent run (see main.py) so image transcription follows
    whatever text model the web UI selected, when that model is local."""
    _media_model_override.set(model)


def _resolve_media_model() -> str:
    """Web UI override (if it's a local model) wins, same precedence as
    AGENT_MODEL already uses; otherwise falls back to .env's MEDIA_MODEL."""
    return _media_model_override.get() or os.getenv("MEDIA_MODEL", "gemini-2.5-flash")

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

DATA_DIR = Path(__file__).parent.parent / "data"
MEDIA_DIR = DATA_DIR / "media"
TRANSCRIPTS_FILE = DATA_DIR / "transcripts.json"


def _ensure_dirs() -> None:
    """Create data directories if they don't exist."""
    DATA_DIR.mkdir(exist_ok=True)
    MEDIA_DIR.mkdir(exist_ok=True)


# ---------------------------------------------------------------------------
# Cache helpers
# ---------------------------------------------------------------------------


def is_ollama_model(model_name: str) -> bool:
    """True if a model string (as used in AGENT_MODEL/MEDIA_MODEL) points at
    a local Ollama model rather than a cloud one."""
    return model_name.startswith("ollama_chat/") or model_name.startswith("ollama/")


def _load_cache() -> dict[str, str]:
    """Load the transcript cache from disk."""
    if TRANSCRIPTS_FILE.exists():
        try:
            return json.loads(TRANSCRIPTS_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            logger.warning("Corrupt transcripts cache — starting fresh")
    return {}


def _save_cache(cache: dict[str, str]) -> None:
    """Persist the transcript cache to disk."""
    _ensure_dirs()
    TRANSCRIPTS_FILE.write_text(
        json.dumps(cache, indent=2, ensure_ascii=False), encoding="utf-8"
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def transcribe_media(chat_id: str, message_id: str) -> str:
    """
    Download (if needed) and transcribe/describe a WhatsApp voice note or video.

    Returns the transcript or description text.
    Raises RuntimeError on failure.
    """
    try:
        _ensure_dirs()

        # 1. Check cache
        cache = _load_cache()
        if message_id in cache:
            logger.info("Transcript cache hit for %s", message_id)
            return cache[message_id]

        # 2. Download media from extension
        from bridge import bridge

        logger.info("Downloading media %s from chat %s", message_id, chat_id)
        await bridge.send_status("Downloading media…")

        media = await bridge.call_extension(
            "downloadMedia",
            {"chatId": chat_id, "messageId": message_id},
        )

        b64_data = media.get("base64") if isinstance(media, dict) else None
        if not b64_data:
            raise RuntimeError(
                f"Extension returned no media data for message {message_id}: {media}"
            )

        # Determine mimetype and file extension
        mimetype = media.get("mimetype", "")
        media_type = media.get("type", "")

        if not mimetype:
            if media_type == "video":
                mimetype = "video/mp4"
            elif media_type == "image":
                mimetype = "image/jpeg"
            else:
                mimetype = "audio/ogg"

        # Determine file extension based on mimetype
        ext = ".ogg"
        if "video" in mimetype:
            ext = ".mp4"
            if "3gpp" in mimetype:
                ext = ".3gp"
            elif "quicktime" in mimetype:
                ext = ".mov"
        elif "image" in mimetype:
            ext = ".jpg"
            if "png" in mimetype:
                ext = ".png"
            elif "webp" in mimetype:
                ext = ".webp"
            elif "gif" in mimetype:
                ext = ".gif"
        elif "mp4" in mimetype:
            ext = ".mp4"
        elif "wav" in mimetype:
            ext = ".wav"
        elif "mpeg" in mimetype:
            ext = ".mp3"

        # 3. Save to disk
        media_path = MEDIA_DIR / f"{message_id}{ext}"
        
        # Add padding if necessary
        padding = len(b64_data) % 4
        if padding > 0:
            b64_data += "=" * (4 - padding)
            
        media_bytes = base64.b64decode(b64_data)
        media_path.write_bytes(media_bytes)
        logger.info("Saved media to %s (%d bytes)", media_path, len(media_bytes))

        # 4. Transcribe/Describe
        # Pick a user-friendly status label based on media type
        is_image = "image" in mimetype or media_type == "image"
        if is_image:
            status_label = "Describing image…"
        elif "audio" in mimetype or media_type in ("ptt", "audio"):
            status_label = "Transcribing voice note…"
        elif "video" in mimetype or media_type == "video":
            status_label = "Processing video…"
        else:
            status_label = "Processing media…"
        await bridge.send_status(status_label)

        media_model = _resolve_media_model()
        gemini_key = os.getenv("GEMINI_API_KEY")
        # MEDIA_MODEL might resolve to a local Ollama string (e.g. someone set
        # MEDIA_MODEL=ollama_chat/gemma4:e2b in .env). That's never valid as a
        # Gemini API model name, so cloud calls always use a real Gemini model
        # name — the local string, else a sensible default.
        gemini_model_name = "gemini-2.5-flash" if is_ollama_model(media_model) else media_model
        transcript: str | None = None

        # Images can run fully local through Ollama when MEDIA_MODEL points
        # at a local model. Audio/video always need Gemini — see module
        # docstring for why.
        if is_image and is_ollama_model(media_model):
            try:
                transcript = await asyncio.to_thread(
                    _process_image_with_ollama, media_path, media_model
                )
                logger.info("Image described locally via Ollama (%s)", media_model)
            except Exception as e:
                logger.warning(
                    "Local Ollama image processing failed (%s) — falling back "
                    "to cloud Gemini.",
                    e,
                )
                if not gemini_key:
                    raise RuntimeError(
                        f"Local image description via Ollama failed ({e}), and "
                        "no GEMINI_API_KEY is set to fall back to. Check that "
                        "Ollama is running and the MEDIA_MODEL is pulled, or "
                        "set GEMINI_API_KEY in .env."
                    ) from e

        if transcript is None:
            if is_ollama_model(media_model) and not is_image:
                logger.info(
                    "MEDIA_MODEL is local (%s), but Ollama doesn't support "
                    "audio/video input yet — using cloud Gemini for this %s.",
                    media_model,
                    media_type or "file",
                )
            if not gemini_key:
                if is_ollama_model(media_model):
                    raise RuntimeError(
                        "This is a voice note or video. Ollama doesn't support "
                        "audio/video input yet (images work fully locally) — "
                        "set GEMINI_API_KEY in .env to transcribe this."
                    )
                raise RuntimeError("GEMINI_API_KEY is not set")

            # The Gemini SDK calls (upload, ACTIVE-status polling with
            # time.sleep, generate_content, delete) are fully synchronous and
            # can take ~60s for video. Run them in a worker thread so the
            # asyncio event loop — and thus the WebSocket bridge (status
            # updates, incoming frames) — stays responsive instead of
            # freezing for the whole transcription.
            transcript = await asyncio.to_thread(
                _process_media_with_gemini,
                media_path,
                mimetype,
                media_type,
                gemini_key,
                gemini_model_name,
            )

        # 5. Cache and return
        cache[message_id] = transcript
        _save_cache(cache)
        return transcript
    except Exception as e:
        logger.exception("Failed to process media %s: %s", message_id, e)
        raise
    finally:
        # Single owner of local-file cleanup, regardless of which path ran or
        # whether it succeeded — avoids double-delete / delete-before-fallback
        # bugs from having each processing function manage its own copy.
        try:
            if "media_path" in locals() and media_path.exists():
                media_path.unlink()
                logger.info("Deleted local media file: %s", media_path)
        except Exception as e:
            logger.warning("Failed to delete local file: %s", e)


def _process_media_with_gemini(
    media_path: Path, mimetype: str, media_type: str, api_key: str, media_model: str
) -> str:
    """
    Synchronous Gemini media processing: upload the file, wait until it's
    ACTIVE, transcribe/describe it, then clean up both the local file and the
    remote Gemini file. Blocking by design — call via asyncio.to_thread so its
    time.sleep polling and network calls don't stall the event loop.
    """
    client = genai.Client(api_key=api_key)
    gemini_file = None
    try:
        # Upload the media file
        with open(media_path, "rb") as f:
            gemini_file = client.files.upload(file=f, config={"mime_type": mimetype})

        # Wait for file to become ACTIVE (crucial for video processing)
        logger.info("Waiting for Gemini file %s to become ACTIVE...", gemini_file.name)
        start_time = time.time()
        timeout = 60  # Wait up to 60 seconds
        while True:
            status = client.files.get(name=gemini_file.name)
            state = str(status.state).upper()
            if "ACTIVE" in state:
                logger.info("File is ACTIVE after %.2f seconds", time.time() - start_time)
                break
            elif "FAILED" in state:
                raise RuntimeError(f"Gemini file processing failed: {status}")

            if time.time() - start_time > timeout:
                raise RuntimeError(f"Timed out waiting for file to become ACTIVE. State: {state}")

            time.sleep(1)

        # Request transcription/description
        if "audio" in mimetype or media_type in ("ptt", "audio"):
            prompt = "Transcribe this audio verbatim. Return only the transcription text, nothing else."
        elif "image" in mimetype or media_type == "image":
            prompt = "Describe this image in detail. If it contains text, transcribe the text verbatim."
        else:
            prompt = "Watch this video. Transcribe any spoken audio verbatim, and briefly describe any key visual action if relevant."

        response = client.models.generate_content(
            model=media_model,
            contents=[
                prompt,
                gemini_file,
            ],
        )

        transcript = (response.text or "").strip()
        if not transcript:
            raise RuntimeError("Gemini returned empty response")

        logger.info("Media processing complete (%d chars)", len(transcript))
        return transcript
    finally:
        # Local file cleanup is owned by transcribe_media()'s finally block
        # (it needs the file to still exist if this fails and a fallback
        # kicks in). Only the remote Gemini file is this function's to clean.
        if gemini_file:
            try:
                client.files.delete(name=gemini_file.name)
                logger.info("Deleted remote Gemini file: %s", gemini_file.name)
            except Exception as e:
                logger.warning("Failed to delete remote Gemini file %s: %s", gemini_file.name, e)


def _process_image_with_ollama(media_path: Path, model: str) -> str:
    """
    Describe an image fully locally via Ollama's vision API.

    Ollama's /api/generate 'images' field (base64-encoded) is the stable,
    documented way to send image input to a local multimodal model like
    gemma4:e2b. This is synchronous — call via asyncio.to_thread, same as
    the Gemini path.
    """
    ollama_base = os.getenv("OLLAMA_API_BASE", "http://localhost:11434")
    # Ollama's own API expects the bare model name ("gemma4:e2b"), not the
    # litellm-style "ollama_chat/gemma4:e2b" prefix used in .env.
    bare_model = model.split("/", 1)[1] if "/" in model else model

    b64_image = base64.b64encode(media_path.read_bytes()).decode("ascii")
    prompt = "Describe this image in detail. If it contains text, transcribe the text verbatim."

    response = httpx.post(
        f"{ollama_base}/api/generate",
        json={
            "model": bare_model,
            "prompt": prompt,
            "images": [b64_image],
            "stream": False,
        },
        timeout=120.0,
    )
    response.raise_for_status()
    data = response.json()
    transcript = (data.get("response") or "").strip()
    if not transcript:
        raise RuntimeError("Ollama returned an empty response")

    return transcript

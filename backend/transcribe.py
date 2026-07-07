"""
Media transcription using Gemini's native multimodal understanding.

Flow:
  1. Check a local JSON cache (data/transcripts.json) keyed by message_id.
  2. If miss → ask the extension to download the media (base64).
  3. Decode and save the media file to data/media/<message_id>.<ext>.
  4. Upload the file to Gemini, poll until it's ACTIVE, and request transcription/description.
  5. Clean up local and remote files.
  6. Cache the result and return it.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
from pathlib import Path
import time

from google import genai

logger = logging.getLogger(__name__)

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

        # 4. Transcribe/Describe with Gemini
        await bridge.send_status("Transcribing media…")

        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY is not set")

        # The Gemini SDK calls (upload, ACTIVE-status polling with time.sleep,
        # generate_content, delete) are fully synchronous and can take ~60s for
        # video. Run them in a worker thread so the asyncio event loop — and
        # thus the WebSocket bridge (status updates, incoming frames) — stays
        # responsive instead of freezing for the whole transcription.
        transcript = await asyncio.to_thread(
            _process_media_with_gemini, media_path, mimetype, media_type, api_key
        )

        # 5. Cache and return
        cache[message_id] = transcript
        _save_cache(cache)
        return transcript
    except Exception as e:
        logger.exception("Failed to process media %s: %s", message_id, e)
        raise


def _process_media_with_gemini(
    media_path: Path, mimetype: str, media_type: str, api_key: str
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

        media_model = os.getenv("MEDIA_MODEL", "gemini-2.5-flash")
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
        # Clean up local file
        if media_path.exists():
            try:
                media_path.unlink()
                logger.info("Deleted local media file: %s", media_path)
            except Exception as e:
                logger.warning("Failed to delete local file %s: %s", media_path, e)

        # Clean up Gemini file
        if gemini_file:
            try:
                client.files.delete(name=gemini_file.name)
                logger.info("Deleted remote Gemini file: %s", gemini_file.name)
            except Exception as e:
                logger.warning("Failed to delete remote Gemini file %s: %s", gemini_file.name, e)

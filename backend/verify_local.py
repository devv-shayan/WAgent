"""
Verify the local-model path end-to-end.

Runs a real completion through the SAME model string the agent uses
(AGENT_MODEL, via LiteLLM) and reports whether the text path stays local.

Usage:
    # 1. Install Ollama (https://ollama.com) and pull a model:
    ollama pull llama3.1
    # 2. Point the agent at it (in backend/.env):
    #    AGENT_MODEL=ollama/llama3.1
    # 3. Run this from backend/:
    uv run python verify_local.py

What it proves:
    - The configured AGENT_MODEL responds (text generation works).
    - Whether that model is a LOCAL provider (ollama) or a CLOUD provider.
    - Whether GEMINI_API_KEY is required for the text path.

What it does NOT cover:
    Media transcription (transcribe.py) uploads audio/video/images to
    Google Gemini and always requires GEMINI_API_KEY. There is no local
    fallback for media today, so "fully local" applies to TEXT only until
    a local transcription path exists.
"""

from __future__ import annotations

import os
import sys

import litellm
from dotenv import load_dotenv


def main() -> int:
    load_dotenv()

    model = os.getenv("AGENT_MODEL", "gemini/gemini-2.5-flash")
    provider = model.split("/", 1)[0] if "/" in model else "(unknown)"
    is_local = provider.lower() in {"ollama", "ollama_chat"}
    gemini_key_set = bool(os.getenv("GEMINI_API_KEY"))

    print(f"AGENT_MODEL       : {model}")
    print(f"Provider          : {provider}")
    print(f"Local text model? : {'YES' if is_local else 'NO (cloud)'}")
    print(f"GEMINI_API_KEY set: {'yes' if gemini_key_set else 'no'}")
    print("-" * 48)

    # Send a trivial prompt through the exact transport the agent uses.
    # For ollama, api_key is ignored; LiteLLM targets OLLAMA_API_BASE
    # (default http://localhost:11434).
    try:
        resp = litellm.completion(
            model=model,
            messages=[{"role": "user", "content": "Reply with the single word: LOCAL"}],
            api_key=None if is_local else os.getenv("GEMINI_API_KEY"),
        )
    except Exception as e:  # noqa: BLE001 - surface the real cause to the user
        print(f"FAIL: completion errored: {type(e).__name__}: {e}")
        if is_local:
            print("Hint: is Ollama running? Try `ollama serve` and `ollama pull llama3.1`.")
        return 1

    text = (resp.choices[0].message.content or "").strip()
    print(f"Model replied     : {text!r}")

    if not text:
        print("FAIL: model returned an empty response.")
        return 1

    print("-" * 48)
    if is_local:
        print("PASS: text path runs on a LOCAL model. No message text left your machine.")
        if gemini_key_set:
            print("NOTE: GEMINI_API_KEY is still set — only media transcription needs it now.")
    else:
        print("PASS (cloud): text path works, but this model is CLOUD-hosted.")
        print("To go local, set AGENT_MODEL=ollama/<model> and re-run.")
    print("REMINDER: media transcription (voice/video/image) still uses Gemini cloud.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

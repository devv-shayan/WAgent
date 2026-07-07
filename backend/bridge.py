"""
WebSocket RPC bridge between the OpenAI Agents SDK agent and the Chrome extension.

The extension connects over a single WebSocket.  When a tool function fires,
it calls `bridge.call_extension(tool_name, args)` which:
  1. Sends a `tool_call` JSON message to the extension.
  2. Creates an `asyncio.Future` keyed by a unique call ID.
  3. Awaits the matching `tool_result` (resolved by `handle_tool_result`).

Timeout is 120 s because some tools trigger a user-permission dialog in the
extension UI, which can take a while.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)

_CALL_TIMEOUT = 120  # seconds


class ExtensionBridge:
    """Singleton bridge that manages the WebSocket link to the Chrome extension."""

    def __init__(self) -> None:
        self._ws: WebSocket | None = None
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------

    async def register(self, ws: WebSocket) -> None:
        """Register the active WebSocket connection from the extension."""
        async with self._lock:
            if self._ws is not None:
                logger.warning("Replacing existing extension connection")
                # Cancel any pending futures from the old connection
                self._cancel_all_pending("Extension reconnected")
            self._ws = ws
            logger.info("Extension connected")

    async def unregister(self) -> None:
        """Unregister the WebSocket connection (extension disconnected)."""
        async with self._lock:
            self._ws = None
            self._cancel_all_pending("Extension disconnected")
            logger.info("Extension disconnected")

    @property
    def connected(self) -> bool:
        return self._ws is not None

    # ------------------------------------------------------------------
    # Outbound helpers
    # ------------------------------------------------------------------

    async def _send_json(self, data: dict[str, Any]) -> None:
        """Send a JSON message to the extension, if connected."""
        ws = self._ws
        if ws is None:
            raise ConnectionError("No extension connected")
        await ws.send_json(data)

    async def send_status(self, text: str) -> None:
        """Send an `agent_status` message to the extension UI."""
        try:
            await self._send_json({"type": "agent_status", "text": text})
        except ConnectionError:
            logger.debug("Cannot send status — no extension connected")

    async def send_delta(self, text: str) -> None:
        """Send an `assistant_delta` (streaming token) to the extension UI."""
        try:
            await self._send_json({"type": "assistant_delta", "text": text})
        except ConnectionError:
            logger.debug("Cannot send delta — no extension connected")

    async def send_assistant_message(self, text: str) -> None:
        """Send the final `assistant_message` to the extension UI."""
        try:
            await self._send_json({"type": "assistant_message", "text": text})
        except ConnectionError:
            logger.debug("Cannot send assistant message — no extension connected")

    # ------------------------------------------------------------------
    # RPC: call a tool on the extension and wait for the result
    # ------------------------------------------------------------------

    async def call_extension(
        self, tool_name: str, args: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Send a tool_call to the extension and wait for the matching tool_result.

        Returns the result payload on success.
        Raises RuntimeError on failure, timeout, or disconnection.
        """
        call_id = uuid.uuid4().hex[:12]
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()

        async with self._lock:
            self._pending[call_id] = future

        # Send the tool_call message
        try:
            await self._send_json(
                {
                    "type": "tool_call",
                    "id": call_id,
                    "name": tool_name,
                    "args": args,
                }
            )
        except ConnectionError as exc:
            async with self._lock:
                self._pending.pop(call_id, None)
            raise RuntimeError(f"Cannot call extension tool '{tool_name}': {exc}") from exc

        logger.info("Tool call sent: %s (id=%s)", tool_name, call_id)

        # Wait for the result
        try:
            result = await asyncio.wait_for(future, timeout=_CALL_TIMEOUT)
        except asyncio.TimeoutError:
            async with self._lock:
                self._pending.pop(call_id, None)
            raise RuntimeError(
                f"Tool call '{tool_name}' (id={call_id}) timed out after {_CALL_TIMEOUT}s"
            )
        except asyncio.CancelledError:
            async with self._lock:
                self._pending.pop(call_id, None)
            raise RuntimeError(
                f"Tool call '{tool_name}' (id={call_id}) was cancelled"
            )

        # Check for errors in the result
        if not result.get("ok", False):
            error_msg = result.get("error", "Unknown extension error")
            raise RuntimeError(f"Extension tool '{tool_name}' failed: {error_msg}")

        return result.get("result", {})

    # ------------------------------------------------------------------
    # Inbound: resolve a pending future when a tool_result arrives
    # ------------------------------------------------------------------

    async def handle_tool_result(self, msg: dict[str, Any]) -> None:
        """
        Route an incoming `tool_result` message to the correct pending future.
        """
        call_id = msg.get("id")
        if not call_id:
            logger.warning("Received tool_result without id: %s", msg)
            return

        async with self._lock:
            future = self._pending.pop(call_id, None)

        if future is None:
            logger.warning("No pending call for tool_result id=%s (expired?)", call_id)
            return

        if future.done():
            logger.warning("Future for id=%s already resolved", call_id)
            return

        future.set_result(msg)
        logger.info("Tool result received for id=%s", call_id)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _cancel_all_pending(self, reason: str) -> None:
        """Cancel every pending future (called under lock)."""
        for call_id, future in self._pending.items():
            if not future.done():
                future.set_exception(RuntimeError(reason))
                logger.debug("Cancelled pending call id=%s: %s", call_id, reason)
        self._pending.clear()


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------
bridge = ExtensionBridge()

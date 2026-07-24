"""Outbound authenticated WebSocket connection to a T3 Code server."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from contextlib import suppress
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from .protocol import WEBSOCKET_PATH, connection_hello

logger = logging.getLogger(__name__)

try:
    import websockets
except ImportError:  # pragma: no cover - Hermes currently installs websockets
    websockets = None

MessageHandler = Callable[[dict[str, Any]], Awaitable[None]]
StateHandler = Callable[[bool, str | None], Awaitable[None] | None]


class ConnectionRejected(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def websocket_url(url: str) -> str:
    """Normalize an HTTP(S) browser origin or WS(S) URL to the gateway route."""
    raw = (url or "").strip()
    parsed = urlsplit(raw)
    scheme = parsed.scheme.lower()
    if scheme == "https":
        scheme = "wss"
    elif scheme == "http":
        scheme = "ws"
    if scheme not in {"ws", "wss"} or not parsed.netloc:
        raise ValueError("URL must use http://, https://, ws://, or wss://")
    path = parsed.path.rstrip("/")
    if path != WEBSOCKET_PATH:
        path = WEBSOCKET_PATH
    return urlunsplit((scheme, parsed.netloc, path, "", ""))


def dependency_available() -> bool:
    return websockets is not None


async def _open_socket(url: str):
    if websockets is None:
        raise RuntimeError(
            "The `websockets` package is unavailable. Install the standard "
            "Hermes Agent dependencies and retry."
        )
    return await websockets.connect(  # type: ignore[union-attr]
        websocket_url(url),
        open_timeout=20,
        ping_interval=20,
        ping_timeout=20,
        close_timeout=5,
        max_size=2 * 1024 * 1024,
    )


async def authenticate_socket(
    socket: Any,
    *,
    authentication: dict[str, str],
    hermes_version: str,
    timeout: float = 20,
) -> dict[str, Any]:
    hello = connection_hello(
        hermes_version=hermes_version,
        authentication=authentication,
    )
    await socket.send(json.dumps(hello, separators=(",", ":"), ensure_ascii=False))
    raw = await asyncio.wait_for(socket.recv(), timeout=timeout)
    message = json.loads(raw)
    if not isinstance(message, dict):
        raise TypeError("T3 returned a non-object handshake frame")
    if message.get("requestId") != hello["requestId"]:
        raise RuntimeError("T3 returned a handshake with an unexpected requestId")
    if message.get("type") == "connection.rejected":
        raise ConnectionRejected(
            str(message.get("code") or "internal-error"),
            str(message.get("message") or "T3 rejected the gateway connection"),
        )
    if message.get("type") != "connection.accepted":
        raise RuntimeError(
            f"expected connection.accepted, received {message.get('type')!r}"
        )
    if message.get("protocolVersion") != 1:
        raise RuntimeError("T3 accepted the connection with an incompatible version")
    return message


async def enroll_once(
    *,
    url: str,
    token: str,
    hermes_version: str,
) -> dict[str, Any]:
    socket = await _open_socket(url)
    try:
        accepted = await authenticate_socket(
            socket,
            authentication={"type": "enrollment-token", "token": token},
            hermes_version=hermes_version,
        )
        if not accepted.get("instanceId") or not accepted.get("credential"):
            raise RuntimeError(
                "T3 accepted enrollment without returning an instance credential"
            )
        return accepted
    finally:
        await socket.close()


class T3GatewayConnection:
    """Reconnectable runtime connection authenticated by an instance credential."""

    def __init__(
        self,
        *,
        url: str,
        instance_id: str,
        credential: str,
        hermes_version: str,
        on_message: MessageHandler,
        on_state: StateHandler | None = None,
    ):
        self.url = websocket_url(url)
        self.instance_id = instance_id
        self.credential = credential
        self.hermes_version = hermes_version
        self._on_message = on_message
        self._on_state = on_state
        self._socket: Any = None
        self._supervisor: asyncio.Task[None] | None = None
        self._send_lock = asyncio.Lock()
        self._connected = asyncio.Event()
        self._first_result: asyncio.Future[bool] | None = None
        self._stopping = False

    @property
    def connected(self) -> bool:
        return self._connected.is_set()

    async def connect(self, timeout: float = 30) -> bool:
        if self._supervisor is not None and not self._supervisor.done():
            return self.connected
        self._stopping = False
        self._first_result = asyncio.get_running_loop().create_future()
        self._supervisor = asyncio.create_task(
            self._supervise(), name="hermes-t3-gateway"
        )
        try:
            return await asyncio.wait_for(asyncio.shield(self._first_result), timeout)
        except TimeoutError:
            await self.disconnect()
            return False

    async def disconnect(self) -> None:
        self._stopping = True
        self._connected.clear()
        if self._socket is not None:
            with suppress(Exception):
                await self._socket.close()
            self._socket = None
        if self._supervisor is not None:
            self._supervisor.cancel()
            with suppress(asyncio.CancelledError):
                await self._supervisor
            self._supervisor = None
        await self._notify_state(False, None)

    async def send(self, message: dict[str, Any]) -> None:
        if not self.connected or self._socket is None:
            raise ConnectionError("T3 Code gateway is offline")
        encoded = json.dumps(message, separators=(",", ":"), ensure_ascii=False)
        async with self._send_lock:
            await self._socket.send(encoded)

    async def _supervise(self) -> None:
        delay = 1.0
        while not self._stopping:
            reason: str | None = None
            try:
                socket = await _open_socket(self.url)
                self._socket = socket
                await authenticate_socket(
                    socket,
                    authentication={
                        "type": "instance-credential",
                        "instanceId": self.instance_id,
                        "credential": self.credential,
                    },
                    hermes_version=self.hermes_version,
                )
                self._connected.set()
                if self._first_result is not None and not self._first_result.done():
                    self._first_result.set_result(True)
                await self._notify_state(True, None)
                delay = 1.0
                async for raw in socket:
                    message = json.loads(raw)
                    if isinstance(message, dict):
                        await self._on_message(message)
            except asyncio.CancelledError:
                raise
            except ConnectionRejected as exc:
                reason = f"{exc.code}: {exc}"
                if self._first_result is not None and not self._first_result.done():
                    self._first_result.set_exception(exc)
                # Revoked credentials and version mismatches need operator
                # action; reconnecting the same secret can never recover.
                if exc.code in {
                    "instance-revoked",
                    "invalid-authentication",
                    "version-incompatible",
                }:
                    self._stopping = True
            except Exception as exc:  # noqa: BLE001 - reconnect every transient transport failure
                reason = str(exc)
                logger.warning("T3 gateway connection dropped: %s", exc)
            finally:
                self._connected.clear()
                self._socket = None
                await self._notify_state(False, reason)
            if self._stopping:
                break
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30.0)

    async def _notify_state(self, connected: bool, reason: str | None) -> None:
        if self._on_state is None:
            return
        try:
            result = self._on_state(connected, reason)
            if asyncio.iscoroutine(result):
                await result
        except Exception:
            logger.debug("T3 connection state callback failed", exc_info=True)

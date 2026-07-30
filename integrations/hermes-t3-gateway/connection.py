"""Outbound authenticated WebSocket connection to a T3 Code server."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from contextlib import suppress
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from .protocol import PROTOCOL_VERSION, WEBSOCKET_PATH, connection_hello, iso_now

logger = logging.getLogger(__name__)

try:
    import websockets
except ImportError:  # pragma: no cover - Hermes currently installs websockets
    websockets = None

MessageHandler = Callable[[dict[str, Any]], Awaitable[None]]
StateHandler = Callable[[bool, str | None], Awaitable[None] | None]
AcceptedHandler = Callable[[dict[str, Any]], Awaitable[None]]


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
        # Protocol v4+ turn frames may carry inline base64 attachments up to
        # 25MB raw (~34MB encoded, `protocol.MAX_MEDIA_BYTES`). 64MB leaves
        # room for the JSON envelope and T3's per-turn total while still
        # bounding a pathological frame.
        max_size=64 * 1024 * 1024,
    )


async def authenticate_socket(
    socket: Any,
    *,
    authentication: dict[str, str],
    hermes_version: str,
    timeout: float = 20,
    role: str = "gateway",
) -> dict[str, Any]:
    hello = connection_hello(
        hermes_version=hermes_version,
        authentication=authentication,
        role=role,
    )
    await socket.send(json.dumps(hello, separators=(",", ":"), ensure_ascii=False))

    # Read until the reply to THIS hello arrives. The handshake is not
    # guaranteed to be the only frame in flight — the server may already be
    # probing liveness — and treating whatever arrives first as the reply
    # tears down the connection that was just established, in a loop.
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            raise TimeoutError("T3 did not answer the gateway handshake in time")
        raw = await asyncio.wait_for(socket.recv(), timeout=remaining)
        message = json.loads(raw)
        if not isinstance(message, dict):
            raise TypeError("T3 returned a non-object handshake frame")
        if message.get("type") == "ping":
            # Answer inline: the read loop that normally handles this has not
            # started yet, and an unanswered ping counts against liveness.
            await socket.send(
                json.dumps(
                    {
                        "type": "pong",
                        "protocolVersion": PROTOCOL_VERSION,
                        "requestId": message.get("requestId"),
                        "sentAt": message.get("sentAt") or iso_now(),
                    },
                    separators=(",", ":"),
                    ensure_ascii=False,
                )
            )
            continue
        if message.get("requestId") != hello["requestId"]:
            # Some other correlated frame raced the handshake; keep waiting for
            # ours rather than failing the whole connection.
            logger.debug(
                "Ignoring a non-handshake frame while authenticating: %s",
                message.get("type"),
            )
            continue
        break
    if message.get("type") == "connection.rejected":
        raise ConnectionRejected(
            str(message.get("code") or "internal-error"),
            str(message.get("message") or "T3 rejected the gateway connection"),
        )
    if message.get("type") != "connection.accepted":
        raise RuntimeError(
            f"expected connection.accepted, received {message.get('type')!r}"
        )
    if message.get("protocolVersion") != PROTOCOL_VERSION:
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
        on_accepted: AcceptedHandler | None = None,
    ):
        self.url = websocket_url(url)
        self.instance_id = instance_id
        self.credential = credential
        self.hermes_version = hermes_version
        self._on_message = on_message
        self._on_state = on_state
        self._on_accepted = on_accepted
        self._socket: Any = None
        self._supervisor: asyncio.Task[None] | None = None
        self._send_lock = asyncio.Lock()
        self._connected = asyncio.Event()
        self._first_result: asyncio.Future[bool] | None = None
        self._handlers: set[asyncio.Task[None]] = set()
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

    def _spawn_handler(self, message: dict[str, Any]) -> None:
        """Run one command handler off the read loop.

        asyncio only holds a weak reference to tasks, so the handle is kept
        until completion — otherwise a long turn can be garbage collected
        mid-flight. Failures are logged rather than surfacing as bare
        "task exception was never retrieved" warnings.
        """
        task = asyncio.create_task(self._on_message(message))
        self._handlers.add(task)

        def _finished(completed: asyncio.Task[None]) -> None:
            self._handlers.discard(completed)
            if completed.cancelled():
                return
            error = completed.exception()
            if error is not None:
                logger.warning(
                    "T3 gateway command handler failed: %s", error, exc_info=error
                )

        task.add_done_callback(_finished)

    async def _send_pong(self, ping: dict[str, Any]) -> None:
        """Answer a liveness probe without going through command dispatch."""
        request_id = ping.get("requestId")
        if not request_id:
            return
        try:
            await self.send(
                {
                    "type": "pong",
                    "protocolVersion": PROTOCOL_VERSION,
                    "requestId": request_id,
                    "sentAt": ping.get("sentAt") or iso_now(),
                }
            )
        except Exception:  # noqa: BLE001 - a failed pong must not kill the read loop
            logger.debug("Failed to answer a T3 liveness ping", exc_info=True)

    async def _supervise(self) -> None:
        delay = 1.0
        while not self._stopping:
            reason: str | None = None
            try:
                socket = await _open_socket(self.url)
                self._socket = socket
                accepted = await authenticate_socket(
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
                # Deliberately after `_connected.set()`: the accepted callback
                # reconciles the home designation and flushes the durable
                # delivery queue, and both send frames back over this socket.
                await self._notify_accepted(accepted)
                await self._notify_state(True, None)
                delay = 1.0
                async for raw in socket:
                    message = json.loads(raw)
                    if not isinstance(message, dict):
                        continue
                    # Liveness is answered inline; it never touches Hermes.
                    if message.get("type") == "ping":
                        await self._send_pong(message)
                        continue
                    # Commands are dispatched WITHOUT awaiting them. A handler
                    # awaits Hermes — `turn.start` blocks for the whole agent
                    # turn — and awaiting it here would stop reading the
                    # socket, so a ping sent mid-turn would not even be read,
                    # let alone answered, and T3 would close a healthy
                    # connection as half-open. Ordering within a session is
                    # still preserved by the plugin's own per-thread state.
                    self._spawn_handler(message)
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

    async def _notify_accepted(self, accepted: dict[str, Any]) -> None:
        """Hand the `connection.accepted` frame to the adapter, best-effort.

        A failure here — a read-only `.env`, an unwritable queue file — must
        not tear down a connection that authenticated successfully, so it is
        logged and swallowed exactly like the state callback.
        """
        if self._on_accepted is None:
            return
        try:
            await self._on_accepted(accepted)
        except Exception:  # noqa: BLE001 - reconciliation must not fail a good handshake
            logger.warning("T3 connection accepted callback failed", exc_info=True)

    async def _notify_state(self, connected: bool, reason: str | None) -> None:
        if self._on_state is None:
            return
        try:
            result = self._on_state(connected, reason)
            if asyncio.iscoroutine(result):
                await result
        except Exception:
            logger.debug("T3 connection state callback failed", exc_info=True)

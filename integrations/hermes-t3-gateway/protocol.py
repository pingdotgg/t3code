"""Pure-Python helpers for the T3 Code ↔ Hermes gateway wire contract."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

PROTOCOL_VERSION = 1
PLUGIN_VERSION = "0.1.0"
WEBSOCKET_PATH = "/api/hermes-gateway/ws"

CAPABILITIES = {
    "protocolVersion": PROTOCOL_VERSION,
    "streaming": True,
    "activity": True,
    "approvals": True,
    "userInput": True,
    # First post-stability feature: advertise false until binary/media framing
    # and bounded attachment transfer are implemented end to end.
    "attachments": False,
}

SERVER_COMMANDS = frozenset(
    {
        "session.ensure",
        "turn.start",
        "turn.steer",
        "turn.interrupt",
        "approval.respond",
        "user-input.respond",
        "session.stop",
        "ping",
    }
)


def request_id() -> str:
    return str(uuid.uuid4())


def item_id() -> str:
    return str(uuid.uuid4())


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def frame(frame_type: str, **payload: Any) -> dict[str, Any]:
    return {
        "type": frame_type,
        "protocolVersion": PROTOCOL_VERSION,
        **payload,
    }


def connection_hello(
    *,
    hermes_version: str,
    authentication: dict[str, str],
    hello_request_id: str | None = None,
) -> dict[str, Any]:
    return {
        "type": "connection.hello",
        "requestId": hello_request_id or request_id(),
        "protocolVersion": PROTOCOL_VERSION,
        "pluginVersion": PLUGIN_VERSION,
        "hermesVersion": hermes_version,
        "capabilities": dict(CAPABILITIES),
        "authentication": authentication,
    }


def protocol_error(
    code: str,
    message: str,
    *,
    recoverable: bool,
    related_request_id: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "code": code,
        "message": message,
        "recoverable": recoverable,
    }
    if related_request_id:
        payload["requestId"] = related_request_id
    return frame("protocol.error", **payload)


def validate_server_frame(message: Any) -> dict[str, Any]:
    if not isinstance(message, dict):
        raise TypeError("gateway frame must be a JSON object")
    frame_type = message.get("type")
    if frame_type not in SERVER_COMMANDS:
        raise ValueError(f"unsupported T3 gateway frame: {frame_type!r}")
    if message.get("protocolVersion") != PROTOCOL_VERSION:
        raise ValueError(
            f"unsupported protocol version: {message.get('protocolVersion')!r}"
        )
    return message


def canonical_tool_item_type(tool_name: str) -> str:
    normalized = (tool_name or "").strip().lower()
    if normalized in {"terminal", "execute_code", "shell", "bash"}:
        return "command_execution"
    if normalized in {
        "apply_patch",
        "write_file",
        "edit_file",
        "delete_file",
        "move_file",
    }:
        return "file_change"
    if normalized.startswith(("mcp", "mcp__")):
        return "mcp_tool_call"
    if normalized in {"delegate_task", "spawn_agent", "send_message"}:
        return "collab_agent_tool_call"
    if "search" in normalized or normalized in {"web_fetch", "fetch_url"}:
        return "web_search"
    if normalized in {"view_image", "open_image"}:
        return "image_view"
    return "dynamic_tool_call"


def canonical_tool_data(tool_name: str, args: Any) -> dict[str, Any] | None:
    """Project known-safe, canonical fields; never forward arbitrary tool args."""
    if not isinstance(args, dict):
        return None
    item_type = canonical_tool_item_type(tool_name)
    if item_type == "command_execution":
        command = args.get("command")
        cwd = args.get("cwd") or args.get("workdir")
        projected = {}
        if isinstance(command, str) and command.strip():
            projected["command"] = command[:4_000]
        if isinstance(cwd, str) and cwd.strip():
            projected["cwd"] = cwd[:1_000]
        return projected or None
    if item_type == "file_change":
        path = args.get("path") or args.get("file_path") or args.get("filename")
        return (
            {"path": path[:1_000]} if isinstance(path, str) and path.strip() else None
        )
    if item_type == "web_search":
        query = args.get("query") or args.get("q") or args.get("url")
        return (
            {"query": query[:2_000]}
            if isinstance(query, str) and query.strip()
            else None
        )
    if item_type == "image_view":
        path = args.get("path") or args.get("image_path")
        return (
            {"path": path[:1_000]} if isinstance(path, str) and path.strip() else None
        )
    if item_type == "mcp_tool_call":
        server = args.get("server")
        operation = args.get("tool") or args.get("operation")
        projected = {}
        if isinstance(server, str) and server.strip():
            projected["server"] = server[:200]
        if isinstance(operation, str) and operation.strip():
            projected["operation"] = operation[:200]
        return projected or None
    return None

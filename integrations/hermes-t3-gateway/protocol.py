"""Pure-Python helpers for the T3 Code ↔ Hermes gateway wire contract."""

from __future__ import annotations

import base64
import binascii
import json
import uuid
from datetime import datetime, timezone
from typing import Any

PROTOCOL_VERSION = 5
PLUGIN_VERSION = "0.5.0"
WEBSOCKET_PATH = "/api/hermes-gateway/ws"

REASONING_EFFORTS = (
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
)

# What a connecting socket intends to be. `gateway` is the instance's one live
# plugin connection; `delivery` is a short-lived socket (an out-of-process cron
# run) that hands over a `home.deliver` and leaves. T3 never registers a
# `delivery` socket as the primary connection, so it cannot displace a healthy
# gateway connection under the broker's generation fencing.
CONNECTION_ROLES = frozenset({"gateway", "delivery"})

CAPABILITIES = {
    "protocolVersion": PROTOCOL_VERSION,
    "streaming": True,
    "activity": True,
    "approvals": True,
    "userInput": True,
    # Part of the v4+ contract itself, not a negotiated option: the T3 schema
    # pins `attachments` to the literal `true`, so a plugin that cannot handle
    # them is a v3 plugin and is rejected at the version gate.
    "attachments": True,
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
        "describe.request",
        "models.list.request",
        "skill.body.request",
        "home.deliver.ack",
        "media.deliver.ack",
    }
)

# Kinds a `home.deliver` may carry. Mirrors the T3 contract's
# `HermesGatewayHomeDeliveryKind`; anything not classified lands on "message".
HOME_DELIVERY_KINDS = frozenset({"cron", "message", "lifecycle", "handoff", "other"})

# Wire bounds from the T3 contract (`HermesGatewayHomeDeliver`): `label` is a
# trimmed non-empty string of at most 200 chars, `text` is 1..120000 chars.
# Enforced here so a pathological Hermes payload is clamped rather than
# rejected by the server after the plugin already dropped its local copy.
MAX_HOME_DELIVERY_LABEL_CHARS = 200
MAX_HOME_DELIVERY_TEXT_CHARS = 120_000

# Ceiling on a single skill body crossing the wire. Skill markdown is
# human-authored documentation, not data: 512 KiB is far past any real
# SKILL.md while still bounding a pathological file from stalling the socket.
MAX_SKILL_BODY_CHARS = 512_000

# Raw-byte ceiling for a single `media.deliver` frame, and for each attachment
# riding an inbound turn frame. Mirrors `HERMES_MEDIA_MAX_BYTES` in the T3
# contract: 25MB of raw bytes is ~34MB of base64, and the schema bound there is
# on the encoded string so an oversized frame fails at decode. Deliberately no
# chunking — a file that does not fit does not send, with a clear error.
MAX_MEDIA_BYTES = 25 * 1024 * 1024

# Wire bounds from the T3 contract (`HermesGatewayMediaDeliver`): `name` is a
# trimmed non-empty string of at most 255 chars, `mimeType` at most 100, and
# `caption` at most 2000. Enforced here for the same reason as the
# `home.deliver` bounds: a queued frame must already be wire-valid on disk.
MAX_MEDIA_NAME_CHARS = 255
MAX_MEDIA_MIME_CHARS = 100
MAX_MEDIA_CAPTION_CHARS = 2_000


def request_id() -> str:
    return str(uuid.uuid4())


def item_id() -> str:
    return str(uuid.uuid4())


def delivery_id() -> str:
    """Mint the idempotency key for one home delivery.

    Stable across retries by construction: the id is minted once, when the
    delivery is created, and the queued copy carries it verbatim through every
    flush. T3 dedupes on it, which is what makes double-flushing safe.
    """
    return str(uuid.uuid4())


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def frame(frame_type: str, **payload: Any) -> dict[str, Any]:
    return {
        "type": frame_type,
        "protocolVersion": PROTOCOL_VERSION,
        **payload,
    }


def configured_model_selection() -> dict[str, str] | None:
    """Return Hermes' configured default provider/model pair when available.

    Reads `hermes_cli.config.load_config_readonly()`, the documented read-only
    accessor. That function returns the *shared, process-wide cached* config
    dict, so nothing here mutates it or hands a nested structure to a caller.
    Older scalar `model:` configs are supported and an omitted provider uses
    Hermes' own gateway default, `openrouter`.

    Every failure mode — no Hermes on the path, an older Hermes without the
    accessor, a config with no model section — degrades to None so the field is
    omitted from the handshake rather than sent as null or empty.
    """
    try:
        from hermes_cli.config import load_config_readonly

        raw_model = load_config_readonly().get("model", {})
    except Exception:  # noqa: BLE001 - model reporting must never break the handshake
        return None
    if isinstance(raw_model, dict):
        model = raw_model.get("default", raw_model.get("name"))
        provider = raw_model.get("provider") or "openrouter"
    else:
        model = raw_model
        provider = "openrouter"
    if not isinstance(model, str) or not isinstance(provider, str):
        return None
    trimmed_model = model.strip()
    trimmed_provider = provider.strip() or "openrouter"
    if not trimmed_model:
        return None
    return {"provider": trimmed_provider, "model": trimmed_model}


def configured_model() -> str | None:
    """Return Hermes' configured default model, or None when unavailable."""
    selection = configured_model_selection()
    return selection["model"] if selection else None


def configured_reasoning_effort() -> str | None:
    """Return Hermes' configured reasoning effort, or None when unavailable.

    Same discipline as `configured_model()`: `load_config_readonly()` hands
    back the *shared, process-wide cached* config dict, so this reads
    `agent.reasoning_effort` and copies out a trimmed string — nothing here
    mutates the cache or lets a nested structure escape to a caller that
    might.

    Every failure mode — no Hermes on the path, an older Hermes without the
    accessor, a config with no `agent` section, a non-string value — degrades
    to None so the field is omitted from `describe.response` rather than sent
    as null or empty.
    """
    try:
        from hermes_cli.config import load_config_readonly

        effort = load_config_readonly().get("agent", {}).get("reasoning_effort")
    except Exception:  # noqa: BLE001 - describe must never break the connection
        return None
    if not isinstance(effort, str):
        return None
    trimmed = effort.strip()
    return trimmed or None


def models_catalog() -> dict[str, Any]:
    """Build the explicit, authenticated provider/model catalog for T3.

    This intentionally performs the potentially-blocking Hermes inventory
    work synchronously. The adapter calls it through ``asyncio.to_thread`` and
    only in response to ``models.list.request``; connecting and describing a
    gateway therefore never trigger model discovery or network-backed cache
    refreshes.

    Any inventory failure degrades to an empty list plus the read-only current
    config when available. A broken picker must not take the gateway offline.
    """
    configured = configured_model_selection()
    current_provider = configured["provider"] if configured else None
    current_model = configured["model"] if configured else None
    models: list[dict[str, Any]] = []

    try:
        from hermes_cli.inventory import build_models_payload, load_picker_context

        context = load_picker_context()
        payload = build_models_payload(
            context,
            explicit_only=True,
            include_unconfigured=False,
            picker_hints=False,
            canonical_order=True,
            pricing=False,
            capabilities=True,
            refresh=False,
            probe_custom_providers=False,
            probe_current_custom_provider=False,
            max_models=100,
        )
        if isinstance(payload, dict):
            payload_provider = payload.get("provider")
            payload_model = payload.get("model")
            if isinstance(payload_provider, str) and payload_provider.strip():
                current_provider = payload_provider.strip()
            if isinstance(payload_model, str) and payload_model.strip():
                current_model = payload_model.strip()

            seen: set[tuple[str, str]] = set()
            rows = payload.get("providers")
            if isinstance(rows, list):
                for row in rows:
                    if not isinstance(row, dict):
                        continue
                    provider = str(row.get("slug") or "").strip()
                    if not provider:
                        continue
                    provider_name = str(row.get("name") or provider).strip()
                    capabilities = row.get("capabilities")
                    if not isinstance(capabilities, dict):
                        capabilities = {}
                    row_models = row.get("models")
                    if not isinstance(row_models, list):
                        continue
                    for raw_model in row_models:
                        if not isinstance(raw_model, str) or not raw_model.strip():
                            continue
                        model = raw_model.strip()
                        key = (provider, model)
                        if key in seen:
                            continue
                        seen.add(key)
                        model_capabilities = capabilities.get(raw_model)
                        if not isinstance(model_capabilities, dict):
                            model_capabilities = capabilities.get(model)
                        supports_reasoning = True
                        if isinstance(model_capabilities, dict):
                            value = model_capabilities.get("reasoning")
                            if isinstance(value, bool):
                                supports_reasoning = value
                        models.append(
                            {
                                "provider": provider,
                                "providerName": provider_name or provider,
                                "model": model,
                                "supportsReasoning": supports_reasoning,
                            }
                        )
    except Exception:  # noqa: BLE001 - catalog discovery is best-effort
        models = []

    reasoning_effort = configured_reasoning_effort()
    if reasoning_effort:
        reasoning_effort = reasoning_effort.strip().lower()
        if reasoning_effort in {"false", "disabled", "off", "no"}:
            reasoning_effort = "none"
        elif reasoning_effort not in REASONING_EFFORTS:
            reasoning_effort = None

    return {
        "models": models,
        "currentProvider": current_provider,
        "currentModel": current_model,
        "currentReasoningEffort": reasoning_effort,
    }


def models_list_response(
    *,
    request_id_value: str,
    catalog: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the correlated response to ``models.list.request``."""
    resolved = models_catalog() if catalog is None else catalog
    payload: dict[str, Any] = {
        "type": "models.list.response",
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id_value,
        "reasoningEfforts": list(REASONING_EFFORTS),
        "models": [dict(model) for model in resolved.get("models", [])],
    }
    for key in ("currentProvider", "currentModel", "currentReasoningEffort"):
        value = resolved.get(key)
        if isinstance(value, str) and value.strip():
            payload[key] = value.strip()
    return payload


def installed_skills() -> list[dict[str, Any]]:
    """Return metadata for the skills Hermes currently exposes.

    Reads the documented `tools.skills_tool.skills_list()` tool surface — the
    same JSON the agent itself sees — rather than the private `_find_all_skills`
    scanner behind it. `skills_list()` already applies Hermes' platform,
    environment, and disabled-skill filters, so every entry it returns is a
    skill this Hermes would actually load; `enabled` is therefore always True
    here and disabled skills are simply absent (see COMPATIBILITY.md).

    Only trimmed string copies of `name`, `description`, and `category` leave
    this function: the payload is rebuilt entry by entry so nothing Hermes owns
    — cached or otherwise — is handed to a caller that might mutate it.

    Every failure mode — no Hermes on the path, an older Hermes without the
    tool, a non-JSON or unsuccessful response, a malformed entry — degrades to
    an empty list. Describing an agent must never break the connection.
    """
    try:
        from tools.skills_tool import skills_list

        payload = json.loads(skills_list())
    except Exception:  # noqa: BLE001 - describe must never break the connection
        return []
    if not isinstance(payload, dict) or not payload.get("success"):
        return []
    entries = payload.get("skills")
    if not isinstance(entries, list):
        return []
    skills: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        skill: dict[str, Any] = {"name": name.strip(), "enabled": True}
        description = entry.get("description")
        if isinstance(description, str) and description.strip():
            skill["description"] = description.strip()
        # Hermes' category is the closest thing it publishes to an install
        # source. There is no on-disk path in this surface; see COMPATIBILITY.md.
        source = entry.get("category")
        if isinstance(source, str) and source.strip():
            skill["source"] = source.strip()
        skills.append(skill)
    return skills


def skill_body(name: str) -> str | None:
    """Return a skill's SKILL.md markdown, or None when unavailable.

    Reads the documented `tools.skills_tool.skill_view()` tool surface with
    `preprocess=False`: T3 renders the skill for a human to read, so the
    literal authored markdown is wanted, not Hermes' template/inline-shell
    rendering of it.

    Unlike the omit-on-failure optional fields, `markdown` is explicitly null
    on failure: the request named a specific skill, so the caller needs to
    distinguish "asked and there is nothing to show" from a dropped reply.
    A missing skill, an unreadable file, an ambiguous name, an older Hermes,
    or no Hermes at all all land on None.
    """
    if not isinstance(name, str) or not name.strip():
        return None
    try:
        from tools.skills_tool import skill_view

        payload = json.loads(skill_view(name.strip(), preprocess=False))
    except Exception:  # noqa: BLE001 - describe must never break the connection
        return None
    if not isinstance(payload, dict) or not payload.get("success"):
        return None
    content = payload.get("content")
    if not isinstance(content, str) or not content.strip():
        return None
    return content[:MAX_SKILL_BODY_CHARS]


def describe_response(
    *,
    request_id_value: str,
    hermes_version: str,
    model: str | None = None,
    reasoning_effort: str | None = None,
    skills: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build the reply to a `describe.request`.

    Mirrors `connection_hello`: the version/capability block is always present
    because the plugin owns it outright, while every Hermes-sourced optional
    field is *omitted* when it cannot be read rather than sent as null or
    empty, so a server that has the field still falls back to its own generic
    label. `skills` is always present — an empty list is the truthful answer
    when Hermes reports none, and it keeps the client's rendering shape stable.
    """
    resolved_model = model if model is not None else configured_model()
    resolved_effort = (
        reasoning_effort
        if reasoning_effort is not None
        else configured_reasoning_effort()
    )
    resolved_skills = installed_skills() if skills is None else skills
    payload: dict[str, Any] = {
        "type": "describe.response",
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id_value,
        "pluginVersion": PLUGIN_VERSION,
        "hermesVersion": hermes_version,
        "capabilities": dict(CAPABILITIES),
        "skills": [dict(skill) for skill in resolved_skills],
        "describedAt": iso_now(),
    }
    if resolved_model:
        payload["model"] = resolved_model
    if resolved_effort:
        payload["reasoningEffort"] = resolved_effort
    return payload


def skill_body_response(
    *,
    request_id_value: str,
    skill_name: str,
    markdown: str | None,
) -> dict[str, Any]:
    """Build the reply to a `skill.body.request`.

    `markdown` is explicitly nullable here — the request named a skill, so the
    caller must be able to tell "Hermes has no body to show for this" apart
    from a reply that never arrived. Empty strings normalize to null.
    """
    return {
        "type": "skill.body.response",
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id_value,
        "skillName": skill_name,
        "markdown": markdown if markdown else None,
    }


def connection_hello(
    *,
    hermes_version: str,
    authentication: dict[str, str],
    hello_request_id: str | None = None,
    model: str | None = None,
    role: str = "gateway",
) -> dict[str, Any]:
    """Build the handshake frame.

    `role` is sent explicitly even though the T3 contract decodes a missing
    value as `"gateway"`: an out-of-process cron sender MUST announce
    `"delivery"` or the broker registers it as the instance's primary
    connection and generation-fences the live gateway socket off.
    """
    resolved_model = model if model is not None else configured_model()
    normalized_role = str(role or "gateway").strip().lower()
    if normalized_role not in CONNECTION_ROLES:
        normalized_role = "gateway"
    hello: dict[str, Any] = {
        "type": "connection.hello",
        "requestId": hello_request_id or request_id(),
        "protocolVersion": PROTOCOL_VERSION,
        "pluginVersion": PLUGIN_VERSION,
        "hermesVersion": hermes_version,
        "capabilities": dict(CAPABILITIES),
        "authentication": authentication,
        "role": normalized_role,
    }
    # Optional on the wire: omit entirely rather than send null/empty so a
    # server that has the field still falls back to its generic label.
    if resolved_model:
        hello["model"] = resolved_model
    return hello


def home_deliver(
    *,
    delivery_id_value: str,
    thread_id: str,
    kind: str,
    label: str,
    text: str,
    created_at: str | None = None,
) -> dict[str, Any]:
    """Build a `home.deliver` frame with every wire bound already applied.

    Like `protocol_error`, this wraps the generic `frame()` helper rather than
    assembling the envelope itself — but unlike the plain outbound frames the
    adapter builds inline, a delivery has server-side validation the plugin
    must not trip: `label` is trimmed non-empty ≤200 chars and `text` is
    1..120000 chars in the T3 contract. Normalizing here rather than at the
    call sites means a queued delivery is already wire-valid on disk, so a
    flush after a plugin upgrade cannot resurrect a payload the server will
    reject — the plugin would purge it only on an ack that never comes.

    An unknown `kind` degrades to `"other"` and an empty label to `"Hermes"`:
    a misclassified badge is the documented worst case, a dropped delivery is
    not.
    """
    normalized_kind = str(kind or "").strip().lower()
    if normalized_kind not in HOME_DELIVERY_KINDS:
        normalized_kind = "other"
    normalized_label = str(label or "").strip()[:MAX_HOME_DELIVERY_LABEL_CHARS].strip()
    if not normalized_label:
        normalized_label = "Hermes"
    normalized_text = str(text or "")[:MAX_HOME_DELIVERY_TEXT_CHARS]
    if not normalized_text:
        normalized_text = " "
    return frame(
        "home.deliver",
        deliveryId=delivery_id_value,
        threadId=str(thread_id),
        kind=normalized_kind,
        label=normalized_label,
        text=normalized_text,
        createdAt=created_at or iso_now(),
    )


def media_deliver(
    *,
    delivery_id_value: str,
    thread_id: str,
    kind: str,
    label: str,
    name: str,
    mime_type: str,
    data: bytes,
    turn_id: str | None = None,
    caption: str | None = None,
    created_at: str | None = None,
) -> dict[str, Any]:
    """Build a `media.deliver` frame with every wire bound already applied.

    Mirrors `home_deliver`: normalizing here rather than at the call sites
    means a queued delivery is already wire-valid on disk, so a flush after a
    plugin upgrade cannot resurrect a payload the server will reject — the
    plugin would purge it only on an ack that never comes.

    The clamp-vs-reject split follows what each field can survive. Provenance
    (`kind`, `label`) and presentation (`caption`) degrade exactly like
    `home_deliver`'s — a wrong badge or a shortened caption is the documented
    worst case. The payload itself cannot degrade: truncated bytes are a
    corrupt file, so an empty payload, a payload over `MAX_MEDIA_BYTES`, or a
    missing `deliveryId` raises `ValueError` instead — better a loud send-time
    failure than a poisoned queue entry T3 rejects forever.

    `data` is raw bytes; base64 encoding happens here so no call site can get
    the wire encoding wrong, and `sizeBytes` is derived from the same bytes so
    the two can never disagree.
    """
    if not str(delivery_id_value or "").strip():
        raise ValueError("media.deliver requires a deliveryId")
    if not isinstance(data, (bytes, bytearray)):
        raise TypeError("media.deliver data must be bytes")
    if len(data) == 0:
        raise ValueError("media.deliver requires a non-empty payload")
    if len(data) > MAX_MEDIA_BYTES:
        raise ValueError(
            f"media.deliver payload is {len(data)} bytes; "
            f"the wire ceiling is {MAX_MEDIA_BYTES} bytes (25MB)"
        )
    normalized_kind = str(kind or "").strip().lower()
    if normalized_kind not in HOME_DELIVERY_KINDS:
        normalized_kind = "other"
    normalized_label = str(label or "").strip()[:MAX_HOME_DELIVERY_LABEL_CHARS].strip()
    if not normalized_label:
        normalized_label = "Hermes"
    normalized_name = str(name or "").strip()[:MAX_MEDIA_NAME_CHARS].strip()
    if not normalized_name:
        normalized_name = "attachment.bin"
    normalized_mime = str(mime_type or "").strip()[:MAX_MEDIA_MIME_CHARS].strip()
    if not normalized_mime:
        normalized_mime = "application/octet-stream"
    payload: dict[str, Any] = {
        "deliveryId": delivery_id_value,
        "threadId": str(thread_id),
        "kind": normalized_kind,
        "label": normalized_label,
        "name": normalized_name,
        "mimeType": normalized_mime,
        "sizeBytes": len(data),
        "data": base64.b64encode(bytes(data)).decode("ascii"),
        "createdAt": created_at or iso_now(),
    }
    # Optional on the wire: omit rather than send null/empty, matching the
    # T3 schema's `Schema.optional` fields.
    if turn_id:
        payload["turnId"] = str(turn_id)
    normalized_caption = str(caption or "")[:MAX_MEDIA_CAPTION_CHARS]
    if normalized_caption:
        payload["caption"] = normalized_caption
    return frame("media.deliver", **payload)


def turn_attachments(message: dict[str, Any]) -> list[dict[str, Any]]:
    """Decode the optional `attachments` on a `turn.start` / `turn.steer`.

    Returns `[{"name", "mimeType", "data": bytes}, ...]` with the base64
    already decoded and each payload bounded by `MAX_MEDIA_BYTES`. The wire
    `sizeBytes` is advisory — the decoded length is the truth, so it is what
    callers get.

    A malformed entry raises `ValueError` rather than being skipped: T3
    validates these frames against its own schema before sending, so a bad
    entry here means version drift, and silently dropping a file the user
    attached is worse than a correlated `protocol.error` they can see.
    """
    raw = message.get("attachments")
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("turn attachments must be a list")
    attachments: list[dict[str, Any]] = []
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise ValueError(f"turn attachment {index} must be an object")
        name = str(entry.get("name") or "").strip()
        if not name:
            raise ValueError(f"turn attachment {index} is missing a name")
        encoded = entry.get("data")
        if not isinstance(encoded, str) or not encoded:
            raise ValueError(f"turn attachment {name!r} carries no data")
        try:
            data = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError(
                f"turn attachment {name!r} is not valid base64"
            ) from exc
        if len(data) == 0:
            raise ValueError(f"turn attachment {name!r} decoded to zero bytes")
        if len(data) > MAX_MEDIA_BYTES:
            raise ValueError(
                f"turn attachment {name!r} is {len(data)} bytes; "
                f"the wire ceiling is {MAX_MEDIA_BYTES} bytes (25MB)"
            )
        mime = str(entry.get("mimeType") or "").strip()
        attachments.append(
            {
                "name": name,
                "mimeType": mime or "application/octet-stream",
                "data": data,
            }
        )
    return attachments


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

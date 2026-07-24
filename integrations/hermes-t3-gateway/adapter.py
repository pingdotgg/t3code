"""Hermes platform adapter that treats each T3 thread as one Hermes session."""

from __future__ import annotations

import asyncio
import contextvars
import logging
import os
import threading
import uuid
import weakref
from dataclasses import dataclass, field
from typing import Any

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)
from gateway.session import build_session_key

from .cli import CREDENTIAL_ENV, INSTANCE_ID_ENV, NICKNAME_ENV, URL_ENV
from .connection import T3GatewayConnection, dependency_available
from .protocol import (
    canonical_tool_data,
    canonical_tool_item_type,
    frame,
    iso_now,
    item_id,
    protocol_error,
    validate_server_frame,
)

logger = logging.getLogger(__name__)


def _hermes_version() -> str:
    try:
        from hermes_cli import __version__

        return str(__version__)
    except Exception:  # noqa: BLE001 - version discovery must not block loading
        return "unknown"


@dataclass
class _TurnState:
    thread_id: str
    session_id: str
    turn_id: str
    request_id: str
    message_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    visible_text: str = ""
    assistant_started: bool = False
    tool_items: dict[str, str] = field(default_factory=dict)
    generic_activity_id: str | None = None
    generic_activity_detail: str | None = None


@dataclass
class _SteerControlResponse:
    thread_id: str
    request_id: str
    messages: list[str] = field(default_factory=list)


_steer_control_response = contextvars.ContextVar[_SteerControlResponse | None](
    "hermes_t3_steer_control_response",
    default=None,
)


class T3PlatformAdapter(BasePlatformAdapter):
    """One process-level T3 connection serving many isolated thread sessions."""

    supports_code_blocks = True
    supports_status_text = True
    REQUIRES_EDIT_FINALIZE = True
    MAX_MESSAGE_LENGTH = 120_000
    _instances: weakref.WeakSet[T3PlatformAdapter] = weakref.WeakSet()

    def __init__(self, config: PlatformConfig):
        super().__init__(config, Platform("t3"))
        extra = config.extra or {}
        self._url = str(extra.get("url") or os.environ.get(URL_ENV, "")).strip()
        self._instance_id = str(
            extra.get("instance_id") or os.environ.get(INSTANCE_ID_ENV, "")
        ).strip()
        self._credential = str(
            extra.get("credential") or os.environ.get(CREDENTIAL_ENV, "")
        ).strip()
        self._nickname = str(
            extra.get("nickname") or os.environ.get(NICKNAME_ENV, "") or "Hermes"
        ).strip()
        self._connection: T3GatewayConnection | None = None
        self._event_loop: asyncio.AbstractEventLoop | None = None
        self._sessions: dict[str, str] = {}
        self._active_session_threads: set[str] = set()
        self._thread_by_session: dict[str, str] = {}
        self._active_turns: dict[str, _TurnState] = {}
        self._approval_requests: dict[str, tuple[str, str]] = {}
        self._user_input_requests: dict[str, tuple[str, str]] = {}
        type(self)._instances.add(self)

    @property
    def name(self) -> str:
        return f"T3 Code ({self._nickname})"

    @property
    def authorization_is_upstream(self) -> bool:
        # The only source of inbound messages is T3's instance-authenticated
        # socket. There is no separate Hermes-side user allowlist.
        return True

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        del is_reconnect
        if not (self._url and self._instance_id and self._credential):
            self._set_fatal_error(
                "t3_not_enrolled",
                "Run `hermes t3 connect --url <url> --token <token>` first.",
                retryable=False,
            )
            return False
        self._event_loop = asyncio.get_running_loop()
        self._connection = T3GatewayConnection(
            url=self._url,
            instance_id=self._instance_id,
            credential=self._credential,
            hermes_version=_hermes_version(),
            on_message=self._handle_server_frame,
            on_state=self._handle_connection_state,
        )
        try:
            connected = await self._connection.connect()
        except Exception as exc:  # noqa: BLE001 - transport supplies typed rejection details
            self._set_fatal_error("t3_connection_rejected", str(exc), retryable=False)
            return False
        if connected:
            self._mark_connected()
            await self._send_status()
        return connected

    async def disconnect(self) -> None:
        if self._connection is not None:
            await self._connection.disconnect()
            self._connection = None
        self._mark_disconnected()

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> SendResult:
        del reply_to
        captured = self._capture_steer_control_response(chat_id, content)
        if captured is not None:
            return captured
        turn = self._active_turns.get(str(chat_id))
        if turn is None:
            return SendResult(success=False, error="no active T3 turn")
        try:
            await self._emit_assistant_content(turn, content)
            if bool((metadata or {}).get("notify")):
                await self._complete_turn(turn)
            return SendResult(success=True, message_id=turn.message_id)
        except Exception as exc:  # noqa: BLE001 - adapter send must return SendResult
            return SendResult(success=False, error=str(exc))

    async def edit_message(
        self,
        chat_id: str,
        message_id: str,
        content: str,
        *,
        finalize: bool = False,
        metadata: dict[str, Any] | None = None,
    ) -> SendResult:
        del metadata
        captured = self._capture_steer_control_response(chat_id, content)
        if captured is not None:
            return captured
        turn = self._active_turns.get(str(chat_id))
        if turn is None:
            return SendResult(success=False, error="no active T3 turn")
        try:
            await self._emit_assistant_content(turn, content)
            if finalize:
                await self._complete_turn(turn)
            return SendResult(success=True, message_id=message_id)
        except Exception as exc:  # noqa: BLE001 - adapter edit must return SendResult
            return SendResult(success=False, error=str(exc))

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        return {"name": f"T3 thread {chat_id}", "type": "dm"}

    async def send_typing(
        self, chat_id: str, metadata: dict[str, Any] | None = None
    ) -> None:
        del metadata
        turn = self._active_turns.get(str(chat_id))
        if turn is None:
            return
        status = getattr(self, "_status_text", {}).get(str(chat_id))
        if status:
            await self._emit_generic_activity(turn, status)

    def set_status_text(self, chat_id: str, text: str | None) -> None:
        super().set_status_text(chat_id, text)
        if not text:
            return
        turn = self._active_turns.get(str(chat_id))
        if turn is not None:
            self._schedule(self._emit_generic_activity(turn, text))

    async def send_exec_approval(
        self,
        chat_id: str,
        command: str,
        session_key: str,
        description: str,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> SendResult:
        del metadata, kwargs
        turn = self._active_turns.get(str(chat_id))
        if turn is None:
            return SendResult(success=False, error="no active T3 turn")
        approval_id = str(uuid.uuid4())
        self._approval_requests[approval_id] = (session_key, turn.turn_id)
        await self._send_frame(
            frame(
                "request.opened",
                threadId=turn.thread_id,
                sessionId=turn.session_id,
                turnId=turn.turn_id,
                requestId=approval_id,
                requestType="command_execution_approval",
                detail=description or "Hermes requests permission to run a command",
                args={"command": command},
            )
        )
        return SendResult(success=True, message_id=approval_id)

    async def send_clarify(
        self,
        chat_id: str,
        question: str,
        choices: list[Any] | None,
        clarify_id: str,
        session_key: str,
        metadata: dict[str, Any] | None = None,
    ) -> SendResult:
        del metadata
        turn = self._active_turns.get(str(chat_id))
        if turn is None:
            return SendResult(success=False, error="no active T3 turn")
        options = []
        for choice in choices or []:
            label = str(choice.get("label") if isinstance(choice, dict) else choice)
            description = (
                str(choice.get("description") or label)
                if isinstance(choice, dict)
                else label
            )
            options.append({"label": label, "description": description})
        self._user_input_requests[clarify_id] = (session_key, turn.turn_id)
        await self._send_frame(
            frame(
                "user-input.requested",
                threadId=turn.thread_id,
                sessionId=turn.session_id,
                turnId=turn.turn_id,
                requestId=clarify_id,
                questions=[
                    {
                        "id": clarify_id,
                        "header": "Hermes",
                        "question": question,
                        "options": options,
                        "multiSelect": False,
                    }
                ],
            )
        )
        return SendResult(success=True, message_id=clarify_id)

    async def _handle_server_frame(self, raw: dict[str, Any]) -> None:
        request = raw.get("requestId")
        try:
            message = validate_server_frame(raw)
            frame_type = message["type"]
            if frame_type == "session.ensure":
                await self._ensure_session(message)
            elif frame_type == "turn.start":
                await self._start_turn(message)
            elif frame_type == "turn.steer":
                await self._steer_turn(message)
            elif frame_type == "turn.interrupt":
                await self._interrupt_turn(message)
            elif frame_type == "approval.respond":
                await self._resolve_approval(message)
            elif frame_type == "user-input.respond":
                await self._resolve_user_input(message)
            elif frame_type == "session.stop":
                await self._stop_session(message)
            elif frame_type == "ping":
                await self._send_frame(
                    frame(
                        "pong",
                        requestId=message["requestId"],
                        sentAt=message.get("sentAt") or iso_now(),
                    )
                )
        except ValueError as exc:
            await self._send_frame(
                protocol_error(
                    "unsupported-message",
                    str(exc),
                    recoverable=True,
                    related_request_id=str(request) if request else None,
                )
            )
        except Exception as exc:
            logger.exception("T3 gateway command failed")
            await self._send_frame(
                protocol_error(
                    "internal-error",
                    str(exc) or type(exc).__name__,
                    recoverable=True,
                    related_request_id=str(request) if request else None,
                )
            )

    async def _ensure_session(self, message: dict[str, Any]) -> None:
        thread_id = str(message["threadId"])
        source = self._source(thread_id, str(message["requestId"]))
        session_id = build_session_key(source)
        resume_id = str(message.get("resumeSessionId") or "")
        self._sessions[thread_id] = session_id
        self._active_session_threads.add(thread_id)
        self._thread_by_session[session_id] = thread_id
        await self._send_frame(
            frame(
                "session.ready",
                requestId=message["requestId"],
                threadId=thread_id,
                sessionId=session_id,
                resumed=bool(resume_id and resume_id == session_id),
            )
        )
        await self._send_status()

    async def _start_turn(self, message: dict[str, Any]) -> None:
        thread_id = str(message["threadId"])
        session_id = self._sessions.get(thread_id)
        if not session_id or session_id != str(message["sessionId"]):
            await self._send_frame(
                protocol_error(
                    "session-not-found",
                    "Call session.ensure before starting a turn.",
                    recoverable=True,
                    related_request_id=str(message["requestId"]),
                )
            )
            return
        if thread_id in self._active_turns:
            await self._send_frame(
                protocol_error(
                    "invalid-message",
                    "This Hermes session already has an active turn; use turn.steer.",
                    recoverable=True,
                    related_request_id=str(message["requestId"]),
                )
            )
            return
        turn = _TurnState(
            thread_id=thread_id,
            session_id=session_id,
            turn_id=str(message["turnId"]),
            request_id=str(message["requestId"]),
        )
        self._active_turns[thread_id] = turn
        await self._send_frame(
            frame(
                "turn.started",
                requestId=turn.request_id,
                threadId=thread_id,
                sessionId=session_id,
                turnId=turn.turn_id,
            )
        )
        await self._send_status()
        await self.handle_message(
            MessageEvent(
                text=str(message["text"]),
                message_type=(
                    MessageType.COMMAND
                    if str(message["text"]).lstrip().startswith("/")
                    else MessageType.TEXT
                ),
                source=self._source(thread_id, turn.request_id),
                message_id=turn.request_id,
                metadata={"t3_turn_id": turn.turn_id},
            )
        )

    async def _steer_turn(self, message: dict[str, Any]) -> None:
        turn = self._active_turns.get(str(message["threadId"]))
        if turn is None or turn.turn_id != str(message["turnId"]):
            await self._send_frame(
                protocol_error(
                    "turn-not-active",
                    "The requested Hermes turn is no longer active.",
                    recoverable=True,
                    related_request_id=str(message["requestId"]),
                )
            )
            return
        # `/steer` is Hermes' official active-run injection surface. The base
        # adapter dispatches active slash commands inline, then sends the
        # command's textual acknowledgement back through this adapter with
        # `notify=True`. Capture that one command response by request context:
        # it is control traffic, not assistant output and not a turn boundary.
        control = _SteerControlResponse(
            thread_id=turn.thread_id,
            request_id=str(message["requestId"]),
        )
        context_token = _steer_control_response.set(control)
        command_error: Exception | None = None
        try:
            await self.handle_message(
                MessageEvent(
                    text=f"/steer {message['text']}",
                    message_type=MessageType.COMMAND,
                    source=self._source(turn.thread_id, control.request_id),
                    message_id=control.request_id,
                    metadata={"t3_turn_id": turn.turn_id, "t3_steer": True},
                )
            )
        except Exception as exc:  # noqa: BLE001 - translate command failures to the wire
            command_error = exc
        finally:
            _steer_control_response.reset(context_token)

        if command_error is not None:
            await self._send_frame(
                protocol_error(
                    "internal-error",
                    str(command_error) or "Hermes steering failed.",
                    recoverable=True,
                    related_request_id=control.request_id,
                )
            )
            return

        response = control.messages[-1] if control.messages else ""
        if not response.startswith("⏩ Steer queued"):
            if response.startswith(("Agent still starting", "No active agent")):
                error_code = "turn-not-active"
            elif response.startswith("⚠️ Steer failed"):
                error_code = "internal-error"
            else:
                error_code = "invalid-message"
            await self._send_frame(
                protocol_error(
                    error_code,
                    response or "Hermes did not acknowledge the steering request.",
                    recoverable=True,
                    related_request_id=control.request_id,
                )
            )
            return

        # Correlated command acknowledgement. It intentionally reuses the
        # existing turnId: this is not a second runtime turn. T3 consumes the
        # steering requestId as its broker acknowledgement and suppresses the
        # duplicate turn-start lifecycle projection.
        await self._send_frame(
            frame(
                "turn.started",
                requestId=control.request_id,
                threadId=turn.thread_id,
                sessionId=turn.session_id,
                turnId=turn.turn_id,
            )
        )

    def _capture_steer_control_response(
        self,
        chat_id: str,
        content: str,
    ) -> SendResult | None:
        control = _steer_control_response.get()
        if control is None or control.thread_id != str(chat_id):
            return None
        control.messages.append(str(content))
        return SendResult(
            success=True,
            message_id=f"t3-steer-control-{control.request_id}",
        )

    async def _interrupt_turn(self, message: dict[str, Any]) -> None:
        thread_id = str(message["threadId"])
        turn = self._active_turns.get(thread_id)
        if turn is None or turn.turn_id != str(message["turnId"]):
            await self._send_frame(
                protocol_error(
                    "turn-not-active",
                    "The requested Hermes turn is no longer active.",
                    recoverable=True,
                    related_request_id=str(message["requestId"]),
                )
            )
            return
        await self.interrupt_session_activity(turn.session_id, thread_id)
        await self._send_frame(
            frame(
                "turn.aborted",
                threadId=thread_id,
                sessionId=turn.session_id,
                turnId=turn.turn_id,
                reason="Interrupted by T3 Code",
            )
        )
        self._active_turns.pop(thread_id, None)
        await self._send_status()

    async def _resolve_approval(self, message: dict[str, Any]) -> None:
        request_id = str(message["requestId"])
        pending = self._approval_requests.pop(request_id, None)
        if pending is None:
            await self._send_frame(
                protocol_error(
                    "request-not-found",
                    "The Hermes approval request is no longer pending.",
                    recoverable=True,
                    related_request_id=request_id,
                )
            )
            return
        session_key, _turn_id = pending
        decision = str(message["decision"])
        choice = {
            "accept": "once",
            "acceptForSession": "session",
            "decline": "deny",
            "cancel": "deny",
        }.get(decision, "deny")
        from tools.approval import resolve_gateway_approval

        resolved = resolve_gateway_approval(session_key, choice)
        await self._send_frame(
            frame(
                "request.resolved",
                threadId=message["threadId"],
                sessionId=message["sessionId"],
                turnId=message["turnId"],
                requestId=request_id,
                requestType="command_execution_approval",
                decision=decision,
                resolution={"resolvedCount": resolved},
            )
        )

    async def _resolve_user_input(self, message: dict[str, Any]) -> None:
        request_id = str(message["requestId"])
        pending = self._user_input_requests.pop(request_id, None)
        if pending is None:
            await self._send_frame(
                protocol_error(
                    "request-not-found",
                    "The Hermes user-input request is no longer pending.",
                    recoverable=True,
                    related_request_id=request_id,
                )
            )
            return
        answers = message.get("answers") or {}
        answer = answers.get(request_id) if isinstance(answers, dict) else None
        if answer is None and isinstance(answers, dict) and answers:
            answer = next(iter(answers.values()))
        if isinstance(answer, list):
            response = ", ".join(str(value) for value in answer)
        else:
            response = str(answer or "")
        from tools.clarify_gateway import resolve_gateway_clarify

        resolved = resolve_gateway_clarify(request_id, response)
        await self._send_frame(
            frame(
                "user-input.resolved",
                threadId=message["threadId"],
                sessionId=message["sessionId"],
                turnId=message["turnId"],
                requestId=request_id,
                answers=answers,
            )
        )
        if not resolved:
            logger.warning(
                "Hermes clarify request %s was no longer pending", request_id
            )

    async def _stop_session(self, message: dict[str, Any]) -> None:
        thread_id = str(message["threadId"])
        session_id = self._sessions.get(thread_id)
        if session_id is None:
            await self._send_frame(
                protocol_error(
                    "session-not-found",
                    "The requested Hermes session is not active in this connection.",
                    recoverable=True,
                    related_request_id=str(message["requestId"]),
                )
            )
            return
        turn = self._active_turns.pop(thread_id, None)
        if turn is not None:
            await self.interrupt_session_activity(session_id, thread_id)
            await self._send_frame(
                frame(
                    "turn.aborted",
                    threadId=thread_id,
                    sessionId=session_id,
                    turnId=turn.turn_id,
                    reason="Hermes session stopped by T3 Code",
                )
            )
        await self._send_frame(
            frame(
                "session.exited",
                threadId=thread_id,
                sessionId=session_id,
                reason="Stopped by T3 Code",
                recoverable=True,
            )
        )
        # Deliberately retain the deterministic mapping and Hermes transcript.
        # A later session.ensure resumes this same thread/session identity.
        self._active_session_threads.discard(thread_id)
        await self._send_status()

    async def _emit_assistant_content(self, turn: _TurnState, content: str) -> None:
        visible = str(content or "").replace(" ▉", "").replace("▉", "")
        if not turn.assistant_started:
            turn.assistant_started = True
            await self._send_frame(
                frame(
                    "item.started",
                    threadId=turn.thread_id,
                    sessionId=turn.session_id,
                    turnId=turn.turn_id,
                    itemId=turn.message_id,
                    itemType="assistant_message",
                    status="inProgress",
                    title="Hermes response",
                )
            )
        if visible.startswith(turn.visible_text):
            delta = visible[len(turn.visible_text) :]
            turn.visible_text = visible
            if delta:
                await self._send_frame(
                    frame(
                        "content.delta",
                        threadId=turn.thread_id,
                        sessionId=turn.session_id,
                        turnId=turn.turn_id,
                        itemId=turn.message_id,
                        streamKind="assistant_text",
                        delta=delta,
                        contentIndex=0,
                    )
                )
        elif visible != turn.visible_text:
            # Hermes' public platform edit hook exposes cumulative rendered text,
            # but the v1 T3 delta contract has no replacement operation. Preserve
            # the valid prefix and report the rare rewrite as generic activity.
            await self._emit_generic_activity(
                turn, "Hermes revised already-streamed text; replacement is deferred."
            )

    async def _complete_turn(self, turn: _TurnState) -> None:
        if self._active_turns.get(turn.thread_id) is not turn:
            return
        if turn.assistant_started:
            await self._send_frame(
                frame(
                    "item.completed",
                    threadId=turn.thread_id,
                    sessionId=turn.session_id,
                    turnId=turn.turn_id,
                    itemId=turn.message_id,
                    itemType="assistant_message",
                    status="completed",
                    title="Hermes response",
                )
            )
        if turn.generic_activity_id is not None:
            await self._send_frame(
                frame(
                    "item.completed",
                    threadId=turn.thread_id,
                    sessionId=turn.session_id,
                    turnId=turn.turn_id,
                    itemId=turn.generic_activity_id,
                    itemType="unknown",
                    status="completed",
                    title="Hermes activity",
                    **(
                        {"detail": turn.generic_activity_detail}
                        if turn.generic_activity_detail
                        else {}
                    ),
                )
            )
        await self._send_frame(
            frame(
                "turn.completed",
                threadId=turn.thread_id,
                sessionId=turn.session_id,
                turnId=turn.turn_id,
                state="completed",
                stopReason=None,
            )
        )
        self._active_turns.pop(turn.thread_id, None)
        await self._send_status()

    async def _emit_generic_activity(self, turn: _TurnState, detail: str) -> None:
        if not detail:
            return
        normalized_detail = str(detail)[:2_000]
        if turn.generic_activity_detail == normalized_detail:
            return
        turn.generic_activity_detail = normalized_detail
        if turn.generic_activity_id is None:
            turn.generic_activity_id = item_id()
            event_type = "item.started"
        else:
            event_type = "item.updated"
        await self._send_frame(
            frame(
                event_type,
                threadId=turn.thread_id,
                sessionId=turn.session_id,
                turnId=turn.turn_id,
                itemId=turn.generic_activity_id,
                itemType="unknown",
                status="inProgress",
                title="Hermes activity",
                detail=normalized_detail,
            )
        )

    def emit_tool_started(
        self,
        session_id: str,
        tool_name: str,
        args: dict[str, Any],
        tool_call_id: str = "",
    ) -> None:
        thread_id = self._thread_by_session.get(str(session_id))
        turn = self._active_turns.get(thread_id or "")
        if turn is None:
            return
        tool_item_id = item_id()
        correlation_key = tool_call_id or tool_name
        turn.tool_items[correlation_key] = tool_item_id
        data = canonical_tool_data(tool_name, args)
        payload: dict[str, Any] = {
            "threadId": turn.thread_id,
            "sessionId": turn.session_id,
            "turnId": turn.turn_id,
            "itemId": tool_item_id,
            "itemType": canonical_tool_item_type(tool_name),
            "status": "inProgress",
            "title": tool_name,
        }
        if data is not None:
            payload["data"] = data
        self._schedule(
            self._send_frame(
                frame(
                    "item.started",
                    **payload,
                )
            )
        )

    def emit_tool_completed(
        self,
        session_id: str,
        tool_name: str,
        result: str,
        duration_ms: int | None,
        tool_call_id: str = "",
        status: str = "",
    ) -> None:
        thread_id = self._thread_by_session.get(str(session_id))
        turn = self._active_turns.get(thread_id or "")
        if turn is None:
            return
        correlation_key = tool_call_id or tool_name
        tool_item_id = turn.tool_items.pop(correlation_key, None) or item_id()
        del result
        payload: dict[str, Any] = {
            "threadId": turn.thread_id,
            "sessionId": turn.session_id,
            "turnId": turn.turn_id,
            "itemId": tool_item_id,
            "itemType": canonical_tool_item_type(tool_name),
            "status": "failed" if status == "error" else "completed",
            "title": tool_name,
        }
        if duration_ms is not None:
            payload["detail"] = f"Completed in {duration_ms} ms"
            payload["data"] = {"durationMs": duration_ms}
        self._schedule(
            self._send_frame(
                frame(
                    "item.completed",
                    **payload,
                )
            )
        )

    @classmethod
    def route_tool_started(
        cls,
        tool_name: str,
        args: dict[str, Any],
        session_id: str,
        tool_call_id: str = "",
    ) -> None:
        for instance in list(cls._instances):
            instance.emit_tool_started(session_id, tool_name, args, tool_call_id)

    @classmethod
    def route_tool_completed(
        cls,
        tool_name: str,
        result: str,
        session_id: str,
        duration_ms: int | None,
        tool_call_id: str = "",
        status: str = "",
    ) -> None:
        for instance in list(cls._instances):
            instance.emit_tool_completed(
                session_id,
                tool_name,
                result,
                duration_ms,
                tool_call_id,
                status,
            )

    def _source(self, thread_id: str, message_id: str):
        return self.build_source(
            chat_id=thread_id,
            chat_name=f"T3 thread {thread_id}",
            chat_type="dm",
            user_id="t3-code",
            user_name="T3 Code",
            message_id=message_id,
        )

    async def _send_frame(self, message: dict[str, Any]) -> None:
        connection = self._connection
        if connection is None:
            raise ConnectionError("T3 Code gateway is offline")
        await connection.send(message)

    async def _send_status(self) -> None:
        if self._connection is None or not self._connection.connected:
            return
        await self._send_frame(
            frame(
                "connection.status",
                activeSessionCount=len(self._active_session_threads),
            )
        )

    async def _handle_connection_state(
        self, connected: bool, reason: str | None
    ) -> None:
        if connected:
            self._mark_connected()
            await self._send_status()
            return
        self._mark_disconnected()
        if reason:
            logger.warning("T3 gateway offline: %s", reason)

    def _schedule(self, coroutine) -> None:
        loop = self._event_loop
        if loop is None or loop.is_closed():
            coroutine.close()
            return
        if threading.current_thread() is threading.main_thread():
            try:
                asyncio.get_running_loop()
            except RuntimeError:
                asyncio.run_coroutine_threadsafe(coroutine, loop)
            else:
                loop.create_task(coroutine)
        else:
            asyncio.run_coroutine_threadsafe(coroutine, loop)


def check_requirements() -> bool:
    return dependency_available()


def validate_config(config: PlatformConfig) -> bool:
    extra = getattr(config, "extra", {}) or {}
    return (
        bool(extra.get("url") or os.environ.get(URL_ENV, ""))
        and bool(extra.get("instance_id") or os.environ.get(INSTANCE_ID_ENV, ""))
        and bool(extra.get("credential") or os.environ.get(CREDENTIAL_ENV, ""))
    )


def env_enablement() -> dict[str, str] | None:
    url = os.environ.get(URL_ENV, "").strip()
    instance_id = os.environ.get(INSTANCE_ID_ENV, "").strip()
    credential = os.environ.get(CREDENTIAL_ENV, "").strip()
    if not (url and instance_id and credential):
        return None
    return {
        "url": url,
        "instance_id": instance_id,
        "credential": credential,
        "nickname": os.environ.get(NICKNAME_ENV, "").strip() or "Hermes",
    }

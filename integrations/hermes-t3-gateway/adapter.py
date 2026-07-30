"""Hermes platform adapter that treats each T3 thread as one Hermes session."""

from __future__ import annotations

import asyncio
import copy
import contextvars
import logging
import os
import re
import shlex
import tempfile
import time
import uuid
import weakref
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from pathlib import Path
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
from .home import (
    HOME_CHANNEL_ENV,
    MAX_FLUSH_PER_CONNECT,
    HomeDeliveryQueue,
    build_delivery,
    build_media_delivery,
    classify_delivery,
    home_thread_id,
    save_home_thread_id,
)
from .protocol import (
    PROTOCOL_VERSION,
    canonical_tool_data,
    canonical_tool_item_type,
    configured_model_selection,
    describe_response,
    frame,
    iso_now,
    item_id,
    models_catalog,
    models_list_response,
    protocol_error,
    REASONING_EFFORTS,
    skill_body,
    skill_body_response,
    turn_attachments,
    validate_server_frame,
)

logger = logging.getLogger(__name__)

_T3_HOME_CHANNEL_NOTICE = (
    "📬 No home channel is set for T3. "
    "A home channel is where Hermes delivers cron job results "
    "and cross-platform messages.\n\n"
    "Type /sethome to make this chat your home channel, or ignore to skip."
)

# T3's canonical item type for a free-form provider status line. Deliberately
# not `unknown`: that value is the "could not classify this" sentinel other
# adapters rely on being inert, so routing status text through it made stray
# activity rows appear in unrelated provider threads. T3 renders these rows
# preferring `detail` over `title`, so the live status string is sent as
# `detail`.
_STATUS_ITEM_TYPE = "status_text"

# How long a just-completed turn stays an acceptable scope for its own media.
#
# The window exists because the base adapter's delivery pipeline sends a
# reply's final TEXT before the reply's media files, and that text is
# notify-marked — so it completes the T3 turn, and every file of the same
# reply then arrives against a thread with no active turn
# (`gateway/platforms/base.py:5326` text, then `:5373+`/`:5424+` media).
#
# Sized against what actually separates the two: the live repro measured 36ms,
# and the only deliberate spacing upstream inserts is `_get_human_delay()`
# (`gateway/platforms/base.py:5051`), whose widest configured mode is 2.5s per
# file. 30s covers a slow batch of large files with generous headroom while
# staying far below any plausible human follow-up: the window closes long
# before the user could read the answer and ask something new, and it is a
# *scope* window only — it never keeps a turn alive or re-completes one.
_RECENT_TURN_MEDIA_WINDOW_SECONDS = 30.0


def _hermes_version() -> str:
    try:
        from hermes_cli import __version__

        return str(__version__)
    except Exception:  # noqa: BLE001 - version discovery must not block loading
        return "unknown"


# Characters allowed to survive from a client-supplied filename into a temp
# file name. Everything else is dropped: the name arrived over the wire and
# must never influence the directory the file lands in.
_ATTACHMENT_NAME_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _materialize_attachments(
    attachments: list[dict[str, Any]],
) -> tuple[list[str], list[str]]:
    """Write inbound turn attachments to private temp files.

    Returns `(paths, mime_types)` aligned by index — the exact shape
    `MessageEvent.media_urls` / `media_types` expect.

    Each turn gets its own `mkdtemp` directory (mode 0700) and each file is
    created with `mkstemp` (mode 0600), so nothing is readable by other users
    even mid-write. The extension is preserved from the wire `name` — after
    sanitizing, because that name is client-supplied — since Hermes routes
    files by suffix in several places (`should_send_media_as_audio`, the
    text-document allowlist). The files are deliberately not deleted here:
    Hermes reads them asynchronously during the turn (vision, STT, terminal
    tools), there is no turn-end hook on this surface, and the OS tmp reaper
    is the documented cleanup — the same pre-existing no-GC stance as T3's
    attachment store.
    """
    if not attachments:
        return [], []
    directory = tempfile.mkdtemp(prefix="hermes-t3-attachments-")
    paths: list[str] = []
    mime_types: list[str] = []
    for attachment in attachments:
        wire_name = Path(str(attachment["name"])).name  # strip any path parts
        stem = _ATTACHMENT_NAME_SAFE_RE.sub("_", Path(wire_name).stem)[:48]
        suffix = _ATTACHMENT_NAME_SAFE_RE.sub("", Path(wire_name).suffix)[:16]
        if suffix and not suffix.startswith("."):
            suffix = f".{suffix}"
        if suffix == ".":
            suffix = ""
        handle, path = tempfile.mkstemp(
            prefix=f"{stem or 'attachment'}-",
            suffix=suffix,
            dir=directory,
        )
        with os.fdopen(handle, "wb") as stream:
            stream.write(attachment["data"])
        paths.append(path)
        mime_types.append(str(attachment["mimeType"]))
    return paths, mime_types


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
    generic_activity_lock: asyncio.Lock = field(
        default_factory=asyncio.Lock,
        repr=False,
    )
    # Monotonic clock reading taken when this turn completed; None while live.
    # Read only by `_media_turn_scope` to bound how long the completed turn
    # remains an acceptable scope for its own trailing media
    # (`_RECENT_TURN_MEDIA_WINDOW_SECONDS`). Monotonic deliberately: a wall
    # clock adjustment mid-turn must not widen or collapse the window.
    completed_at: float | None = None


@dataclass
class _TurnStartReservation:
    """Fence one thread's pre-start configuration from concurrent lifecycle calls."""

    session_id: str
    cancelled: bool = False


@dataclass(frozen=True)
class _MappingEntrySnapshot:
    """One session-scoped mapping value captured before a control command."""

    existed: bool
    value: Any = None


def _snapshot_mapping_entry(
    mapping: Any,
    key: str,
    *,
    deep: bool = True,
) -> _MappingEntrySnapshot:
    if not isinstance(mapping, dict):
        return _MappingEntrySnapshot(existed=False)
    if key not in mapping:
        return _MappingEntrySnapshot(existed=False)
    value = mapping[key]
    return _MappingEntrySnapshot(
        existed=True,
        value=copy.deepcopy(value) if deep else value,
    )


def _restore_mapping_entry(
    mapping: Any,
    key: str,
    snapshot: _MappingEntrySnapshot,
) -> None:
    if not isinstance(mapping, dict):
        return
    if snapshot.existed:
        mapping[key] = snapshot.value
    else:
        mapping.pop(key, None)


@dataclass
class _SteerControlResponse:
    thread_id: str
    request_id: str
    messages: list[str] = field(default_factory=list)

    @property
    def control_message_id(self) -> str:
        """Synthetic id returned for captured control traffic.

        `edit_message` correlates against this so a later edit of the control
        acknowledgement is captured too, while genuine assistant edits (which
        carry the stream's own message id) pass straight through.
        """
        return f"t3-steer-control-{self.request_id}"


_steer_control_response = contextvars.ContextVar[_SteerControlResponse | None](
    "hermes_t3_steer_control_response",
    default=None,
)


class _TurnConfigurationError(ValueError):
    """A requested session configuration could not be applied safely."""


def _model_selection_from_turn(
    message: dict[str, Any],
) -> tuple[tuple[str, ...], dict[str, str]] | None:
    """Validate and resolve the optional v5 ``modelSelection`` request.

    The returned tuple contains a stable cache key and the explicit
    provider/model pair Hermes' session command needs. ``default`` is resolved
    to the current global config now, before any session state is changed.
    """
    raw = message.get("modelSelection")
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise _TurnConfigurationError("modelSelection must be an object")
    mode = str(raw.get("mode") or "").strip().lower()
    if mode == "default":
        configured = configured_model_selection()
        if configured is None:
            raise _TurnConfigurationError(
                "Hermes has no configured default model to select"
            )
        return (("default",), configured)
    if mode != "specific":
        raise _TurnConfigurationError(
            "modelSelection.mode must be 'default' or 'specific'"
        )
    provider = raw.get("provider")
    model = raw.get("model")
    if not isinstance(provider, str) or not provider.strip():
        raise _TurnConfigurationError(
            "A specific modelSelection requires a provider"
        )
    if not isinstance(model, str) or not model.strip():
        raise _TurnConfigurationError("A specific modelSelection requires a model")
    normalized = {"provider": provider.strip(), "model": model.strip()}
    return (("specific", normalized["provider"], normalized["model"]), normalized)


def _reasoning_effort_from_turn(message: dict[str, Any]) -> str | None:
    raw = message.get("reasoningEffort")
    if raw is None:
        return None
    if not isinstance(raw, str) or raw.strip().lower() not in REASONING_EFFORTS:
        raise _TurnConfigurationError(
            "reasoningEffort must be one of " + ", ".join(REASONING_EFFORTS)
        )
    return raw.strip().lower()


class T3PlatformAdapter(BasePlatformAdapter):
    """One process-level T3 connection serving many isolated thread sessions."""

    supports_code_blocks = True
    supports_status_text = True
    # Deliberately NOT set. It exists for rich-card surfaces that must be told
    # when to leave the streaming state; T3 closes an item on `item.completed`,
    # which this plugin emits itself. Declaring it only makes the gateway's
    # progress loop pass `finalize=True` on every progress edit
    # (`gateway/run.py:20777-20780`) — a signal we must ignore anyway.
    REQUIRES_EDIT_FINALIZE = False
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
        # A turn is not active until its requested model/reasoning has been
        # verified. Reserve that pre-start window separately so a second
        # turn.start cannot pass the active-turn guard while the first one is
        # awaiting Hermes' command handler. session.stop marks the reservation
        # cancelled; the first start then rolls its configuration back and can
        # never register or run, even if session.ensure races in afterward.
        self._turn_start_reservations: dict[str, _TurnStartReservation] = {}
        # Last requested and verified session-local model/reasoning state per
        # T3 thread. This is only an idempotency cache: every skip also checks
        # the runner's live override, and a plugin restart naturally starts
        # empty so the first v5 turn reapplies its requested configuration.
        self._applied_turn_configuration: dict[str, dict[str, Any]] = {}
        # Hermes' slash handlers also update runner-global compatibility state
        # such as `_reasoning_config`. Serialize configuration transactions
        # across T3 threads so one failed rollback cannot overwrite a later
        # session's successful selection.
        self._turn_configuration_lock = asyncio.Lock()
        # The most recently COMPLETED turn per thread. The base adapter's
        # delivery pipeline sends the final text (notify-marked, which
        # completes the turn here) BEFORE it sends the reply's media files
        # (`gateway/platforms/base.py:5326` then `:5383+`), so a turn reply's
        # media routinely arrives moments after its turn closed. This record
        # lets that media still be delivered turn-scoped instead of erroring
        # with "no active T3 turn".
        self._recent_turns: dict[str, _TurnState] = {}
        self._approval_requests: dict[str, tuple[str, str]] = {}
        self._user_input_requests: dict[str, tuple[str, str]] = {}
        self._home_queue = HomeDeliveryQueue()
        # Strong references to fire-and-forget tasks. asyncio only holds a weak
        # reference to a running task, so without this the GC may collect one
        # mid-flight and its exception surfaces as a bare warning.
        self._scheduled_tasks: set[asyncio.Task[Any]] = set()
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
            on_accepted=self._handle_connection_accepted,
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
        # `reply_to` is the base adapter's reply anchor. For the inline
        # slash-command path it is `_reply_anchor_for_event(event)`, which for
        # this platform resolves to the dispatched MessageEvent's `message_id`
        # — the steering requestId. That is the only correlation identifier
        # `send` receives, so it is the capture discriminator here.
        captured = self._capture_steer_control_response(chat_id, content, reply_to)
        if captured is not None:
            return captured
        thread_id = str(chat_id)
        turn = self._active_turns.get(thread_id)
        if self._is_proactive_delivery(thread_id, turn, content, metadata):
            return await self._deliver_to_home(thread_id, content, metadata)
        if turn is None:
            return SendResult(success=False, error="no active T3 turn")
        try:
            if content == _T3_HOME_CHANNEL_NOTICE:
                if bool((metadata or {}).get("notify")):
                    await self._complete_turn(turn)
                return SendResult(success=True, message_id=turn.message_id)
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
        # `finalize` is deliberately ignored as a completion signal.
        #
        # It reads like "this is the final edit of the response", and that is
        # what the base class documents it as — but the gateway's tool-progress
        # loop sets it unconditionally on EVERY progress-bubble edit whenever
        # the adapter declares `REQUIRES_EDIT_FINALIZE`
        # (`gateway/run.py:20777-20780`). Treating it as "turn finished" ended
        # the turn on the first tool call; every later send then failed with
        # "no active T3 turn" and the real answer was dropped.
        #
        # `notify=True` on `send()` is the signal that actually means "the
        # user-visible reply is delivered": the gateway applies it via
        # `_mark_notify_metadata` (`gateway/platforms/base.py:89`) only on
        # final replies, and the progress path never sets it (verified across
        # every `adapter.send`/`edit_message` call in the progress loop).
        del metadata, finalize
        # `edit_message` never carries the reply anchor; its correlation
        # identifier is the id of the message being edited. Only an edit of a
        # message this adapter already reported as captured control traffic is
        # control traffic itself.
        captured = self._capture_steer_control_response(chat_id, content, message_id)
        if captured is not None:
            return captured
        turn = self._active_turns.get(str(chat_id))
        if turn is None:
            return SendResult(success=False, error="no active T3 turn")
        try:
            if content == _T3_HOME_CHANNEL_NOTICE:
                return SendResult(success=True, message_id=message_id)
            await self._emit_assistant_content(turn, content)
            return SendResult(success=True, message_id=message_id)
        except Exception as exc:  # noqa: BLE001 - adapter edit must return SendResult
            return SendResult(success=False, error=str(exc))

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        return {"name": f"T3 thread {chat_id}", "type": "dm"}

    # ── proactive home delivery ────────────────────────────────────────

    def _is_proactive_delivery(
        self,
        thread_id: str,
        turn: _TurnState | None,
        content: str,
        metadata: dict[str, Any] | None,
    ) -> bool:
        """Decide whether this send is Hermes-initiated home delivery.

        **The gate is provenance, not turn absence.** The naive rule ("no
        active turn for this thread → deliver") deadlocks against the
        notify-completion contract the moment the home thread has a live turn:
        a cron result or `send_message` targeting the home chat mid-conversation
        would take the active-turn path, stream as that turn's assistant
        content, and — because final cron deliveries arrive notify-stamped via
        `_mark_notify_metadata` (`gateway/platforms/base.py:89`) — **complete
        the user's live turn with the cron output as its answer.** That is the
        same keyed-off-the-wrong-signal defect class as the `finalize` bug.

        The discriminator is `_gateway_session_key()`: the gateway binds
        `HERMES_SESSION_KEY` onto the turn's context for the whole handler
        (`gateway/run.py:12972` → `:14626`), and every send a turn produces —
        streamed or final — happens inside that scope. A genuine turn reply
        therefore resolves to this plugin's `build_session_key` id for its
        thread. Cron runs in its own `cron_*` session with the gateway keys
        explicitly cleared (`cron/scheduler.py:3066-3091`), and lifecycle
        broadcasts run in no session at all, so neither resolves to the live
        turn's key.

        The rules, in order:

        * A send whose session key matches an active turn on this thread is
          that turn's own output. Never a delivery — checked first so a turn
          reply can never be rerouted.
        * A send to a non-home thread is never a delivery: "message any thread
          unprompted" is deliberately out of scope, and the existing
          `"no active T3 turn"` error stays verbatim for it.
        * On the home thread with no active turn, any send is a delivery.
          There is nothing it could belong to.
        * On the home thread **with** an active turn whose session key does not
          match, provenance must be positively established (`classify_delivery`
          returning certain) before the send bypasses the turn. This is the
          conservative half of the gate: an unattributable send in that window
          falls through to the turn path — a possible misplacement inside the
          same thread — rather than being torn out of a turn it may belong to.
          An unclassifiable send can therefore never steal a live answer, and a
          recognisable cron/lifecycle/handoff delivery never completes one.
        """
        if turn is not None and self._gateway_session_key() == turn.session_id:
            return False
        home = home_thread_id()
        if not home or thread_id != home:
            return False
        if turn is None:
            return True
        _kind, _label, certain = classify_delivery(
            content,
            metadata,
            session_user_id=self._session_user_id(),
        )
        return certain

    async def _deliver_to_home(
        self,
        thread_id: str,
        content: str,
        metadata: dict[str, Any] | None,
    ) -> SendResult:
        """Emit one `home.deliver`, queueing it until T3 acknowledges it.

        Deliberately touches none of the turn machinery. `_active_turns` is not
        read or written, no turn/item frame is emitted, and `notify` — which
        arrives True on every final cron delivery — is consumed only as a
        classification hint. A delivery landing while the user has a live turn
        in this same thread must leave that turn running.
        """
        kind, label, _certain = classify_delivery(
            content,
            metadata,
            session_user_id=self._session_user_id(),
        )
        delivery = build_delivery(
            thread_id=thread_id,
            text=str(content or ""),
            kind=kind,
            label=label,
        )
        delivery_id_value = str(delivery["deliveryId"])
        # Persist BEFORE sending. The queue is the durability guarantee: if the
        # socket dies between here and the ack, the entry survives to be
        # replayed on the next connect, and T3's `deliveryId` dedupe makes the
        # replay harmless.
        queued = self._home_queue.append(delivery)
        sent = True
        try:
            await self._send_frame(delivery)
        except Exception as exc:  # noqa: BLE001 - adapter send must return SendResult
            sent = False
            logger.warning(
                "T3 home delivery %s could not be sent (%s); it is queued for "
                "the next connect",
                delivery_id_value,
                exc,
            )
        # Success needs EITHER leg to have held. Queued-and-unsent arrives on
        # the next connect; sent-but-unqueued is already at T3 (the ack simply
        # finds nothing to purge). Neither means the content is gone, and
        # reporting success then would tell a cron job its brief was delivered
        # when nothing on this machine still holds it.
        if not (queued or sent):
            return SendResult(
                success=False,
                message_id=delivery_id_value,
                error="T3 home delivery could not be sent or queued",
            )
        return SendResult(success=True, message_id=delivery_id_value)

    async def _handle_connection_accepted(self, accepted: dict[str, Any]) -> None:
        """Reconcile the home designation, then flush the delivery queue.

        T3's settings blob is the authoritative designation and it republishes
        it on every successful handshake, so the plugin's `T3_HOME_CHANNEL` is
        a synced cache: a differing local value — including a hand-edited one —
        is overwritten. Reconciling on every accept bounds drift to a single
        reconnect.
        """
        thread_id = str(accepted.get("homeThreadId") or "").strip()
        if thread_id and thread_id != home_thread_id():
            logger.info("T3 designated home thread %s", thread_id)
            save_home_thread_id(thread_id)
        elif thread_id:
            save_home_thread_id(thread_id)
        await self._flush_home_queue()

    async def _flush_home_queue(self) -> None:
        """Replay unacknowledged deliveries oldest-first.

        Entries are NOT removed here — only a `home.deliver.ack` purges one.
        Re-sending an entry T3 already durably wrote is harmless (it dedupes on
        `deliveryId`); dropping one it never wrote is not.

        Frames are restamped to the CURRENT protocol version before sending: an
        entry queued by an older plugin carries the version it was built under,
        and T3's strict-lockstep decoder closes the socket on any other version
        — turning one stale queued frame into a reconnect loop that outlives
        the upgrade. The delivery schemas themselves are unchanged in v5, and
        v3 home deliveries remain a valid subset, so restamping is honest.
        """
        pending = self._home_queue.entries()
        if not pending:
            return
        logger.info("Flushing %d queued T3 home deliver(y|ies)", len(pending))
        for entry in pending[:MAX_FLUSH_PER_CONNECT]:
            try:
                await self._send_frame({**entry, "protocolVersion": PROTOCOL_VERSION})
            except Exception as exc:  # noqa: BLE001 - the rest rides the next connect
                logger.warning("T3 home delivery flush stopped: %s", exc)
                return

    async def _acknowledge_home_delivery(self, message: dict[str, Any]) -> None:
        """Purge a delivery T3 has durably written.

        Serves `home.deliver.ack` and `media.deliver.ack` alike: both frame
        types live in the same queue keyed on `deliveryId`, so the purge does
        not care which kind of delivery was acknowledged.
        """
        delivery_id_value = str(message.get("deliveryId") or "").strip()
        if not delivery_id_value:
            raise ValueError("a delivery ack requires a deliveryId")
        self._home_queue.purge(delivery_id_value)

    # ── outbound media ─────────────────────────────────────────────────

    def _media_turn_scope(
        self,
        thread_id: str,
        content: str,
        metadata: dict[str, Any] | None,
    ) -> _TurnState | None:
        """Resolve the turn a media send belongs to, or None for home delivery.

        Same provenance gate as `_is_proactive_delivery`, with one addition:
        the base adapter's delivery pipeline sends a reply's final text —
        notify-marked, which completes the turn here — BEFORE it dispatches
        the reply's media files (`gateway/platforms/base.py:5326` then
        `:5373+`), so turn media routinely arrives moments after its turn
        closed and must still be able to reach back to it.

        **The session key is NOT available on the media dispatch path**, and
        that is structural, not a race. The gateway binds `HERMES_SESSION_KEY`
        inside `_handle_message_with_agent` and clears it in that method's own
        `finally` (`gateway/run.py:12972` → `:14626`); the delivery pipeline
        that sends the text and then the files lives one frame further out, in
        `BasePlatformAdapter._process_message_background`, and runs entirely
        AFTER the handler returned. `clear_session_vars` sets the vars to `""`
        rather than resetting them, deliberately suppressing the `os.environ`
        fallback — so every send the pipeline makes, text and media alike,
        reads `""`. Verified against the real gateway package: inside the
        handler the key resolves; on return it is `""`.

        The text path never noticed because it does not consult the key when a
        live turn exists — `send()` reaches `_is_proactive_delivery`, which for
        a non-home thread returns False on the thread check alone and falls
        through to `_active_turns`. Media had no such fallback: it required the
        key to match, so on a non-home thread the file was dropped with
        "no active T3 turn" (live repro 2026-07-27 18:47:06, 36ms after the
        turn's own text completed the turn).

        So the reach-back cannot be keyed on the session key. It is keyed on
        the two signals that ARE trustworthy here:

        * **Recency.** A completed turn is a scope only within
          `_RECENT_TURN_MEDIA_WINDOW_SECONDS` of completing. Turn media follows
          its text by milliseconds; anything later is not this turn's output.
        * **Provenance.** `classify_delivery` must NOT positively identify the
          send as proactive. This is the same discriminator the home half of
          the gate uses, applied with the opposite default — and it is what
          contains the collision this window would otherwise open.

        The collision to contain is `send_message`, the one thing besides a
        turn that can dispatch media to a NON-home thread
        (`tools/send_message_tool.py:1880+` → `adapter.send_image_file` with a
        caller-chosen `chat_id`). Cron cannot: it delivers to the home channel
        and is excluded by the thread check. But `send_message` runs INSIDE a
        turn's own handler — it is a tool the agent calls — so it is not a
        cross-turn intruder arriving during someone else's live turn; it is
        this session's own agent choosing a destination. Two cases follow. If
        it targets this thread, scoping the file to the turn that produced it
        is exactly right. If it targets a *different* thread, that thread's
        `_recent_turns` entry is stale by far more than the window unless the
        user was mid-conversation there seconds ago — and in that narrow case
        the file still lands in the thread the agent addressed, attributed to a
        turn that just ended in it. A slightly-wrong turn attribution on a
        message row, never a stolen answer.

        That asymmetry is the whole reason this is safe where the text gate is
        strict. `send()` completes turns; a misattributed text send ends a live
        turn with the wrong output — the `finalize` defect class. Media touches
        no turn machinery at all: `media.deliver` carries `turnId` purely as a
        sequencing hint, emits no turn or item frame, and cannot complete,
        interrupt, or alter a turn. The worst outcome here is a file sequenced
        next to the wrong neighbour.

        A live turn whose session key matches still wins outright and is
        checked first, so nothing about the ordinary in-handler path changes.
        """
        turn = self._active_turns.get(thread_id)
        recent = self._recent_turns.get(thread_id)
        session_key = self._gateway_session_key()
        if turn is not None and session_key == turn.session_id:
            return turn
        if turn is None and recent is not None and session_key == recent.session_id:
            return recent
        home = home_thread_id()
        if not home or thread_id != home:
            # Not home. A live turn takes the media exactly as the text path
            # would. Otherwise the just-completed turn may claim it, bounded by
            # recency and refused to a positively-proactive send — see above.
            if turn is not None:
                return turn
            if not self._within_media_reachback(recent):
                return None
            _kind, _label, certain = classify_delivery(
                content,
                metadata,
                session_user_id=self._session_user_id(),
            )
            return None if certain else recent
        if turn is None:
            return None
        _kind, _label, certain = classify_delivery(
            content,
            metadata,
            session_user_id=self._session_user_id(),
        )
        # Conservative half of the gate, mirroring text: an unattributable
        # media send during a live home turn stays with the turn.
        return None if certain else turn

    @staticmethod
    def _within_media_reachback(turn: _TurnState | None) -> bool:
        """True while a completed turn may still claim its own trailing media.

        A turn with no `completed_at` never went through `_complete_turn`, so
        nothing is known about when it ended — treated as out of the window
        rather than assumed fresh.
        """
        if turn is None or turn.completed_at is None:
            return False
        return (
            time.monotonic() - turn.completed_at
        ) <= _RECENT_TURN_MEDIA_WINDOW_SECONDS

    async def _deliver_media_file(
        self,
        chat_id: str,
        path: str,
        *,
        caption: str | None = None,
        name: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> SendResult:
        """Emit one `media.deliver`, queueing it until T3 acknowledges it.

        The same durable lifecycle as `_deliver_to_home`: persist BEFORE
        sending, report success once queued, purge only on the ack. The one
        divergence is a payload that cannot be built at all — unreadable file,
        empty, over the 25MB ceiling — which fails the send immediately
        instead of queueing a frame T3 would reject on every future flush.

        **An unscopeable file goes to Home rather than being dropped.** When
        `_media_turn_scope` finds nothing on a non-home thread, the old
        behaviour returned `"no active T3 turn"` — and upstream's only
        response to that is `logger.error("Failed to send image: %s")`
        (`gateway/platforms/base.py:3471`) before moving on. The file is gone,
        silently from the user's side, after Hermes spent a generation call
        producing it. Text can afford that (the agent can restate it, the user
        can ask again); a produced artifact cannot.

        Routing it to Home is safe in the way the thread route is not. The
        frame goes out turnless, so T3 re-resolves the instance's home thread
        server-side and writes only there — a plugin cannot address an
        arbitrary thread on this path even in principle
        (`apps/server/src/provider/hermesGatewayHttp.ts:207-215`) — and it
        carries `classify_delivery` provenance, so it renders as a badged
        notification exactly like a cron artifact rather than impersonating a
        thread reply. With no home designated there is genuinely nowhere to put
        it, and the original error stands.
        """
        thread_id = str(chat_id)
        content = str(caption or "")
        turn = self._media_turn_scope(thread_id, content, metadata)
        home = home_thread_id()
        delivery_thread_id = thread_id
        if turn is None and (not home or thread_id != home):
            if not home:
                return SendResult(success=False, error="no active T3 turn")
            logger.info(
                "T3 media for thread %s has no turn to attach to; delivering "
                "it to the home thread instead of dropping it",
                thread_id,
            )
            delivery_thread_id = home
        kind, label, _certain = classify_delivery(
            content,
            metadata,
            session_user_id=self._session_user_id(),
        )
        try:
            delivery = build_media_delivery(
                thread_id=delivery_thread_id,
                path=str(path),
                kind=kind,
                label=label,
                turn_id=turn.turn_id if turn is not None else None,
                caption=caption,
                name=name,
            )
        except Exception as exc:  # noqa: BLE001 - adapter send must return SendResult
            logger.warning("T3 media delivery for %s failed to build: %s", path, exc)
            return SendResult(success=False, error=str(exc))
        delivery_id_value = str(delivery["deliveryId"])
        queued = self._home_queue.append(delivery)
        sent = True
        try:
            await self._send_frame(delivery)
        except Exception as exc:  # noqa: BLE001 - adapter send must return SendResult
            sent = False
            logger.warning(
                "T3 media delivery %s could not be sent (%s); it is queued for "
                "the next connect",
                delivery_id_value,
                exc,
            )
        # Neither queued nor sent means the file is gone — the only copy was
        # the bytes in this frame, and Hermes' temp file may be reaped before
        # anyone could retry. Fail before the completion below, so the turn is
        # not closed on media that never arrived. See `_deliver_to_home` for
        # why either leg alone is honest success.
        if not (queued or sent):
            return SendResult(
                success=False,
                message_id=delivery_id_value,
                error="T3 media delivery could not be sent or queued",
            )
        # The same notify-completion contract `send()` honors for text. The
        # base adapter notify-marks every send of a reply's FINAL delivery
        # batch (`_mark_notify_metadata`, `gateway/platforms/base.py:5220`) —
        # text and media alike — and an image-only reply produces no text
        # send at all, so this is the only place its turn can complete.
        # Guarded to the still-live turn: the common text-then-media ordering
        # completes the turn on the text, and re-completing a `_recent_turns`
        # entry would emit a second `turn.completed` for a turn T3 already
        # folded.
        if (
            turn is not None
            and bool((metadata or {}).get("notify"))
            and self._active_turns.get(thread_id) is turn
        ):
            await self._complete_turn(turn)
        return SendResult(success=True, message_id=delivery_id_value)

    async def send_image_file(
        self,
        chat_id: str,
        image_path: str,
        caption: str | None = None,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> SendResult:
        del reply_to, kwargs
        return await self._deliver_media_file(
            chat_id, image_path, caption=caption, metadata=metadata
        )

    async def send_video(
        self,
        chat_id: str,
        video_path: str,
        caption: str | None = None,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> SendResult:
        del reply_to, kwargs
        return await self._deliver_media_file(
            chat_id, video_path, caption=caption, metadata=metadata
        )

    async def send_voice(
        self,
        chat_id: str,
        audio_path: str,
        caption: str | None = None,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> SendResult:
        # T3 renders audio as a download card (no native player in v1), which
        # is still strictly better than the base fallback's "couldn't deliver
        # the audio attachment" notice.
        del reply_to, kwargs
        return await self._deliver_media_file(
            chat_id, audio_path, caption=caption, metadata=metadata
        )

    async def send_document(
        self,
        chat_id: str,
        file_path: str,
        caption: str | None = None,
        file_name: str | None = None,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> SendResult:
        del reply_to, kwargs
        return await self._deliver_media_file(
            chat_id,
            file_path,
            caption=caption,
            name=file_name,
            metadata=metadata,
        )

    @staticmethod
    def _session_user_id() -> str:
        """Read the bound session's user id, for `/handoff` classification.

        Returns `""` on any failure, exactly like `_gateway_session_key`.
        """
        try:
            from gateway.session_context import get_session_env

            return str(get_session_env("HERMES_SESSION_USER_ID", "") or "")
        except Exception:  # noqa: BLE001 - classification must never raise
            return ""

    def format_tool_event(
        self, event: Any, *, mode: str = "all", preview_max_len: int = 40
    ) -> str | None:
        """Drop textual tool-progress chrome.

        T3 already renders tool calls as typed `item.started` / `item.completed`
        activity from the `pre_tool_call` / `post_tool_call` hooks, so a text
        line duplicating them is strictly worse than what T3 already shows.

        NOTE: at Hermes 62e07223 this hook is NOT on the live delivery path —
        `GatewayEventDispatcher` (`gateway/stream_dispatch.py:108`, its only
        caller) is referenced solely by upstream tests. The path that actually
        runs is `gateway/run.py:20485+`, which builds the same lines and
        delivers them through `adapter.send` / `adapter.edit_message` with no
        adapter hook to suppress them; it is silenced by the platform's
        `tool_progress` display setting instead. This override is kept because
        it is the documented contract and costs nothing if upstream routes
        through the dispatcher again — but it is not what protects the turn.
        The turn is protected by ignoring `finalize` in `edit_message`.
        """
        del event, mode, preview_max_len
        return None

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
            elif frame_type == "describe.request":
                await self._describe(message)
            elif frame_type == "models.list.request":
                await self._list_models(message)
            elif frame_type == "skill.body.request":
                await self._send_skill_body(message)
            elif frame_type in {"home.deliver.ack", "media.deliver.ack"}:
                await self._acknowledge_home_delivery(message)
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

    async def _describe(self, message: dict[str, Any]) -> None:
        """Answer `describe.request` with what this plugin knows about itself.

        Correlated by the request's own `requestId`, exactly like `ping` →
        `pong`. Every Hermes-sourced field degrades to omitted inside
        `describe_response`, so this branch has no failure path of its own:
        an unreadable config or an older Hermes yields a thinner reply, never
        a `protocol.error` and never a dropped connection.
        """
        await self._send_frame(
            describe_response(
                request_id_value=str(message["requestId"]),
                hermes_version=_hermes_version(),
            )
        )

    async def _list_models(self, message: dict[str, Any]) -> None:
        """Enumerate selectable models only when T3 explicitly asks.

        Hermes' inventory may consult a stale disk cache through synchronous
        provider code, so it must not occupy the gateway event loop. The
        protocol helper degrades inventory failures to a truthful empty list
        plus whatever current config remains readable.
        """
        catalog = await asyncio.to_thread(models_catalog)
        await self._send_frame(
            models_list_response(
                request_id_value=str(message["requestId"]),
                catalog=catalog,
            )
        )

    async def _send_skill_body(self, message: dict[str, Any]) -> None:
        """Answer `skill.body.request` with one skill's markdown.

        Fired on row expand, never eagerly — bodies are the reason skills are
        reported as metadata only. An unknown or unreadable skill replies with
        `markdown: null` rather than an error, so the UI can render "no body
        available" instead of showing the user a protocol failure.

        A *missing* skill name is different from an unreadable skill: the
        response carries `skillName` back for the client to key on, and an
        empty one would not decode. That case takes the ordinary correlated
        `protocol.error` path instead of echoing a name that was never sent.
        """
        skill_name = str(message.get("skillName") or "").strip()
        if not skill_name:
            raise ValueError("skill.body.request requires a skillName")
        await self._send_frame(
            skill_body_response(
                request_id_value=str(message["requestId"]),
                skill_name=skill_name,
                markdown=skill_body(skill_name),
            )
        )

    async def _ensure_session(self, message: dict[str, Any]) -> None:
        thread_id = str(message["threadId"])
        source = self._source(thread_id, str(message["requestId"]))
        session_id = self._session_id_for_source(source)
        resume_id = str(message.get("resumeSessionId") or "")
        self._sessions[thread_id] = session_id
        self._active_session_threads.add(thread_id)
        self._thread_by_session[session_id] = thread_id
        active_turn = self._active_turns.get(thread_id)
        await self._send_frame(
            frame(
                "session.ready",
                requestId=message["requestId"],
                threadId=thread_id,
                sessionId=session_id,
                resumed=bool(resume_id and resume_id == session_id),
                **(
                    {"activeTurnId": active_turn.turn_id}
                    if active_turn is not None
                    else {}
                ),
            )
        )
        await self._send_status()

    def _session_id_for_source(self, source: Any) -> str:
        """Resolve the same profile-aware key Hermes' command handlers use."""
        runner = getattr(self, "gateway_runner", None)
        resolver = getattr(runner, "_session_key_for_source", None)
        session_id = (
            resolver(source) if callable(resolver) else build_session_key(source)
        )
        resolved = str(session_id or "").strip()
        if not resolved:
            raise ValueError("Hermes could not resolve a session key for this thread")
        return resolved

    def _configuration_surfaces(
        self,
        *,
        needs_model: bool,
        needs_reasoning: bool,
    ) -> tuple[Any, Any]:
        """Validate every Hermes surface before the first state mutation."""
        handler = self._message_handler
        runner = getattr(self, "gateway_runner", None)
        if not callable(handler) or runner is None:
            raise _TurnConfigurationError(
                "Hermes cannot apply session configuration on this gateway"
            )
        if needs_model or needs_reasoning:
            if not isinstance(
                getattr(runner, "_session_model_overrides", None), dict
            ) or not callable(
                getattr(runner, "_resolve_session_agent_runtime", None)
            ):
                raise _TurnConfigurationError(
                    "This Hermes version cannot resolve session model state"
                )
        if needs_reasoning:
            if not isinstance(
                getattr(runner, "_session_reasoning_overrides", None), dict
            ) or not callable(
                getattr(runner, "_resolve_session_reasoning_config", None)
            ):
                raise _TurnConfigurationError(
                    "This Hermes version does not support session reasoning selection"
                )
        return runner, handler

    @staticmethod
    def _effective_model_selection(runner: Any, session_id: str) -> dict[str, str]:
        override = runner._session_model_overrides.get(session_id)
        if not isinstance(override, dict):
            raise _TurnConfigurationError(
                "Hermes did not install the requested session model override"
            )
        override_model = str(override.get("model") or "").strip()
        override_provider = str(override.get("provider") or "").strip()
        if not override_model or not override_provider:
            raise _TurnConfigurationError(
                "Hermes installed an incomplete session model override"
            )
        try:
            effective_model, runtime = runner._resolve_session_agent_runtime(
                session_key=session_id
            )
        except Exception as exc:
            raise _TurnConfigurationError(
                "Hermes could not resolve the requested session model"
            ) from exc
        resolved_model = str(effective_model or "").strip()
        resolved_provider = ""
        if isinstance(runtime, dict):
            resolved_provider = str(runtime.get("provider") or "").strip()
        resolved_provider = resolved_provider or override_provider
        if resolved_model != override_model or resolved_provider != override_provider:
            raise _TurnConfigurationError(
                "Hermes did not make the requested session model effective"
            )
        return {"provider": resolved_provider, "model": resolved_model}

    @staticmethod
    def _effective_reasoning_effort(
        runner: Any,
        session_id: str,
        *,
        model: str,
    ) -> str:
        override = runner._session_reasoning_overrides.get(session_id)
        if not isinstance(override, dict):
            raise _TurnConfigurationError(
                "Hermes did not install the requested session reasoning override"
            )
        try:
            effective = runner._resolve_session_reasoning_config(
                session_key=session_id,
                model=model,
            )
        except Exception as exc:
            raise _TurnConfigurationError(
                "Hermes could not resolve the requested reasoning effort"
            ) from exc
        if not isinstance(effective, dict) or effective != override:
            raise _TurnConfigurationError(
                "Hermes did not make the requested reasoning effort effective"
            )
        if effective.get("enabled") is False:
            return "none"
        effort = str(effective.get("effort") or "").strip().lower()
        if effort not in REASONING_EFFORTS:
            raise _TurnConfigurationError(
                "Hermes installed an invalid session reasoning override"
            )
        return effort

    @staticmethod
    def _current_effective_model(runner: Any, session_id: str) -> str:
        try:
            model, _runtime = runner._resolve_session_agent_runtime(
                session_key=session_id
            )
        except Exception as exc:
            raise _TurnConfigurationError(
                "Hermes could not resolve the session model for reasoning"
            ) from exc
        resolved = str(model or "").strip()
        if not resolved:
            raise _TurnConfigurationError(
                "Hermes has no effective session model for reasoning"
            )
        return resolved

    async def _apply_turn_configuration(
        self,
        message: dict[str, Any],
        *,
        thread_id: str,
        session_id: str,
        can_commit: Callable[[], bool] | None = None,
    ) -> dict[str, Any]:
        async with self._turn_configuration_lock:
            # A different thread's configuration may have held the lock while
            # this session was stopped. Fence it before any slash command or
            # durable snapshot can mutate Hermes state.
            if can_commit is not None and not can_commit():
                raise _TurnConfigurationError(
                    "The Hermes session stopped while its turn was starting"
                )
            return await self._apply_turn_configuration_locked(
                message,
                thread_id=thread_id,
                session_id=session_id,
                can_commit=can_commit,
            )

    async def _apply_turn_configuration_locked(
        self,
        message: dict[str, Any],
        *,
        thread_id: str,
        session_id: str,
        can_commit: Callable[[], bool] | None = None,
    ) -> dict[str, Any]:
        """Apply v5 model/reasoning requests through Hermes' command surface.

        Commands go straight to the runner's registered message handler, not
        ``handle_message``. Their control acknowledgements are therefore never
        sent through this adapter or leaked into the T3 transcript.
        """
        model_request = _model_selection_from_turn(message)
        reasoning_effort = _reasoning_effort_from_turn(message)
        if model_request is None and reasoning_effort is None:
            if can_commit is not None and not can_commit():
                raise _TurnConfigurationError(
                    "The Hermes session stopped while its turn was starting"
                )
            return {}

        runner, handler = self._configuration_surfaces(
            needs_model=model_request is not None,
            needs_reasoning=reasoning_effort is not None,
        )
        source = self._source(thread_id, str(message["requestId"]))
        command_session_id = self._session_id_for_source(source)
        if command_session_id != session_id:
            raise _TurnConfigurationError(
                "The Hermes session profile changed; call session.ensure again"
            )

        model_overrides = runner._session_model_overrides
        reasoning_overrides = getattr(runner, "_session_reasoning_overrides", None)
        model_override_snapshot = _snapshot_mapping_entry(
            model_overrides, session_id
        )
        reasoning_override_snapshot = _snapshot_mapping_entry(
            reasoning_overrides, session_id
        )
        had_pending_notes_attribute = hasattr(runner, "_pending_model_notes")
        pending_notes_snapshot = _snapshot_mapping_entry(
            getattr(runner, "_pending_model_notes", None), session_id
        )
        one_turn_restore_snapshot = _snapshot_mapping_entry(
            getattr(runner, "_pending_one_turn_model_restores", None), session_id
        )
        ephemeral_pin_snapshot = _snapshot_mapping_entry(
            getattr(runner, "_session_ephemeral_pin", None), session_id
        )
        voice_channel_snapshot = _snapshot_mapping_entry(
            getattr(runner, "_session_vc_last", None), session_id
        )
        had_reasoning_config = hasattr(runner, "_reasoning_config")
        prior_reasoning_config = copy.deepcopy(
            getattr(runner, "_reasoning_config", None)
        )

        durable_store = None
        durable_entry = None
        durable_override_snapshot: dict[str, Any] | None = None
        durable_entry_was_auto_reset: bool | None = None
        session_db = None
        session_db_id = ""
        session_db_row: dict[str, Any] | None = None
        if model_request is not None:
            durable_store = getattr(runner, "async_session_store", None)
            if durable_store is not None:
                get_or_create = getattr(
                    durable_store, "get_or_create_session", None
                )
                get_override = getattr(durable_store, "get_model_override", None)
                set_override = getattr(durable_store, "set_model_override", None)
                if not all(
                    callable(method)
                    for method in (get_or_create, get_override, set_override)
                ):
                    raise _TurnConfigurationError(
                        "This Hermes version cannot transact session model state"
                    )
                try:
                    durable_entry = await get_or_create(source)
                    durable_override_snapshot = copy.deepcopy(
                        await get_override(session_id)
                    )
                except Exception as exc:
                    raise _TurnConfigurationError(
                        "Hermes could not snapshot its persisted session model"
                    ) from exc
                durable_entry_was_auto_reset = bool(
                    getattr(durable_entry, "was_auto_reset", False)
                )
                session_db_id = str(
                    getattr(durable_entry, "session_id", "") or ""
                )

            session_db = getattr(runner, "_session_db", None)
            if session_db is not None and session_db_id:
                get_session = getattr(session_db, "get_session", None)
                restore_methods = (
                    getattr(session_db, "update_session_model", None),
                    getattr(session_db, "update_session_meta", None),
                    getattr(session_db, "update_system_prompt", None),
                )
                if not callable(get_session) or not all(
                    callable(method) for method in restore_methods
                ):
                    raise _TurnConfigurationError(
                        "This Hermes version cannot transact its session database"
                    )
                try:
                    row = await get_session(session_db_id)
                except Exception as exc:
                    raise _TurnConfigurationError(
                        "Hermes could not snapshot its session database"
                    ) from exc
                if isinstance(row, dict):
                    session_db_row = copy.deepcopy(row)

        had_cache = thread_id in self._applied_turn_configuration
        prior_cache = copy.deepcopy(
            self._applied_turn_configuration.get(thread_id)
        )
        cache = self._applied_turn_configuration.setdefault(thread_id, {})
        applied: dict[str, Any] = {}

        # Hermes' /model handler switches a cached agent in place and then
        # releases it. Keep the prior agent outside that command transaction:
        # a failed /reasoning verification can then put the untouched cache
        # entry back, while a successful transaction still disposes it through
        # Hermes' own eviction path.
        agent_cache = getattr(runner, "_agent_cache", None)
        agent_cache_lock = getattr(runner, "_agent_cache_lock", None)
        detached_agent_cache = _MappingEntrySnapshot(existed=False)
        if isinstance(agent_cache, dict):
            if agent_cache_lock is not None:
                with agent_cache_lock:
                    detached_agent_cache = _snapshot_mapping_entry(
                        agent_cache, session_id, deep=False
                    )
                    agent_cache.pop(session_id, None)
            else:
                detached_agent_cache = _snapshot_mapping_entry(
                    agent_cache, session_id, deep=False
                )
                agent_cache.pop(session_id, None)

        def restore_prior_memory_configuration() -> None:
            _restore_mapping_entry(
                model_overrides, session_id, model_override_snapshot
            )
            _restore_mapping_entry(
                reasoning_overrides, session_id, reasoning_override_snapshot
            )
            _restore_mapping_entry(
                getattr(runner, "_pending_model_notes", None),
                session_id,
                pending_notes_snapshot,
            )
            current_pending_notes = getattr(runner, "_pending_model_notes", None)
            if (
                not had_pending_notes_attribute
                and isinstance(current_pending_notes, dict)
                and not current_pending_notes
            ):
                delattr(runner, "_pending_model_notes")
            _restore_mapping_entry(
                getattr(runner, "_pending_one_turn_model_restores", None),
                session_id,
                one_turn_restore_snapshot,
            )
            _restore_mapping_entry(
                getattr(runner, "_session_ephemeral_pin", None),
                session_id,
                ephemeral_pin_snapshot,
            )
            _restore_mapping_entry(
                getattr(runner, "_session_vc_last", None),
                session_id,
                voice_channel_snapshot,
            )
            if had_reasoning_config:
                runner._reasoning_config = prior_reasoning_config
            elif hasattr(runner, "_reasoning_config"):
                delattr(runner, "_reasoning_config")
            if had_cache:
                self._applied_turn_configuration[thread_id] = prior_cache
            else:
                self._applied_turn_configuration.pop(thread_id, None)

        def restore_detached_agent_cache() -> None:
            if not isinstance(agent_cache, dict):
                return
            if agent_cache_lock is not None:
                with agent_cache_lock:
                    _restore_mapping_entry(
                        agent_cache, session_id, detached_agent_cache
                    )
            else:
                _restore_mapping_entry(
                    agent_cache, session_id, detached_agent_cache
                )

        async def restore_prior_durable_configuration() -> None:
            failures: list[tuple[str, Exception]] = []

            async def attempt(
                label: str,
                operation: Callable[[], Coroutine[Any, Any, Any]],
            ) -> None:
                try:
                    await operation()
                except Exception as exc:
                    failures.append((label, exc))

            if durable_store is not None:
                if (
                    durable_entry is not None
                    and durable_entry_was_auto_reset is not None
                ):
                    durable_entry.was_auto_reset = durable_entry_was_auto_reset
                await attempt(
                    "session routing override",
                    lambda: durable_store.set_model_override(
                        session_id, durable_override_snapshot
                    ),
                )
            if session_db is not None and session_db_id and session_db_row is not None:
                prior_db_model = session_db_row.get("model")
                await attempt(
                    "session database model",
                    lambda: session_db.update_session_model(
                        session_db_id, prior_db_model
                    ),
                )
                await attempt(
                    "session database metadata",
                    lambda: session_db.update_session_meta(
                        session_db_id,
                        session_db_row.get("model_config"),
                        prior_db_model,
                    ),
                )
                await attempt(
                    "session database system prompt",
                    lambda: session_db.update_system_prompt(
                        session_db_id, session_db_row.get("system_prompt")
                    ),
                )
            if failures:
                failed_surfaces = ", ".join(label for label, _error in failures)
                raise _TurnConfigurationError(
                    "Hermes could not fully roll back session configuration "
                    f"({failed_surfaces})"
                ) from failures[0][1]

        def release_detached_agent_cache() -> None:
            if not detached_agent_cache.existed:
                return
            restore_detached_agent_cache()
            evict = getattr(runner, "_evict_cached_agent", None)
            if not callable(evict):
                raise _TurnConfigurationError(
                    "This Hermes version cannot retire its prior cached agent"
                )
            evict(session_id)

        dispatched_configuration = False

        async def dispatch(command: str) -> None:
            nonlocal dispatched_configuration
            dispatched_configuration = True
            await handler(
                MessageEvent(
                    text=command,
                    message_type=MessageType.COMMAND,
                    source=source,
                    message_id=str(message["requestId"]),
                    metadata={"t3_control": "turn-configuration"},
                )
            )

        try:
            effective_model: dict[str, str] | None = None
            if model_request is not None:
                request_key, target = model_request
                if cache.get("modelRequest") == request_key:
                    try:
                        cached_effective = self._effective_model_selection(
                            runner, session_id
                        )
                    except _TurnConfigurationError:
                        cached_effective = None
                    if (
                        cached_effective == cache.get("modelEffective")
                        and cached_effective == target
                    ):
                        effective_model = cached_effective

                if effective_model is None:
                    command = (
                        f"/model {shlex.quote(target['model'])} "
                        f"--provider {shlex.quote(target['provider'])} --session"
                    )
                    try:
                        await dispatch(command)
                        effective_model = self._effective_model_selection(
                            runner, session_id
                        )
                    except Exception as exc:
                        if isinstance(exc, _TurnConfigurationError):
                            raise
                        raise _TurnConfigurationError(
                            "Hermes could not apply the requested session model"
                        ) from exc
                    if effective_model != target:
                        raise _TurnConfigurationError(
                            "Hermes resolved the requested model to a different selection"
                        )
                    cache["modelRequest"] = request_key
                    cache["modelEffective"] = dict(effective_model)
                applied["appliedModelSelection"] = dict(effective_model)

            if reasoning_effort is not None:
                reasoning_model = (
                    effective_model["model"]
                    if effective_model is not None
                    else self._current_effective_model(runner, session_id)
                )
                if cache.get("reasoningRequest") == reasoning_effort:
                    try:
                        cached_effort = self._effective_reasoning_effort(
                            runner,
                            session_id,
                            model=reasoning_model,
                        )
                    except _TurnConfigurationError:
                        cached_effort = None
                    if cached_effort == cache.get("reasoningEffective"):
                        applied_effort = cached_effort
                    else:
                        applied_effort = None
                else:
                    applied_effort = None

                if applied_effort is None:
                    try:
                        await dispatch(f"/reasoning {reasoning_effort}")
                        applied_effort = self._effective_reasoning_effort(
                            runner,
                            session_id,
                            model=reasoning_model,
                        )
                    except Exception as exc:
                        if isinstance(exc, _TurnConfigurationError):
                            raise
                        raise _TurnConfigurationError(
                            "Hermes could not apply the requested reasoning effort"
                        ) from exc
                    if applied_effort != reasoning_effort:
                        raise _TurnConfigurationError(
                            "Hermes resolved a different reasoning effort than requested"
                        )
                    cache["reasoningRequest"] = reasoning_effort
                    cache["reasoningEffective"] = applied_effort
                applied["appliedReasoningEffort"] = applied_effort

            if can_commit is not None and not can_commit():
                raise _TurnConfigurationError(
                    "The Hermes session stopped while its turn was starting"
                )
            if dispatched_configuration:
                release_detached_agent_cache()
            else:
                restore_detached_agent_cache()
            return applied
        except BaseException:
            # Hermes' slash handlers update several durable and in-memory
            # surfaces. If verification fails (or startup is cancelled), roll
            # all of them back before exposing the failed turn to T3.
            restore_prior_memory_configuration()
            try:
                await restore_prior_durable_configuration()
            finally:
                restore_detached_agent_cache()
            raise

    async def _start_turn(self, message: dict[str, Any]) -> None:
        thread_id = str(message["threadId"])
        session_id = self._sessions.get(thread_id)
        if (
            not session_id
            or session_id != str(message["sessionId"])
            or thread_id not in self._active_session_threads
        ):
            await self._send_frame(
                protocol_error(
                    "session-not-found",
                    "Call session.ensure before starting a turn.",
                    recoverable=True,
                    related_request_id=str(message["requestId"]),
                )
            )
            return
        if (
            thread_id in self._active_turns
            or thread_id in self._turn_start_reservations
        ):
            await self._send_frame(
                protocol_error(
                    "invalid-message",
                    "This Hermes session already has an active or starting turn; "
                    "use turn.steer.",
                    recoverable=True,
                    related_request_id=str(message["requestId"]),
                )
            )
            return
        reservation = _TurnStartReservation(session_id=session_id)
        self._turn_start_reservations[thread_id] = reservation

        def can_commit() -> bool:
            return (
                self._turn_start_reservations.get(thread_id) is reservation
                and not reservation.cancelled
                and self._sessions.get(thread_id) == session_id
                and thread_id in self._active_session_threads
                and thread_id not in self._active_turns
            )

        # Decode and materialize attachments BEFORE any turn state exists: a
        # malformed attachment raises ValueError into the correlated
        # `protocol.error` path with no half-started turn to clean up.
        #
        # Surfacing choice: the temp file paths ride the MessageEvent's own
        # `media_urls` / `media_types` fields — Hermes' structured channel for
        # exactly this (`gateway/platforms/base.py:1800`). The gateway's
        # enrichment pipeline then does everything a bundled platform gets:
        # vision routing for images, STT for voice, and path-pointing context
        # notes for documents (`gateway/run.py:12420+`). No prompt-text
        # injection is needed on this path.
        try:
            media_paths, media_types = _materialize_attachments(
                turn_attachments(message)
            )
            try:
                applied_configuration = await self._apply_turn_configuration(
                    message,
                    thread_id=thread_id,
                    session_id=session_id,
                    can_commit=can_commit,
                )
            except _TurnConfigurationError as exc:
                await self._send_frame(
                    protocol_error(
                        "invalid-message",
                        str(exc),
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
            # No await separates the final fence check in
            # _apply_turn_configuration from this registration.
            self._active_turns[thread_id] = turn
        finally:
            if self._turn_start_reservations.get(thread_id) is reservation:
                self._turn_start_reservations.pop(thread_id, None)
        # Roll the registration back if starting the turn raises. Without this
        # a failed `turn.started` send (a socket that dropped between the
        # decode and the write) leaves a phantom turn no completion path will
        # ever reach, and the `thread_id in self._active_turns` guard above
        # then rejects every future `turn.start` on this thread for the life of
        # the process. Guarded on identity: an error handler that already
        # replaced the entry owns it now, and clobbering that would strand the
        # replacement instead.
        try:
            await self._send_frame(
                frame(
                    "turn.started",
                    requestId=turn.request_id,
                    threadId=thread_id,
                    sessionId=session_id,
                    turnId=turn.turn_id,
                    **applied_configuration,
                )
            )
            await self._send_status()
            # session.stop can run while either frame above is awaiting I/O.
            # It owns the turn after popping it and must prevent a late call
            # into Hermes' agent pipeline.
            if (
                self._active_turns.get(thread_id) is not turn
                or thread_id not in self._active_session_threads
            ):
                if self._active_turns.get(thread_id) is turn:
                    self._active_turns.pop(thread_id, None)
                return
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
                    media_urls=media_paths,
                    media_types=media_types,
                )
            )
        except BaseException:
            if self._active_turns.get(thread_id) is turn:
                del self._active_turns[thread_id]
            raise

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
        # Attachments on a steer cannot ride `media_urls`: Hermes' `/steer`
        # handler injects only the command's text between tool iterations
        # (`gateway/run.py:11254`) and never reads the event's media fields.
        # The paths are appended to the injected text instead — mid-turn the
        # agent reaches files through its tools anyway, so a path note is the
        # natural (and only) channel here.
        steer_text = str(message["text"])
        media_paths, media_types = _materialize_attachments(
            turn_attachments(message)
        )
        for path, mime in zip(media_paths, media_types):
            steer_text += f"\n[The user attached a file ({mime}): {path}]"
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
                    text=f"/steer {steer_text}",
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
        correlation_id: str | None,
    ) -> SendResult | None:
        """Capture only the steering command's own acknowledgement.

        A steer targets a RUNNING turn, so Hermes can legitimately emit
        assistant output on the same thread while the steering command is
        still awaited. Matching on `chat_id` alone would swallow that output
        and drop it from the transcript, so the capture is keyed on the
        steering `requestId` the plugin stamped on the dispatched
        `MessageEvent` (and, for follow-up edits, on the synthetic control
        message id this method returns). Everything else falls through to the
        normal assistant-content path.
        """
        control = _steer_control_response.get()
        if control is None or control.thread_id != str(chat_id):
            return None
        if correlation_id is None:
            return None
        correlation = str(correlation_id)
        if correlation not in {control.request_id, control.control_message_id}:
            return None
        control.messages.append(str(content))
        return SendResult(success=True, message_id=control.control_message_id)

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
        reservation = self._turn_start_reservations.get(thread_id)
        if reservation is not None and reservation.session_id == session_id:
            reservation.cancelled = True
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
            turn.assistant_started = True
        if visible.startswith(turn.visible_text):
            delta = visible[len(turn.visible_text) :]
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
                turn.visible_text = visible
        elif visible != turn.visible_text:
            await self._send_frame(
                frame(
                    "content.snapshot",
                    threadId=turn.thread_id,
                    sessionId=turn.session_id,
                    turnId=turn.turn_id,
                    itemId=turn.message_id,
                    streamKind="assistant_text",
                    text=visible,
                    contentIndex=0,
                )
            )
            turn.visible_text = visible

    async def _complete_turn(self, turn: _TurnState) -> None:
        if self._active_turns.get(turn.thread_id) is not turn:
            return
        # Close the live status line BEFORE the assistant message.
        #
        # T3 orders the timeline by item timestamp and folds a settled turn's
        # activity behind the "Worked for …" row — but only the entries that
        # precede the turn's terminal assistant message. Completing the status
        # item after that message stamped it milliseconds later, so it sorted
        # below the answer, escaped the fold, and rendered as a stray "Work
        # Log" section under the reply instead of joining the collapsed
        # activity above it.
        async with turn.generic_activity_lock:
            if self._active_turns.get(turn.thread_id) is not turn:
                return
            if turn.generic_activity_id is not None:
                await self._send_frame(
                    frame(
                        "item.completed",
                        threadId=turn.thread_id,
                        sessionId=turn.session_id,
                        turnId=turn.turn_id,
                        itemId=turn.generic_activity_id,
                        itemType=_STATUS_ITEM_TYPE,
                        status="completed",
                        title="Hermes activity",
                        **(
                            {"detail": turn.generic_activity_detail}
                            if turn.generic_activity_detail
                            else {}
                        ),
                    )
                )
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
        async with turn.generic_activity_lock:
            if self._active_turns.get(turn.thread_id) is not turn:
                return
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
            # Remembered for media scoping: the base adapter sends a reply's
            # media files AFTER its notify-marked text, i.e. after this point.
            # The stamp bounds that reach-back — see `_media_turn_scope`.
            turn.completed_at = time.monotonic()
            self._recent_turns[turn.thread_id] = turn
        await self._send_status()

    async def _emit_generic_activity(self, turn: _TurnState, detail: str) -> None:
        if not detail:
            return
        normalized_detail = str(detail)[:2_000]
        async with turn.generic_activity_lock:
            if self._active_turns.get(turn.thread_id) is not turn:
                return
            if turn.generic_activity_detail == normalized_detail:
                return
            activity_id = turn.generic_activity_id
            if activity_id is None:
                activity_id = item_id()
                event_type = "item.started"
            else:
                event_type = "item.updated"
            await self._send_frame(
                frame(
                    event_type,
                    threadId=turn.thread_id,
                    sessionId=turn.session_id,
                    turnId=turn.turn_id,
                    itemId=activity_id,
                    itemType=_STATUS_ITEM_TYPE,
                    status="inProgress",
                    title="Hermes activity",
                    detail=normalized_detail,
                )
            )
            turn.generic_activity_id = activity_id
            turn.generic_activity_detail = normalized_detail

    def _turn_for_tool_hook(self, session_id: str) -> _TurnState | None:
        """Resolve the active turn a tool hook belongs to.

        The tool hooks' `session_id` is NOT this plugin's session id. Hermes
        passes `agent.session_id` (`agent/tool_executor.py:188`, `:305`,
        `:341`), which the gateway sets to `SessionEntry.session_id` — a
        timestamped run id like `20260725_143012_ab12cd34`
        (`gateway/session.py:2388`, `agent/agent_init.py:1446-1453`). This
        plugin's session ids come from `build_session_key`
        (`gateway/session.py:1029`), shaped `agent:main:t3:dm:<thread>`. The two
        never match, so `_thread_by_session` alone silently drops every tool
        activity item.

        The gateway's stable routing key is available separately: it is bound
        onto `HERMES_SESSION_KEY` for the turn's context
        (`gateway/run.py:17367` → `gateway/session_context.py:200`) and
        propagated into the tool worker threads
        (`agent/tool_executor.py:715`, `propagate_context_to_thread`). That key
        IS `build_session_key(...)`, so it matches `_thread_by_session`.

        Resolution order, all best-effort:
          1. `session_id` as a direct routing key (correct if a future Hermes
             passes the gateway key here, and free to check).
          2. `HERMES_SESSION_KEY` from the Hermes session context.
          3. The sole active turn, when exactly one exists — a single-threaded
             Hermes process has no ambiguity to resolve, and dropping the
             activity would be strictly worse. **Cron runs are excluded from
             this step** (see below).
        Anything unresolved returns `None` and the item is simply not emitted;
        tool activity is decorative, so this must never raise or misroute.

        The cron exclusion: these hooks are process-global, so a cron job
        running tools while exactly one T3 turn happens to be live would
        resolve through the sole-turn fallback and paint the cron job's tool
        calls into an unrelated live conversation. Cron runs are identifiable —
        the scheduler builds its agent with
        `session_id=f"cron_{job_id}_{timestamp}"` (`cron/scheduler.py:3017`,
        passed at `:3484`), which is exactly the value these hooks receive as
        `session_id`. Upstream treats the same routing hazard as real: the
        scheduler deliberately clears the process-global session env vars for
        it (`cron/scheduler.py:3066-3091`). A cron job's activity belongs to
        the eventual `home.deliver`, never to a live turn, so it is dropped
        rather than guessed at.
        """
        thread_id = self._thread_by_session.get(str(session_id))
        if thread_id is None:
            thread_id = self._thread_by_session.get(self._gateway_session_key())
        if thread_id is not None:
            return self._active_turns.get(thread_id)
        if self._is_cron_session(session_id):
            return None
        if len(self._active_turns) == 1:
            return next(iter(self._active_turns.values()))
        return None

    @staticmethod
    def _is_cron_session(session_id: str) -> bool:
        """True when this hook call belongs to a cron run, not a gateway turn.

        Keyed on the `cron_` prefix the scheduler mints at
        `cron/scheduler.py:3017`. Matching a prefix rather than an exported
        constant carries the usual drift risk: if upstream renames the shape,
        this degrades to today's behaviour (cron tool rows may again be
        misattributed to a sole live turn) rather than breaking anything.
        """
        return str(session_id or "").startswith("cron_")

    @staticmethod
    def _gateway_session_key() -> str:
        """Read the turn's gateway routing key from Hermes' session context.

        Returns `""` on any failure (older Hermes, no context bound, import
        error) so callers fall through to their next resolution step.
        """
        try:
            from gateway.session_context import get_session_env

            return str(get_session_env("HERMES_SESSION_KEY", "") or "")
        except Exception:  # noqa: BLE001 - decorative activity must not raise
            return ""

    def emit_tool_started(
        self,
        session_id: str,
        tool_name: str,
        args: dict[str, Any],
        tool_call_id: str = "",
    ) -> None:
        turn = self._turn_for_tool_hook(session_id)
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
        turn = self._turn_for_tool_hook(session_id)
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

    def _schedule(self, coroutine: Coroutine[Any, Any, Any]) -> None:
        """Run a coroutine on the adapter's bound loop from any thread.

        Hermes calls the tool hooks from the agent thread, so this is the
        boundary back onto the gateway loop. `create_task` is only valid when
        the *running* loop is the adapter's own loop — checking merely for "a
        loop is running" would schedule onto whichever unrelated loop happens
        to be current. Created tasks are held in a strong-reference set (asyncio
        only holds a weak one) and their exceptions are logged rather than
        surfacing as bare "task exception was never retrieved" warnings.
        """
        loop = self._event_loop
        if loop is None or loop.is_closed():
            coroutine.close()
            return
        try:
            running_loop: asyncio.AbstractEventLoop | None = asyncio.get_running_loop()
        except RuntimeError:
            running_loop = None
        if running_loop is loop:
            task = loop.create_task(coroutine)
            self._scheduled_tasks.add(task)
            task.add_done_callback(self._finish_scheduled_task)
            return
        try:
            asyncio.run_coroutine_threadsafe(coroutine, loop)
        except RuntimeError:  # loop closed between the check and the submit
            coroutine.close()

    def _finish_scheduled_task(self, task: asyncio.Task[Any]) -> None:
        self._scheduled_tasks.discard(task)
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            logger.error("T3 gateway background task failed: %s", error, exc_info=error)


def check_requirements() -> bool:
    return dependency_available()


def validate_config(config: PlatformConfig) -> bool:
    extra = getattr(config, "extra", {}) or {}
    return (
        bool(extra.get("url") or os.environ.get(URL_ENV, ""))
        and bool(extra.get("instance_id") or os.environ.get(INSTANCE_ID_ENV, ""))
        and bool(extra.get("credential") or os.environ.get(CREDENTIAL_ENV, ""))
    )


def env_enablement() -> dict[str, Any] | None:
    """Seed `PlatformConfig.extra` from the environment at config-load time.

    Called by the platform registry's env-enablement hook before the adapter is
    constructed, so `gateway status` and `get_connected_platforms()` reflect an
    env-only enrollment without instantiating a connection.

    `home_channel` is a **magic key**, not an ordinary extra: core pops it out
    of the returned dict and promotes it to a real `HomeChannel` dataclass on
    the `PlatformConfig` (`gateway/config.py:2648-2660`, reading only
    `chat_id` / `name` / `thread_id`). That promotion is what makes
    `get_home_channel("t3")` resolve, which is in turn what makes
    `send_message` with a bare `t3` target, the gateway's lifecycle broadcasts,
    and `/handoff t3` work at all — core hardcodes env promotion only for
    built-in platforms, so a plugin must supply it here. Pattern copied from
    IRC (`plugins/platforms/irc/adapter.py:653-701`).

    The thread id comes from `T3_HOME_CHANNEL`, which T3 owns: the plugin
    rewrites it from `homeThreadId` on every `connection.accepted`. Before the
    first accept there is nothing to seed and the key is simply absent — Hermes
    then behaves exactly as it did pre-home-channel, which is why the
    `/sethome` nudge suppression is still needed for that window.
    """
    url = os.environ.get(URL_ENV, "").strip()
    instance_id = os.environ.get(INSTANCE_ID_ENV, "").strip()
    credential = os.environ.get(CREDENTIAL_ENV, "").strip()
    if not (url and instance_id and credential):
        return None
    seed: dict[str, Any] = {
        "url": url,
        "instance_id": instance_id,
        "credential": credential,
        "nickname": os.environ.get(NICKNAME_ENV, "").strip() or "Hermes",
    }
    home = os.environ.get(HOME_CHANNEL_ENV, "").strip()
    if home:
        # T3 threads are the addressing unit end to end: `chat_id` IS the
        # thread id, and the separate `thread_id` field stays unset. Setting
        # both would make Hermes route `chat_id` + `thread_id` metadata at a
        # platform whose `send(chat_id, ...)` already resolves the thread.
        seed["home_channel"] = {"chat_id": home, "name": "Home"}
    return seed

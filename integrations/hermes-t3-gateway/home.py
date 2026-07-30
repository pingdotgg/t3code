"""Home-channel delivery: durable queue, classification, standalone sender.

Hermes-initiated output — cron results, the agent's `send_message` tool with a
bare `t3` target, gateway lifecycle notices, `/handoff t3` — has no T3-issued
turn to stream into. It is delivered as a `home.deliver` frame against the
instance's durable **home thread**, whose id T3 owns and republishes on every
`connection.accepted`.

Three concerns live here rather than in the adapter:

* **The durable queue.** A delivery is written to disk before it is sent and
  removed only when T3 acknowledges it, so nothing is lost when either side
  restarts mid-flight. T3 dedupes on `deliveryId`, which is what makes
  re-flushing the whole queue safe.
* **Kind/label classification.** Best-effort provenance recovery from the send
  context — see `classify_delivery`.
* **The standalone sender.** Out-of-process cron has no live adapter, so it
  dials T3 itself over a short-lived `role: "delivery"` socket.
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import threading
from pathlib import Path
from typing import Any

from .protocol import (
    HOME_DELIVERY_KINDS,
    delivery_id,
    home_deliver,
    iso_now,
    media_deliver,
)

logger = logging.getLogger(__name__)

try:  # POSIX advisory locking; absent on Windows.
    import fcntl
except ImportError:  # pragma: no cover - Windows fallback
    fcntl = None  # type: ignore[assignment]

# The env var carrying T3's home-thread designation.
#
# The name is NOT arbitrary. Hermes resolves a platform's cron home target with
# `_home_target_env_var` (`gateway/run.py:1541`), which falls back to
# `f"{PLATFORM.upper()}_HOME_CHANNEL"` for any platform without an override
# entry. Platform `t3` therefore resolves to exactly this string, so the
# `send_message` error hints, `/sethome` messaging, and cron's env-only
# resolution path all agree with the value the plugin writes — with no upstream
# override table entry required.
HOME_CHANNEL_ENV = "T3_HOME_CHANNEL"

# Queue location. `gateway/` under the Hermes home is the subdirectory Hermes'
# own bundled plugins use for per-profile adapter state (the Discord adapter's
# command-sync and non-conversational stores, `plugins/platforms/discord/
# adapter.py:52`, `:272`, `:1694`). Using `get_hermes_home()` as the base means
# the queue is profile-scoped for free: a second profile with its own
# `HERMES_HOME` gets its own queue rather than replaying another profile's
# deliveries into its own home thread.
QUEUE_SUBDIR = "gateway"
QUEUE_FILENAME = "t3_home_delivery_queue.jsonl"

# Bound the queue. Deliveries are small (a cron brief, a lifecycle line), so a
# few hundred is generous for any realistic outage while keeping the file
# readable and the flush bounded. Overflow drops the OLDEST entries: a
# fortnight-old cron brief is worth less than this morning's, and dropping
# newest would make a wedged queue permanently swallow current output.
MAX_QUEUE_ENTRIES = 300

# Bound one flush attempt. A reconnect must not spend minutes replaying before
# the connection is usable for live traffic; the remainder rides the next
# reconnect.
MAX_FLUSH_PER_CONNECT = 50


def hermes_home() -> Path:
    """Resolve Hermes' home directory, degrading to the documented default.

    Prefers Hermes' own accessor so a context-local profile override
    (`set_hermes_home_override`) is honoured, then `HERMES_HOME`, then the
    platform default. The plugin must not create state outside the active
    profile, but it also must not fail to queue a delivery merely because
    Hermes could not be imported (the standalone cron path can run in a very
    thin process).
    """
    try:
        from hermes_cli.config import get_hermes_home

        return Path(get_hermes_home())
    except Exception:  # noqa: BLE001 - queueing must never depend on Hermes importing
        pass
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:  # noqa: BLE001 - same
        pass
    override = os.environ.get("HERMES_HOME", "").strip()
    return Path(override) if override else Path.home() / ".hermes"


def queue_path() -> Path:
    return hermes_home() / QUEUE_SUBDIR / QUEUE_FILENAME


def home_thread_id() -> str:
    """Read the currently designated home thread from the environment."""
    return os.environ.get(HOME_CHANNEL_ENV, "").strip()


def save_home_thread_id(thread_id: str) -> bool:
    """Persist T3's home designation, mirroring it into this process.

    T3's settings blob is authoritative and this env var is a synced cache, so
    a differing local value is overwritten rather than merged — including one a
    user hand-edited (documented in the plugin README).

    Returns True when the value was durably written. A read-only or managed
    `.env` degrades to the in-process mirror only: routing works for the life
    of this gateway and re-reconciles on the next connect.
    """
    value = str(thread_id or "").strip()
    if not value:
        return False
    saved = False
    try:
        from hermes_cli.config import save_env_value

        save_env_value(HOME_CHANNEL_ENV, value)
        saved = True
    except Exception as exc:  # noqa: BLE001 - a read-only .env must not break the handshake
        # No stack trace: outside a Hermes install this is simply
        # ModuleNotFoundError for hermes_cli, which is expected and noisy.
        logger.warning(
            "Could not persist %s (%s); T3 home delivery will use the "
            "in-process value until the next reconnect",
            HOME_CHANNEL_ENV,
            exc,
        )
    # Mirror into this process exactly as enrollment does (`cli.py`): the
    # running gateway resolves the home channel from the environment and must
    # not need a restart to see a freshly designated thread.
    os.environ[HOME_CHANNEL_ENV] = value
    return saved


class HomeDeliveryQueue:
    """Append-only JSONL outbox of unacknowledged delivery frames.

    Entries are stored as raw wire frames keyed on `deliveryId`, so the queue
    carries `home.deliver` and `media.deliver` alike: flushing replays the
    frame verbatim and T3 discriminates on `type`. A media entry is large (up
    to ~34MB of base64 on one line), so the entry cap doubles as a coarse disk
    bound; a genuinely wedged connection under heavy media output trades disk
    for durability, which is the documented preference.

    Correctness rests on one rule: an entry is removed **only** when T3 acks
    its `deliveryId`. Everything else — a socket that dropped mid-send, a
    server that died before writing, a plugin that restarted — leaves the entry
    on disk to be replayed. Replay is safe because T3 dedupes on `deliveryId`,
    so the failure mode of this design is a duplicate suppressed server-side,
    never a lost delivery.

    Two processes can hold the same queue: the gateway adapter and an
    out-of-process cron run using the standalone sender. Writes take a POSIX
    advisory lock on a sidecar file where `fcntl` is available; on Windows the
    in-process lock alone applies and a concurrent cron process could in
    principle interleave a rewrite. The consequence there is a duplicate
    delivery (deduped by T3), not corruption of an already-acked entry.
    """

    def __init__(self, path: Path | None = None, max_entries: int = MAX_QUEUE_ENTRIES):
        self._path = Path(path) if path is not None else None
        self._max_entries = max(1, int(max_entries))
        self._lock = threading.RLock()

    @property
    def path(self) -> Path:
        # Resolved lazily, not in __init__: `get_hermes_home()` honours a
        # context-local profile override that may be installed after the
        # adapter is constructed.
        return self._path if self._path is not None else queue_path()

    def _ensure_parent(self) -> None:
        # 0700: queued frames carry message text and base64 media, so the
        # outbox must not be readable by other users of the machine. Only a
        # directory this call creates is affected — an existing `gateway/` is
        # shared with Hermes' own plugin state and is not re-permissioned here.
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)

    def _read_lines(self) -> list[dict[str, Any]]:
        """Parse every queued entry. Raises `OSError` when the file is unreadable.

        The distinction callers depend on: a MISSING file is an empty queue,
        while an unreadable one is an unknown queue. Collapsing the two into
        `[]` is what would let a rewrite-based caller overwrite live entries it
        merely failed to read.
        """
        path = self.path
        if not path.exists():
            return []
        entries: list[dict[str, Any]] = []
        raw = path.read_text(encoding="utf-8")
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                # A torn write from a killed process. Skip the line rather than
                # discarding the whole queue.
                continue
            if isinstance(entry, dict) and entry.get("deliveryId"):
                entries.append(entry)
        return entries

    @staticmethod
    def _encode(entry: dict[str, Any]) -> str:
        return json.dumps(entry, separators=(",", ":"), ensure_ascii=False) + "\n"

    def _write_all(self, entries: list[dict[str, Any]]) -> None:
        self._ensure_parent()
        payload = "".join(self._encode(entry) for entry in entries)
        temporary = self.path.with_suffix(".jsonl.tmp")
        # 0600 on the TEMP file, before the replace: `os.replace` carries the
        # source's mode over, so permissioning here is what makes the queue
        # private without a window where it is world-readable.
        descriptor = os.open(
            temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(payload)
        os.chmod(temporary, 0o600)  # A pre-existing temp file keeps its mode.
        temporary.replace(self.path)

    def _append_line(self, entry: dict[str, Any]) -> None:
        """Append one entry without reading or rewriting the file.

        The fallback when the queue could not be read: a single `O_APPEND`
        write cannot destroy entries it cannot see, where the rewrite path
        would replace all of them with this one.
        """
        self._ensure_parent()
        descriptor = os.open(
            self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600
        )
        with os.fdopen(descriptor, "a", encoding="utf-8") as handle:
            handle.write(self._encode(entry))

    def _file_lock(self):
        """Advisory cross-process lock, or a no-op where unavailable."""

        class _NoLock:
            def __enter__(self):
                return None

            def __exit__(self, *args):
                return False

        if fcntl is None:
            return _NoLock()

        queue = self.path
        try:
            queue.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        except OSError:
            return _NoLock()

        class _FileLock:
            def __init__(self, lock_path: Path):
                self._lock_path = lock_path
                self._handle: Any = None

            def __enter__(self):
                try:
                    # 0600 like the queue itself: the sidecar carries no
                    # payload, but a world-writable lock is a way to stall
                    # another user's deliveries.
                    descriptor = os.open(
                        self._lock_path, os.O_RDWR | os.O_CREAT, 0o600
                    )
                    self._handle = os.fdopen(descriptor, "a+")
                    fcntl.flock(self._handle, fcntl.LOCK_EX)
                except OSError:
                    if self._handle is not None:
                        self._handle.close()
                    self._handle = None
                return None

            def __exit__(self, *args):
                if self._handle is not None:
                    try:
                        fcntl.flock(self._handle, fcntl.LOCK_UN)
                    finally:
                        self._handle.close()
                        self._handle = None
                return False

        return _FileLock(queue.with_suffix(".jsonl.lock"))

    def append(self, frame: dict[str, Any]) -> bool:
        """Persist one delivery. Returns False when it could not be written."""
        if not isinstance(frame, dict) or not frame.get("deliveryId"):
            return False
        with self._lock, self._file_lock():
            try:
                entries = self._read_lines()
            except OSError:
                # The rewrite path is off the table: it would replace every
                # entry we failed to read with just this one, destroying an
                # arbitrary number of unacked deliveries over a transient
                # error. Append blind instead. The costs are bounded and both
                # self-correct — the cap goes unenforced until the next
                # successful read (a too-long queue is trimmed then), and a
                # duplicate of an entry already on disk is deduped by T3 on
                # `deliveryId`.
                logger.warning(
                    "Could not read the T3 home delivery queue at %s; appending "
                    "without rewriting it",
                    self.path,
                    exc_info=True,
                )
                try:
                    self._append_line(dict(frame))
                except OSError:
                    logger.error(
                        "Could not persist a T3 home delivery to %s",
                        self.path,
                        exc_info=True,
                    )
                    return False
                return True
            if any(
                entry.get("deliveryId") == frame["deliveryId"] for entry in entries
            ):
                return True
            entries.append(dict(frame))
            dropped = len(entries) - self._max_entries
            if dropped > 0:
                logger.warning(
                    "T3 home delivery queue is full (%d entries); dropping the "
                    "%d oldest undelivered %s",
                    self._max_entries,
                    dropped,
                    "delivery" if dropped == 1 else "deliveries",
                )
                entries = entries[dropped:]
            try:
                self._write_all(entries)
            except OSError:
                logger.error(
                    "Could not persist a T3 home delivery to %s",
                    self.path,
                    exc_info=True,
                )
                return False
        return True

    def entries(self) -> list[dict[str, Any]]:
        """Every unacknowledged delivery, oldest first.

        An unreadable queue reports empty rather than raising: the callers are
        the flush loop and `__len__`, and skipping a flush cycle costs one
        reconnect's delay while the entries stay on disk.
        """
        with self._lock:
            try:
                return self._read_lines()
            except OSError:
                logger.warning(
                    "Could not read the T3 home delivery queue at %s",
                    self.path,
                    exc_info=True,
                )
                return []

    def purge(self, delivery_id_value: str) -> bool:
        """Remove one acknowledged delivery. Returns True when it was present."""
        target = str(delivery_id_value or "").strip()
        if not target:
            return False
        with self._lock, self._file_lock():
            try:
                entries = self._read_lines()
            except OSError:
                # Purge only ever rewrites, so an unreadable queue means doing
                # nothing. The entry stays and is replayed once — harmless,
                # because T3 acked it and therefore dedupes the replay.
                logger.warning(
                    "Could not read the T3 home delivery queue at %s to purge "
                    "%s; it will be replayed and deduped",
                    self.path,
                    target,
                    exc_info=True,
                )
                return False
            remaining = [
                entry for entry in entries if entry.get("deliveryId") != target
            ]
            if len(remaining) == len(entries):
                return False
            try:
                self._write_all(remaining)
            except OSError:
                logger.error(
                    "Could not purge acknowledged T3 home delivery %s from %s",
                    target,
                    self.path,
                    exc_info=True,
                )
                return False
        return True

    def __len__(self) -> int:
        return len(self.entries())


# ── classification ────────────────────────────────────────────────────────

# Hermes' lifecycle broadcasts, matched by their literal shapes at 62e07223.
# These are inline f-strings upstream, not exported constants, so the same
# drift risk documented for the `/sethome` notice applies: a wording change
# upstream downgrades these to `kind: "message"`, which costs a badge and a
# quiet-delivery classification, never the delivery itself.
_LIFECYCLE_EXACT = frozenset(
    {
        # gateway/run.py:17277
        "♻️ Gateway online — Hermes is back and ready.",
        # gateway/run.py:17236
        "♻ Gateway restarted successfully. Your session continues.",
    }
)
_LIFECYCLE_PREFIXES = (
    # gateway/run.py:6599 — f"⚠️ Gateway {action} — {hint}"
    "⚠️ Gateway restarting — ",
    "⚠️ Gateway shutting down — ",
)

# cron/scheduler.py:1513 builds this header when `cron.wrap_response` is on
# (the default).
_CRON_HEADER = "Cronjob Response: "

# gateway/run.py:8854 — the handoff destination's synthetic source identity.
_HANDOFF_USER_ID = "system:handoff"


def classify_delivery(
    content: str,
    metadata: dict[str, Any] | None = None,
    *,
    session_user_id: str = "",
) -> tuple[str, str, bool]:
    """Best-effort `(kind, label, provenance_certain)` for a proactive send.

    Hermes' `adapter.send()` contract carries no structured "this is a cron
    delivery" marker on every path, so this reads the signals that do exist:

    * **`metadata["job_id"]`** — the cron scheduler stamps it into the routed
      metadata for every live-gateway delivery (`cron/scheduler.py:1782`), and
      `DeliveryRouter._deliver_to_platform` passes that dict through to
      `adapter.send` unchanged (`gateway/delivery.py:606`). This is the
      strongest signal available and the only structured one.
    * **The cron wrap header** — `cron.wrap_response` (default on) prefixes the
      brief with `Cronjob Response: <name>` (`cron/scheduler.py:1513`), which
      also supplies a human job name for the badge.
    * **Lifecycle literals** — the gateway's online/restart/shutdown notices.
    * **The bound session identity** — `/handoff` dispatches its synthetic turn
      under `user_id="system:handoff"` (`gateway/run.py:8854`), bound onto the
      session context by `_set_session_env` (`gateway/run.py:17372`).

    The third element reports whether provenance was *positively* established.
    The adapter uses it as the tiebreaker when a live turn exists in the home
    thread: only a positively-identified proactive send may bypass that turn,
    so an unclassifiable send can never steal a user's answer.

    Worst case for the first two elements is a wrong badge, never a lost
    delivery — an unrecognised send is `("message", "Hermes", False)`.
    """
    text = str(content or "")
    meta = metadata or {}

    job_id = str(meta.get("job_id") or "").strip()
    job_name = _cron_job_name(text)
    if job_id or job_name:
        label = f"Cron: {job_name or job_id}"
        return "cron", label, True

    stripped = text.strip()
    if stripped in _LIFECYCLE_EXACT or stripped.startswith(_LIFECYCLE_PREFIXES):
        return "lifecycle", "Gateway", True

    if str(session_user_id or "").strip() == _HANDOFF_USER_ID:
        return "handoff", "Handoff", True

    return "message", "Hermes", False


def _cron_job_name(text: str) -> str:
    """Recover the job name from the cron wrap header, if present."""
    first_line = text.lstrip().split("\n", 1)[0]
    if not first_line.startswith(_CRON_HEADER):
        return ""
    return first_line[len(_CRON_HEADER) :].strip()


def build_delivery(
    *,
    thread_id: str,
    text: str,
    kind: str = "message",
    label: str = "Hermes",
    created_at: str | None = None,
) -> dict[str, Any]:
    """Mint one `home.deliver` frame, id and timestamp included.

    `createdAt` is stamped here — when Hermes produced the content — not when
    the frame reaches T3, so a delivery flushed after a two-hour outage still
    reports the moment it was written.
    """
    normalized_kind = kind if kind in HOME_DELIVERY_KINDS else "other"
    return home_deliver(
        delivery_id_value=delivery_id(),
        thread_id=thread_id,
        kind=normalized_kind,
        label=label,
        text=text,
        created_at=created_at or iso_now(),
    )


def build_media_delivery(
    *,
    thread_id: str,
    path: str,
    kind: str = "message",
    label: str = "Hermes",
    turn_id: str | None = None,
    caption: str | None = None,
    name: str | None = None,
    created_at: str | None = None,
) -> dict[str, Any]:
    """Mint one `media.deliver` frame from a local file, id and timestamp included.

    Reads the file eagerly so the queued copy is self-contained: Hermes' media
    files live in temp/cache directories that may be gone by the time a queued
    delivery flushes after an outage, and a queue entry pointing at a dead path
    would be unsendable forever. `createdAt` is stamped here for the same
    reason as `build_delivery`.

    Raises `OSError` when the file cannot be read and `ValueError` when it is
    empty or over the 25MB wire ceiling — the caller decides whether that is a
    logged skip (adapter) or a reported error (standalone sender).
    """
    file_path = Path(path)
    data = file_path.read_bytes()
    display_name = str(name or "").strip() or file_path.name
    mime, _encoding = mimetypes.guess_type(display_name)
    return media_deliver(
        delivery_id_value=delivery_id(),
        thread_id=thread_id,
        kind=kind if kind in HOME_DELIVERY_KINDS else "other",
        label=label,
        name=display_name,
        mime_type=mime or "application/octet-stream",
        data=data,
        turn_id=turn_id,
        caption=caption,
        created_at=created_at or iso_now(),
    )


# ── standalone (out-of-process) sender ────────────────────────────────────


async def standalone_send(
    pconfig: Any,
    chat_id: str,
    message: str,
    *,
    thread_id: str | None = None,
    media_files: list[str] | None = None,
    force_document: bool = False,
) -> dict[str, Any]:
    """Deliver to the home thread with no live gateway adapter in this process.

    Registered as `standalone_sender_fn` and called by
    `tools/send_message_tool._send_via_adapter` when the in-process adapter
    weakref is empty — the `hermes cron` process running separately from
    `hermes gateway`. Without it, `deliver=t3` cron jobs fail with "No live
    adapter for platform".

    The socket announces `role: "delivery"`. That is load-bearing: T3's broker
    registers a `gateway` connection under generation fencing and displaces the
    previous one, so a naive cron dial-in would kick the live gateway socket
    off its own instance mid-turn. A `delivery` connection is authenticated
    identically, never becomes the primary, and is expected to close promptly.

    A connection failure is **not** a cron failure. The delivery is already on
    disk before the socket is opened, so the job reports success-with-queued
    and the live gateway flushes it on its next `connection.accepted`.

    `media_files` rides the v4+ wire as one `media.deliver` frame per file
    (upstream passes `(path, is_voice)` tuples; bare path strings are accepted
    too). A file that cannot be read or exceeds the 25MB frame ceiling is
    reported in `detail` and skipped — never queued, because a queued frame
    that T3 will always reject would sit in the outbox forever. `force_document`
    remains signature parity only: T3 derives rendering from `mimeType`, so
    there is no document/photo distinction to force.

    Every success result carries additive accounting keys alongside the
    unchanged `message_id`: `delivery_ids` (every frame this call minted, text
    and media), `media_count`, `acked_count`, and — when media was sent — a
    `note` naming the delivered file count. Upstream consumers read this dict by
    specific key and otherwise `json.dumps` it wholesale, so extra keys are
    inert there while giving an agent reading the tool output direct evidence
    against core's unconditional "MEDIA attachments were omitted" warning.
    """
    del force_document

    extra = getattr(pconfig, "extra", None) or {}

    def _setting(key: str, env: str) -> str:
        return str(extra.get(key) or os.environ.get(env, "") or "").strip()

    url = _setting("url", "HERMES_T3_GATEWAY_URL")
    instance_id = _setting("instance_id", "HERMES_T3_GATEWAY_INSTANCE_ID")
    credential = _setting("credential", "HERMES_T3_GATEWAY_CREDENTIAL")
    if not (url and instance_id and credential):
        return {
            "error": (
                "T3 standalone send: this Hermes is not enrolled. Run "
                "`hermes t3 connect --url <url> --token <token>` first."
            )
        }

    target = str(chat_id or "").strip() or str(thread_id or "").strip()
    if not target:
        target = home_thread_id()
    if not target:
        return {
            "error": (
                "T3 standalone send: no home thread is designated. Start "
                "`hermes gateway` once so T3 can publish one."
            )
        }

    kind, label, _certain = classify_delivery(message, None)
    frames: list[dict[str, Any]] = []
    media_ids: list[str] = []
    skipped: list[str] = []
    # The text frame is skipped only when media makes the send non-empty
    # anyway; a bare text send keeps today's behaviour (empty text normalizes
    # inside `home_deliver`).
    if str(message or "").strip() or not media_files:
        frames.append(
            build_delivery(thread_id=target, text=message, kind=kind, label=label)
        )
    for entry in media_files or []:
        media_path = entry[0] if isinstance(entry, (tuple, list)) else entry
        try:
            media_frame = build_media_delivery(
                thread_id=target,
                path=str(media_path),
                kind=kind,
                label=label,
            )
        except Exception as exc:  # noqa: BLE001 - one bad file must not sink the send
            # Never queued: a frame T3 will always reject (unreadable then,
            # oversized forever) would otherwise sit in the outbox for good.
            logger.warning(
                "T3 standalone send skipping media file %s: %s", media_path, exc
            )
            skipped.append(f"{media_path}: {exc}")
        else:
            frames.append(media_frame)
            media_ids.append(str(media_frame["deliveryId"]))
    if not frames:
        return {
            "error": "T3 standalone send: no deliverable content "
            + "; ".join(skipped)
        }
    delivery = str(frames[0]["deliveryId"])
    all_ids = [str(frame["deliveryId"]) for frame in frames]

    def _observed(
        result: dict[str, Any], acked_ids: set[str], *, queued_only: bool
    ) -> dict[str, Any]:
        """Attach the additive delivery-accounting keys to a success result.

        `message_id` is deliberately untouched — upstream reads that key by
        name. Everything here is new, and exists as **counter-evidence**: core
        appends a hard-coded "MEDIA attachments were omitted for t3" warning to
        any successful generic-path send (`tools/send_message_tool.py:1108` @
        v0.19.0) without ever asking whether the sender delivered them. The
        `coreshim` module strips that warning when it can, but if it has failed
        open the numbers below still sit in the same JSON blob the agent reads,
        so "2 media file(s) delivered and acknowledged" contradicts the stale
        warning directly rather than leaving the agent to guess.
        """
        acked_media = [entry for entry in media_ids if entry in acked_ids]
        result["delivery_ids"] = list(all_ids)
        result["media_count"] = len(media_ids)
        result["acked_count"] = len(acked_ids)
        if media_ids:
            verb = "queued for delivery" if queued_only else "delivered"
            count = len(media_ids) if queued_only else len(acked_media)
            note = f"{count} media file(s) {verb}"
            if not queued_only:
                note += " and acknowledged"
            existing = str(result.get("note") or "").strip()
            result["note"] = f"{existing}; {note}" if existing else note
        return result

    queue = HomeDeliveryQueue()
    queued = all(queue.append(frame) for frame in frames)

    try:
        acked = await _deliver_over_short_lived_socket(
            url=url,
            instance_id=instance_id,
            credential=credential,
            frames=frames,
        )
    except Exception as exc:  # noqa: BLE001 - cron delivery must not raise
        logger.debug("T3 standalone send raised", exc_info=True)
        if queued:
            return _observed(
                {
                    "success": True,
                    "message_id": delivery,
                    "queued": True,
                    "detail": f"T3 unreachable ({exc}); queued for the next connect",
                },
                set(),
                queued_only=True,
            )
        return {"error": f"T3 standalone send failed: {exc}"}

    for acked_id in acked:
        queue.purge(acked_id)
    result_detail = "; ".join(f"skipped {entry}" for entry in skipped)
    if len(acked) == len(frames):
        result: dict[str, Any] = {"success": True, "message_id": delivery}
        if result_detail:
            result["detail"] = result_detail
        return _observed(result, acked, queued_only=False)
    if queued:
        return _observed(
            {
                "success": True,
                "message_id": delivery,
                "queued": True,
                "detail": (
                    "T3 did not acknowledge every delivery; queued for retry"
                    + (f" ({result_detail})" if result_detail else "")
                ),
            },
            acked,
            queued_only=len(acked) == 0,
        )
    return {"error": "T3 standalone send: the delivery was neither acked nor queued"}


async def _deliver_over_short_lived_socket(
    *,
    url: str,
    instance_id: str,
    credential: str,
    frames: list[dict[str, Any]],
    timeout: float = 20.0,
) -> set[str]:
    """Open, authenticate as `delivery`, send, await the acks, close.

    Returns the set of `deliveryId`s T3 acknowledged (`home.deliver.ack` and
    `media.deliver.ack` are equivalent here). A timeout returns whatever was
    acked so far — the caller purges exactly those and leaves the rest queued.
    """
    import asyncio

    from .connection import _open_socket, authenticate_socket

    hermes_version = _hermes_version()
    expected = {str(frame["deliveryId"]) for frame in frames}
    acked: set[str] = set()
    socket = await _open_socket(url)
    try:
        await authenticate_socket(
            socket,
            authentication={
                "type": "instance-credential",
                "instanceId": instance_id,
                "credential": credential,
            },
            hermes_version=hermes_version,
            role="delivery",
        )
        for frame in frames:
            await socket.send(
                json.dumps(frame, separators=(",", ":"), ensure_ascii=False)
            )
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while acked != expected:
            remaining = deadline - loop.time()
            if remaining <= 0:
                return acked
            raw = await asyncio.wait_for(socket.recv(), timeout=remaining)
            try:
                reply = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(reply, dict):
                continue
            if reply.get("type") in {"home.deliver.ack", "media.deliver.ack"}:
                delivery_id_value = str(reply.get("deliveryId") or "")
                if delivery_id_value in expected:
                    acked.add(delivery_id_value)
            # Anything else (a liveness ping, an unrelated frame) is ignored:
            # this socket exists only to hand over these deliveries.
        return acked
    finally:
        try:
            await socket.close()
        except Exception:  # noqa: BLE001 - a failed close must not fail the send
            logger.debug("T3 standalone socket close failed", exc_info=True)


def _hermes_version() -> str:
    try:
        from hermes_cli import __version__

        return str(__version__)
    except Exception:  # noqa: BLE001 - version discovery must not block delivery
        return "unknown"

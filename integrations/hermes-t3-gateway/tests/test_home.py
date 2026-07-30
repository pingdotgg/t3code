from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import types
import unittest
import unittest.mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
PACKAGE = "hermes_t3_gateway_home_test"

# `home.py` depends only on `protocol.py` at import time (`connection.py` is
# imported lazily inside the standalone sender), so this loader needs none of
# the fake `gateway.*` modules the adapter tests install.
package = types.ModuleType(PACKAGE)
package.__path__ = [str(ROOT)]
sys.modules.setdefault(PACKAGE, package)

for _name in ("protocol", "connection", "home"):
    _spec = importlib.util.spec_from_file_location(
        f"{PACKAGE}.{_name}", ROOT / f"{_name}.py"
    )
    assert _spec and _spec.loader
    _module = importlib.util.module_from_spec(_spec)
    sys.modules[f"{PACKAGE}.{_name}"] = _module
    _spec.loader.exec_module(_module)

home = sys.modules[f"{PACKAGE}.home"]
protocol = sys.modules[f"{PACKAGE}.protocol"]
connection = sys.modules[f"{PACKAGE}.connection"]


def make_delivery(text: str, thread_id: str = "home-thread", **kwargs):
    return home.build_delivery(thread_id=thread_id, text=text, **kwargs)


class QueueTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = pathlib.Path(self._tmp.name) / "gateway" / "queue.jsonl"
        self.queue = home.HomeDeliveryQueue(path=self.path)

    def test_queue_replays_in_fifo_order(self):
        """Deliveries flush oldest-first, so a Home transcript reads in order."""
        first = make_delivery("first")
        second = make_delivery("second")
        third = make_delivery("third")
        for entry in (first, second, third):
            self.assertTrue(self.queue.append(entry))

        self.assertEqual(
            [entry["text"] for entry in self.queue.entries()],
            ["first", "second", "third"],
        )

    def test_an_entry_is_purged_only_by_its_own_ack(self):
        """The durability guarantee: nothing leaves the queue without an ack.

        T3 acks only after a durable write, so purging on anything else — a
        successful `send()`, a reconnect, a flush — would drop deliveries the
        server never actually stored.
        """
        first = make_delivery("first")
        second = make_delivery("second")
        self.queue.append(first)
        self.queue.append(second)

        # Sending, flushing, or re-reading changes nothing.
        self.assertEqual(len(self.queue.entries()), 2)
        self.assertEqual(len(self.queue.entries()), 2)

        # An unknown id purges nothing at all.
        self.assertFalse(self.queue.purge("never-sent"))
        self.assertEqual(len(self.queue.entries()), 2)

        self.assertTrue(self.queue.purge(first["deliveryId"]))
        self.assertEqual(
            [entry["deliveryId"] for entry in self.queue.entries()],
            [second["deliveryId"]],
        )

        # A duplicate ack (a replayed flush T3 deduped) is inert.
        self.assertFalse(self.queue.purge(first["deliveryId"]))
        self.assertEqual(len(self.queue.entries()), 1)

    def test_the_queue_is_capped_and_drops_the_oldest(self):
        """A wedged queue must not grow without bound — and must not go stale.

        Dropping newest would make an over-full queue permanently swallow
        current output; dropping oldest loses the least valuable entries and
        keeps today's cron brief.
        """
        queue = home.HomeDeliveryQueue(path=self.path, max_entries=3)
        deliveries = [make_delivery(f"delivery-{index}") for index in range(5)]
        with self.assertLogs(home.logger, level="WARNING") as captured:
            for entry in deliveries:
                queue.append(entry)

        self.assertTrue(
            any("queue is full" in line for line in captured.output),
            captured.output,
        )
        self.assertEqual(
            [entry["text"] for entry in queue.entries()],
            ["delivery-2", "delivery-3", "delivery-4"],
        )

    def test_appending_the_same_delivery_twice_is_idempotent(self):
        """A retried standalone send must not double-queue its own payload."""
        entry = make_delivery("once")
        self.assertTrue(self.queue.append(entry))
        self.assertTrue(self.queue.append(dict(entry)))
        self.assertEqual(len(self.queue.entries()), 1)

    def test_a_torn_line_does_not_discard_the_whole_queue(self):
        """A process killed mid-write must cost one entry, not the outbox."""
        good = make_delivery("survivor")
        self.queue.append(good)
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write('{"deliveryId": "truncated"\n')

        self.assertEqual(
            [entry["deliveryId"] for entry in self.queue.entries()],
            [good["deliveryId"]],
        )

    def test_the_queue_survives_a_process_restart(self):
        """Durability across a plugin restart is the entire point of the file."""
        entry = make_delivery("across-restart")
        self.queue.append(entry)

        reopened = home.HomeDeliveryQueue(path=self.path)
        self.assertEqual(
            [item["deliveryId"] for item in reopened.entries()],
            [entry["deliveryId"]],
        )

    def test_a_read_error_never_costs_the_entries_already_on_disk(self):
        """The queue's worst failure mode, guarded.

        `append` normally rewrites the whole file to enforce the entry cap. A
        read that failed used to report an empty queue, so that rewrite
        replaced every unacked delivery on disk with the one being appended.
        A transient EIO destroyed the outbox. The rewrite is skipped entirely
        when the read fails: the cap goes briefly unenforced (recoverable on
        the next successful read), the entries do not (not recoverable at all).
        """
        first = make_delivery("already-queued")
        second = make_delivery("also-queued")
        self.queue.append(first)
        self.queue.append(second)
        arriving = make_delivery("arrives-during-the-outage")

        real_read_text = pathlib.Path.read_text

        def fail_reading_the_queue(path_self, *args, **kwargs):
            if path_self == self.path:
                raise OSError("simulated I/O error")
            return real_read_text(path_self, *args, **kwargs)

        with unittest.mock.patch.object(
            pathlib.Path, "read_text", fail_reading_the_queue
        ), self.assertLogs(home.logger, level="WARNING"):
            self.assertTrue(self.queue.append(arriving))

        # Every pre-existing delivery survived, and the new one joined them.
        self.assertEqual(
            [entry["text"] for entry in self.queue.entries()],
            ["already-queued", "also-queued", "arrives-during-the-outage"],
        )

    def test_a_read_error_leaves_an_acked_entry_for_a_deduped_replay(self):
        """Purge only rewrites, so an unreadable queue means doing nothing."""
        entry = make_delivery("acked")
        self.queue.append(entry)

        real_read_text = pathlib.Path.read_text

        def fail_reading_the_queue(path_self, *args, **kwargs):
            if path_self == self.path:
                raise OSError("simulated I/O error")
            return real_read_text(path_self, *args, **kwargs)

        with unittest.mock.patch.object(
            pathlib.Path, "read_text", fail_reading_the_queue
        ), self.assertLogs(home.logger, level="WARNING"):
            self.assertFalse(self.queue.purge(entry["deliveryId"]))

        self.assertEqual(
            [item["deliveryId"] for item in self.queue.entries()],
            [entry["deliveryId"]],
        )

    @unittest.skipIf(os.name != "posix", "POSIX file modes only")
    def test_the_queue_is_readable_only_by_its_owner(self):
        """Entries carry message text and base64 media — not other users' business."""
        self.queue.append(make_delivery("private"))
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.path.parent.stat().st_mode & 0o777, 0o700)

        # And it stays private across the rewrite paths, not just on creation.
        self.queue.append(make_delivery("still private"))
        self.queue.purge(self.queue.entries()[0]["deliveryId"])
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_the_queue_lives_under_the_active_hermes_home(self):
        """Profile-scoped: a second profile must not replay the first's output."""
        with unittest.mock.patch.object(
            home, "hermes_home", return_value=pathlib.Path("/tmp/profile-b")
        ):
            self.assertEqual(
                home.queue_path(),
                pathlib.Path("/tmp/profile-b/gateway/t3_home_delivery_queue.jsonl"),
            )


class ClassificationTests(unittest.TestCase):
    def test_the_cron_job_id_metadata_is_the_strongest_signal(self):
        kind, label, certain = home.classify_delivery(
            "Anything at all", {"job_id": "daily-digest", "notify": True}
        )
        self.assertEqual(kind, "cron")
        self.assertEqual(label, "Cron: daily-digest")
        self.assertTrue(certain)

    def test_the_cron_wrap_header_supplies_a_human_job_name(self):
        content = (
            "Cronjob Response: Morning digest\n"
            "(job_id: abc123)\n"
            "-------------\n\n"
            "Three things happened.\n"
        )
        kind, label, certain = home.classify_delivery(content, None)
        self.assertEqual(kind, "cron")
        self.assertEqual(label, "Cron: Morning digest")
        self.assertTrue(certain)

    def test_gateway_lifecycle_notices_land_quietly(self):
        for content in (
            "♻️ Gateway online — Hermes is back and ready.",
            "♻ Gateway restarted successfully. Your session continues.",
            "⚠️ Gateway shutting down — Your current task will be interrupted.",
            "⚠️ Gateway restarting — Your current task will be interrupted. "
            "Send any message after restart and I'll try to resume where you "
            "left off.",
        ):
            with self.subTest(content=content[:32]):
                kind, label, certain = home.classify_delivery(content, None)
                self.assertEqual(kind, "lifecycle")
                self.assertEqual(label, "Gateway")
                self.assertTrue(certain)

    def test_a_handoff_is_recognised_from_its_synthetic_session_identity(self):
        kind, label, certain = home.classify_delivery(
            "Picking up where the CLI left off.",
            None,
            session_user_id="system:handoff",
        )
        self.assertEqual(kind, "handoff")
        self.assertEqual(label, "Handoff")
        self.assertTrue(certain)

    def test_an_unrecognised_send_defaults_to_an_uncertain_message(self):
        """Worst case is a wrong badge — and, in the live-turn window, a send
        that stays with the turn rather than being torn out of it."""
        kind, label, certain = home.classify_delivery("Just checking in.", None)
        self.assertEqual(kind, "message")
        self.assertEqual(label, "Hermes")
        self.assertFalse(certain)


class FrameTests(unittest.TestCase):
    def test_home_deliver_applies_every_wire_bound(self):
        frame = protocol.home_deliver(
            delivery_id_value="delivery-1",
            thread_id="home-thread",
            kind="cron",
            label="  " + "L" * 400 + "  ",
            text="x" * (protocol.MAX_HOME_DELIVERY_TEXT_CHARS + 500),
            created_at="2026-07-26T00:00:00Z",
        )
        self.assertEqual(frame["type"], "home.deliver")
        self.assertEqual(frame["protocolVersion"], protocol.PROTOCOL_VERSION)
        self.assertEqual(frame["deliveryId"], "delivery-1")
        self.assertEqual(frame["threadId"], "home-thread")
        self.assertEqual(frame["kind"], "cron")
        self.assertEqual(len(frame["label"]), protocol.MAX_HOME_DELIVERY_LABEL_CHARS)
        self.assertEqual(
            len(frame["text"]), protocol.MAX_HOME_DELIVERY_TEXT_CHARS
        )
        self.assertEqual(frame["createdAt"], "2026-07-26T00:00:00Z")

    def test_home_deliver_never_emits_an_invalid_kind_or_empty_label(self):
        frame = protocol.home_deliver(
            delivery_id_value="delivery-2",
            thread_id="home-thread",
            kind="not-a-kind",
            label="   ",
            text="",
        )
        # A misclassification must cost a badge, never a server rejection of a
        # delivery the plugin has already queued.
        self.assertEqual(frame["kind"], "other")
        self.assertEqual(frame["label"], "Hermes")
        self.assertTrue(len(frame["text"]) >= 1)

    def test_home_deliver_ack_is_an_accepted_server_command(self):
        message = {
            "type": "home.deliver.ack",
            "protocolVersion": protocol.PROTOCOL_VERSION,
        }
        self.assertEqual(protocol.validate_server_frame(message), message)

    def test_build_media_delivery_reads_the_file_and_guesses_the_mime(self):
        import base64

        with tempfile.TemporaryDirectory() as tmp:
            chart = pathlib.Path(tmp) / "chart.png"
            chart.write_bytes(b"\x89PNG fake bytes")
            frame = home.build_media_delivery(
                thread_id="home-thread",
                path=str(chart),
                kind="cron",
                label="Cron: nightly",
                caption="Nightly chart",
            )
        self.assertEqual(frame["type"], "media.deliver")
        self.assertEqual(frame["kind"], "cron")
        self.assertEqual(frame["name"], "chart.png")
        self.assertEqual(frame["mimeType"], "image/png")
        self.assertEqual(frame["sizeBytes"], len(b"\x89PNG fake bytes"))
        self.assertEqual(base64.b64decode(frame["data"]), b"\x89PNG fake bytes")
        self.assertEqual(frame["caption"], "Nightly chart")
        self.assertTrue(frame["deliveryId"])
        # Self-contained on disk: the frame carries the bytes, not the path,
        # so a queued copy survives the source temp file being reaped.
        self.assertNotIn("path", frame)

    def test_build_media_delivery_fails_loudly_on_unreadable_or_oversized_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(OSError):
                home.build_media_delivery(
                    thread_id="home-thread",
                    path=str(pathlib.Path(tmp) / "missing.png"),
                )
            empty = pathlib.Path(tmp) / "empty.bin"
            empty.write_bytes(b"")
            # An empty or oversized payload must never reach the durable
            # queue: T3 would reject it on every flush, forever.
            with self.assertRaises(ValueError):
                home.build_media_delivery(
                    thread_id="home-thread", path=str(empty)
                )

    def test_hello_declares_its_connection_role(self):
        gateway = protocol.connection_hello(
            hermes_version="0.19.0",
            authentication={"type": "instance-credential"},
        )
        self.assertEqual(gateway["role"], "gateway")
        delivery = protocol.connection_hello(
            hermes_version="0.19.0",
            authentication={"type": "instance-credential"},
            role="delivery",
        )
        self.assertEqual(delivery["role"], "delivery")
        # An unknown role must never silently become "delivery" — the safe
        # default is the ordinary connection.
        unknown = protocol.connection_hello(
            hermes_version="0.19.0",
            authentication={"type": "instance-credential"},
            role="nonsense",
        )
        self.assertEqual(unknown["role"], "gateway")


class MockDeliveryServer:
    """A T3 stand-in for the standalone sender's short-lived socket."""

    def __init__(self, *, ack: bool = True):
        self.ack = ack
        self.sent: list[dict] = []
        self.closed = False
        self._outbox: list[str] = []

    async def send(self, raw):
        message = json.loads(raw)
        self.sent.append(message)
        if message.get("type") == "connection.hello":
            self._outbox.append(
                json.dumps(
                    {
                        "type": "connection.accepted",
                        "protocolVersion": protocol.PROTOCOL_VERSION,
                        "requestId": message["requestId"],
                        "instanceId": "provider-instance",
                        "nickname": "Hermes",
                        "homeThreadId": "home-thread",
                    }
                )
            )
        elif message.get("type") in {"home.deliver", "media.deliver"} and self.ack:
            self._outbox.append(
                json.dumps(
                    {
                        "type": (
                            "media.deliver.ack"
                            if message["type"] == "media.deliver"
                            else "home.deliver.ack"
                        ),
                        "protocolVersion": protocol.PROTOCOL_VERSION,
                        "deliveryId": message["deliveryId"],
                    }
                )
            )

    async def recv(self):
        if not self._outbox:
            raise AssertionError("the mock server was polled with nothing to send")
        return self._outbox.pop(0)

    async def close(self):
        self.closed = True


class StandaloneSenderTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.queue_file = pathlib.Path(self._tmp.name) / "gateway" / "queue.jsonl"
        patch = unittest.mock.patch.object(
            home, "hermes_home", return_value=pathlib.Path(self._tmp.name)
        )
        patch.start()
        self.addCleanup(patch.stop)
        self.environment = unittest.mock.patch.dict(
            home.os.environ,
            {
                "HERMES_T3_GATEWAY_URL": "wss://t3.example/api/hermes-gateway/ws",
                "HERMES_T3_GATEWAY_INSTANCE_ID": "provider-instance",
                "HERMES_T3_GATEWAY_CREDENTIAL": "secret",
                home.HOME_CHANNEL_ENV: "home-thread",
            },
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def _serve(self, server):
        async def _open(_url):
            return server

        return unittest.mock.patch.object(connection, "_open_socket", _open)

    async def test_standalone_send_hellos_as_delivery_then_acks_and_closes(self):
        """The full out-of-process cron path.

        `role: "delivery"` is load-bearing: T3's broker registers a `gateway`
        connection under generation fencing and displaces its predecessor, so a
        cron dial-in announcing the default role would kick the live gateway
        socket off its own instance mid-turn.
        """
        server = MockDeliveryServer()
        with self._serve(server):
            result = await home.standalone_send(
                None,
                "home-thread",
                "Cronjob Response: nightly\n(job_id: nightly)\n-------------\n\nDone.",
            )

        self.assertTrue(result["success"])
        self.assertEqual(
            [message["type"] for message in server.sent],
            ["connection.hello", "home.deliver"],
        )
        hello, delivery = server.sent
        self.assertEqual(hello["role"], "delivery")
        self.assertEqual(hello["protocolVersion"], protocol.PROTOCOL_VERSION)
        self.assertEqual(
            hello["authentication"],
            {
                "type": "instance-credential",
                "instanceId": "provider-instance",
                "credential": "secret",
            },
        )
        self.assertEqual(delivery["threadId"], "home-thread")
        self.assertEqual(delivery["kind"], "cron")
        self.assertEqual(delivery["label"], "Cron: nightly")
        self.assertEqual(result["message_id"], delivery["deliveryId"])
        self.assertTrue(server.closed, "the delivery socket must not linger")

        # Acked, so nothing is left queued for the live gateway to replay.
        self.assertEqual(home.HomeDeliveryQueue().entries(), [])

    async def test_an_unreachable_t3_queues_rather_than_failing_the_cron_job(self):
        """A cron job must not report failure for output that will arrive."""

        async def _refuse(_url):
            raise ConnectionRefusedError("T3 is down")

        with unittest.mock.patch.object(connection, "_open_socket", _refuse):
            result = await home.standalone_send(None, "home-thread", "Nightly brief")

        self.assertTrue(result["success"])
        self.assertTrue(result["queued"])
        queued = home.HomeDeliveryQueue().entries()
        self.assertEqual([entry["text"] for entry in queued], ["Nightly brief"])
        self.assertEqual(queued[0]["deliveryId"], result["message_id"])

    async def test_an_unacknowledged_delivery_stays_queued(self):
        """No ack, no purge — the live gateway retries it on the next connect."""
        server = MockDeliveryServer(ack=False)
        with self._serve(server), unittest.mock.patch.object(
            home, "_deliver_over_short_lived_socket", return_value=set()
        ):
            result = await home.standalone_send(None, "home-thread", "Unacked brief")

        self.assertTrue(result["success"])
        self.assertTrue(result["queued"])
        self.assertEqual(
            [entry["text"] for entry in home.HomeDeliveryQueue().entries()],
            ["Unacked brief"],
        )

    async def test_standalone_send_refuses_when_hermes_is_not_enrolled(self):
        with unittest.mock.patch.dict(
            home.os.environ, {"HERMES_T3_GATEWAY_CREDENTIAL": ""}
        ):
            result = await home.standalone_send(None, "home-thread", "Brief")
        self.assertIn("not enrolled", result["error"])

    async def test_standalone_send_falls_back_to_the_designated_home_thread(self):
        server = MockDeliveryServer()
        with self._serve(server):
            result = await home.standalone_send(None, "", "Brief with no chat id")
        self.assertTrue(result["success"])
        self.assertEqual(server.sent[1]["threadId"], "home-thread")

    async def test_standalone_send_delivers_media_files_as_media_frames(self):
        """`deliver=t3` cron output with files rides the v4+ media framing."""
        chart = pathlib.Path(self._tmp.name) / "chart.png"
        chart.write_bytes(b"\x89PNG fake bytes")
        server = MockDeliveryServer()
        with self._serve(server):
            result = await home.standalone_send(
                None,
                "home-thread",
                "Cronjob Response: nightly\n(job_id: nightly)\n-------------\n\nDone.",
                media_files=[(str(chart), False)],
            )

        self.assertTrue(result["success"])
        self.assertEqual(
            [message["type"] for message in server.sent],
            ["connection.hello", "home.deliver", "media.deliver"],
        )
        media = server.sent[2]
        # Media inherits the text's provenance so the chart gets the same
        # badge as the brief it accompanies.
        self.assertEqual(media["kind"], "cron")
        self.assertEqual(media["label"], "Cron: nightly")
        self.assertEqual(media["name"], "chart.png")
        self.assertEqual(media["mimeType"], "image/png")
        # Both frames were acked, so nothing stays queued.
        self.assertEqual(home.HomeDeliveryQueue().entries(), [])
        # Counter-evidence against core's unconditional "MEDIA attachments were
        # omitted" warning: the accounting keys sit in the same result dict.
        self.assertEqual(result["media_count"], 1)
        self.assertEqual(result["acked_count"], 2)
        self.assertEqual(
            result["delivery_ids"],
            [message["deliveryId"] for message in server.sent[1:]],
        )
        self.assertIn("1 media file(s) delivered and acknowledged", result["note"])
        # `message_id` keeps pointing at the first frame — upstream reads it.
        self.assertEqual(result["message_id"], server.sent[1]["deliveryId"])

    async def test_a_text_only_send_reports_no_media(self):
        """The accounting keys are always present; only the note is conditional."""
        server = MockDeliveryServer()
        with self._serve(server):
            result = await home.standalone_send(None, "home-thread", "Just text")

        self.assertEqual(result["media_count"], 0)
        self.assertEqual(result["acked_count"], 1)
        self.assertEqual(result["delivery_ids"], [result["message_id"]])
        self.assertNotIn("note", result)

    async def test_a_media_only_send_delivers_without_a_text_frame(self):
        """`MEDIA:/tmp/x.png` with no prose is a normal send, not an error.

        Core rejects this outright for `t3`
        (`tools/send_message_tool.py:1101-1107` @ v0.19.0); `coreshim` routes it
        here instead, so the sender has to handle an empty message.
        """
        chart = pathlib.Path(self._tmp.name) / "chart.png"
        chart.write_bytes(b"\x89PNG fake bytes")
        server = MockDeliveryServer()
        with self._serve(server):
            result = await home.standalone_send(
                None, "home-thread", "", media_files=[(str(chart), False)]
            )

        self.assertTrue(result["success"])
        # No empty text frame rides along.
        self.assertEqual(
            [message["type"] for message in server.sent],
            ["connection.hello", "media.deliver"],
        )
        self.assertEqual(result["media_count"], 1)
        self.assertEqual(result["acked_count"], 1)
        self.assertIn("1 media file(s) delivered and acknowledged", result["note"])

    async def test_media_counts_exclude_a_skipped_file(self):
        """A file that could not be read is not counted as delivered."""
        good = pathlib.Path(self._tmp.name) / "good.png"
        good.write_bytes(b"\x89PNG fake bytes")
        missing = pathlib.Path(self._tmp.name) / "gone.png"
        server = MockDeliveryServer()
        with self._serve(server), self.assertLogs(home.logger, level="WARNING"):
            result = await home.standalone_send(
                None,
                "home-thread",
                "Two charts, one dead",
                media_files=[(str(good), False), (str(missing), False)],
            )

        self.assertTrue(result["success"])
        self.assertEqual(result["media_count"], 1)
        self.assertIn("1 media file(s) delivered and acknowledged", result["note"])
        self.assertIn("skipped", result["detail"])

    async def test_standalone_send_skips_an_unreadable_media_file(self):
        """One bad file must not sink the brief — and must never be queued."""
        server = MockDeliveryServer()
        with self._serve(server), self.assertLogs(home.logger, level="WARNING"):
            result = await home.standalone_send(
                None,
                "home-thread",
                "Brief with a dead attachment",
                media_files=[(str(pathlib.Path(self._tmp.name) / "gone.png"), False)],
            )

        self.assertTrue(result["success"])
        self.assertIn("skipped", result["detail"])
        self.assertEqual(
            [message["type"] for message in server.sent],
            ["connection.hello", "home.deliver"],
        )
        self.assertEqual(home.HomeDeliveryQueue().entries(), [])

    async def test_unacked_media_stays_queued_for_the_next_connect(self):
        """The durable lifecycle applies to media exactly as it does to text."""
        chart = pathlib.Path(self._tmp.name) / "chart.png"
        chart.write_bytes(b"\x89PNG fake bytes")

        async def _refuse(_url):
            raise ConnectionRefusedError("T3 is down")

        with unittest.mock.patch.object(connection, "_open_socket", _refuse):
            result = await home.standalone_send(
                None,
                "home-thread",
                "Nightly brief",
                media_files=[(str(chart), False)],
            )

        self.assertTrue(result["success"])
        self.assertTrue(result["queued"])
        queued = home.HomeDeliveryQueue().entries()
        self.assertEqual(
            [entry["type"] for entry in queued], ["home.deliver", "media.deliver"]
        )
        # The queued media frame is self-contained: bytes, not a path.
        self.assertEqual(queued[1]["name"], "chart.png")
        self.assertTrue(queued[1]["data"])
        # Nothing was acked, so the note must not claim delivery — but it must
        # still contradict "omitted", because the file is durably on its way.
        self.assertEqual(result["media_count"], 1)
        self.assertEqual(result["acked_count"], 0)
        self.assertIn("1 media file(s) queued for delivery", result["note"])
        self.assertNotIn("acknowledged", result["note"])


class DesignationTests(unittest.TestCase):
    def test_saving_the_designation_mirrors_it_into_this_process(self):
        """The running gateway must not need a restart to see a new home."""
        saved = {}

        config = types.ModuleType("hermes_cli.config")
        config.save_env_value = lambda key, value: saved.__setitem__(key, value)
        package = types.ModuleType("hermes_cli")
        package.__path__ = []
        with unittest.mock.patch.dict(
            sys.modules, {"hermes_cli": package, "hermes_cli.config": config}
        ), unittest.mock.patch.dict(home.os.environ, {}, clear=False):
            self.assertTrue(home.save_home_thread_id("thread-home"))
            self.assertEqual(saved, {home.HOME_CHANNEL_ENV: "thread-home"})
            self.assertEqual(home.home_thread_id(), "thread-home")

    def test_an_unwritable_env_still_routes_for_this_process(self):
        """A managed or read-only `.env` degrades; it must not break routing."""

        def refuse(key, value):
            raise PermissionError("managed .env")

        config = types.ModuleType("hermes_cli.config")
        config.save_env_value = refuse
        package = types.ModuleType("hermes_cli")
        package.__path__ = []
        with unittest.mock.patch.dict(
            sys.modules, {"hermes_cli": package, "hermes_cli.config": config}
        ), unittest.mock.patch.dict(
            home.os.environ, {}, clear=False
        ), self.assertLogs(home.logger, level="WARNING"):
            self.assertFalse(home.save_home_thread_id("thread-home"))
            # Not durable, but routable: this gateway delivers to the right
            # thread until it restarts, and re-reconciles on the next connect.
            self.assertEqual(home.home_thread_id(), "thread-home")

    def test_an_empty_designation_is_ignored(self):
        with unittest.mock.patch.dict(
            home.os.environ, {home.HOME_CHANNEL_ENV: "keep-me"}
        ):
            self.assertFalse(home.save_home_thread_id("   "))
            self.assertEqual(home.home_thread_id(), "keep-me")


if __name__ == "__main__":
    unittest.main()

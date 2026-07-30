from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import types
import unittest
from contextlib import contextmanager

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "t3_gateway_protocol", ROOT / "protocol.py"
)
assert SPEC and SPEC.loader
protocol = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(protocol)


@contextmanager
def fake_hermes_config(loader):
    """Install a stand-in `hermes_cli.config` for the duration of a test."""
    saved = {
        name: sys.modules.get(name) for name in ("hermes_cli", "hermes_cli.config")
    }
    package = types.ModuleType("hermes_cli")
    package.__path__ = []
    config = types.ModuleType("hermes_cli.config")
    if loader is not None:
        config.load_config_readonly = loader
    package.config = config
    sys.modules["hermes_cli"] = package
    sys.modules["hermes_cli.config"] = config
    try:
        yield
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


@contextmanager
def fake_hermes_skills(skills_list=None, skill_view=None):
    """Install a stand-in `tools.skills_tool` for the duration of a test."""
    saved = {name: sys.modules.get(name) for name in ("tools", "tools.skills_tool")}
    package = types.ModuleType("tools")
    package.__path__ = []
    skills_tool = types.ModuleType("tools.skills_tool")
    if skills_list is not None:
        skills_tool.skills_list = skills_list
    if skill_view is not None:
        skills_tool.skill_view = skill_view
    package.skills_tool = skills_tool
    sys.modules["tools"] = package
    sys.modules["tools.skills_tool"] = skills_tool
    try:
        yield
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


@contextmanager
def fake_hermes_inventory(*, config, payload=None, error=None, calls=None):
    """Install the documented Hermes inventory/config surfaces."""
    names = ("hermes_cli", "hermes_cli.config", "hermes_cli.inventory")
    saved = {name: sys.modules.get(name) for name in names}
    package = types.ModuleType("hermes_cli")
    package.__path__ = []
    config_module = types.ModuleType("hermes_cli.config")
    config_module.load_config_readonly = lambda: config
    inventory = types.ModuleType("hermes_cli.inventory")
    context = object()

    def load_picker_context():
        return context

    def build_models_payload(received_context, **kwargs):
        if calls is not None:
            calls.append((received_context, kwargs))
        if error is not None:
            raise error
        return payload

    inventory.load_picker_context = load_picker_context
    inventory.build_models_payload = build_models_payload
    package.config = config_module
    package.inventory = inventory
    sys.modules.update(
        {
            "hermes_cli": package,
            "hermes_cli.config": config_module,
            "hermes_cli.inventory": inventory,
        }
    )
    try:
        yield context
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


class ProtocolTests(unittest.TestCase):
    def test_hello_matches_v5_contract(self):
        hello = protocol.connection_hello(
            hermes_version="0.19.0",
            authentication={"type": "enrollment-token", "token": "once"},
            hello_request_id="request-1",
            model="gpt-5.6-terra",
        )
        self.assertEqual(hello["type"], "connection.hello")
        self.assertEqual(hello["requestId"], "request-1")
        self.assertEqual(hello["protocolVersion"], protocol.PROTOCOL_VERSION)
        # v5 retains v4's literal attachment capability.
        # contract, not a negotiated option.
        self.assertTrue(hello["capabilities"]["attachments"])
        self.assertTrue(hello["capabilities"]["streaming"])
        self.assertEqual(hello["model"], "gpt-5.6-terra")

    def test_hello_reports_the_configured_hermes_model(self):
        config = {"model": {"default": "gpt-5.6-terra"}}

        with fake_hermes_config(lambda: config):
            hello = protocol.connection_hello(
                hermes_version="0.19.0",
                authentication={"type": "enrollment-token", "token": "once"},
            )

        self.assertEqual(hello["model"], "gpt-5.6-terra")
        # `load_config_readonly` returns the shared process-wide cache; the
        # lookup must never mutate it.
        self.assertEqual(config, {"model": {"default": "gpt-5.6-terra"}})

    def test_hello_omits_model_when_hermes_cannot_report_one(self):
        def missing_section():
            return {"agent": {}}

        def older_hermes():
            raise ImportError("load_config_readonly is unavailable")

        for loader in (missing_section, older_hermes, None):
            with self.subTest(loader=getattr(loader, "__name__", "absent")):
                with fake_hermes_config(loader):
                    hello = protocol.connection_hello(
                        hermes_version="0.19.0",
                        authentication={
                            "type": "enrollment-token",
                            "token": "once",
                        },
                    )
                # Omitted entirely — never null or empty.
                self.assertNotIn("model", hello)

    def test_configured_model_ignores_blank_and_non_string_values(self):
        for value in ("", "   ", None, 5, {"default": "nested"}):
            config = {"model": {"default": value}}
            with (
                self.subTest(value=value),
                fake_hermes_config(lambda config=config: config),
            ):
                self.assertIsNone(protocol.configured_model())

    def test_server_frame_validation_is_closed(self):
        with self.assertRaisesRegex(ValueError, "unsupported"):
            protocol.validate_server_frame(
                {
                    "type": "made.up",
                    "protocolVersion": protocol.PROTOCOL_VERSION,
                }
            )
        with self.assertRaisesRegex(ValueError, "version"):
            # Protocol v4 peers must upgrade before sending runtime frames.
            protocol.validate_server_frame({"type": "ping", "protocolVersion": 4})

    def test_describe_frames_are_accepted_server_commands(self):
        for frame_type in (
            "describe.request",
            "models.list.request",
            "skill.body.request",
        ):
            with self.subTest(frame_type=frame_type):
                message = {
                    "type": frame_type,
                    "protocolVersion": protocol.PROTOCOL_VERSION,
                }
                self.assertEqual(protocol.validate_server_frame(message), message)

    # ── describe.response ──────────────────────────────────────────────

    def test_describe_response_round_trips_every_reported_field(self):
        skills = [
            {"name": "codex", "description": "Delegate coding.", "source": "agents"}
        ]
        response = protocol.describe_response(
            request_id_value="describe-1",
            hermes_version="0.19.0",
            model="gpt-5.6-terra",
            reasoning_effort="medium",
            skills=skills,
        )
        self.assertEqual(response["type"], "describe.response")
        self.assertEqual(response["requestId"], "describe-1")
        self.assertEqual(response["protocolVersion"], protocol.PROTOCOL_VERSION)
        self.assertEqual(response["pluginVersion"], protocol.PLUGIN_VERSION)
        self.assertEqual(response["hermesVersion"], "0.19.0")
        self.assertEqual(response["model"], "gpt-5.6-terra")
        self.assertEqual(response["reasoningEffort"], "medium")
        self.assertEqual(response["skills"], skills)
        self.assertTrue(response["capabilities"]["attachments"])
        self.assertTrue(response["describedAt"].endswith("Z"))
        # Skill dicts are copied out: mutating the reply must not reach back
        # into whatever the caller passed in.
        response["skills"][0]["name"] = "mutated"
        self.assertEqual(skills[0]["name"], "codex")

    def test_describe_reports_the_configured_reasoning_effort(self):
        config = {"agent": {"reasoning_effort": "medium"}}

        with fake_hermes_config(lambda: config):
            response = protocol.describe_response(
                request_id_value="describe-2",
                hermes_version="0.19.0",
                skills=[],
            )

        self.assertEqual(response["reasoningEffort"], "medium")
        # `load_config_readonly` returns the shared process-wide cache; the
        # lookup must never mutate it.
        self.assertEqual(config, {"agent": {"reasoning_effort": "medium"}})

    def test_describe_omits_effort_when_hermes_cannot_report_one(self):
        def missing_section():
            return {"model": {}}

        def older_hermes():
            raise ImportError("load_config_readonly is unavailable")

        for loader in (missing_section, older_hermes, None):
            with self.subTest(loader=getattr(loader, "__name__", "absent")):
                with fake_hermes_config(loader):
                    response = protocol.describe_response(
                        request_id_value="describe-3",
                        hermes_version="0.19.0",
                        skills=[],
                    )
                # Omitted entirely — never null or empty.
                self.assertNotIn("reasoningEffort", response)
                self.assertNotIn("model", response)
                # The plugin-owned block is always present regardless.
                self.assertEqual(response["pluginVersion"], protocol.PLUGIN_VERSION)
                self.assertEqual(response["skills"], [])

    def test_configured_reasoning_effort_ignores_blank_and_non_string_values(self):
        for value in ("", "   ", None, 5, {"level": "high"}):
            config = {"agent": {"reasoning_effort": value}}
            with (
                self.subTest(value=value),
                fake_hermes_config(lambda config=config: config),
            ):
                self.assertIsNone(protocol.configured_reasoning_effort())

    # ── models.list.response ──────────────────────────────────────────

    def test_models_catalog_projects_the_explicit_inventory_shape(self):
        calls = []
        config = {
            "model": {"provider": "openai-codex", "default": "gpt-5.4"},
            "agent": {"reasoning_effort": "high"},
        }
        payload = {
            "provider": "openai-codex",
            "model": "gpt-5.4",
            "providers": [
                {
                    "slug": "openai-codex",
                    "name": "OpenAI Codex",
                    "models": ["gpt-5.4", "gpt-5.3-codex"],
                    "capabilities": {
                        "gpt-5.4": {"fast": True, "reasoning": True},
                        "gpt-5.3-codex": {"fast": False, "reasoning": False},
                    },
                }
            ],
        }

        with fake_hermes_inventory(
            config=config,
            payload=payload,
            calls=calls,
        ) as context:
            catalog = protocol.models_catalog()
            response = protocol.models_list_response(
                request_id_value="models-1",
                catalog=catalog,
            )

        self.assertEqual(
            calls,
            [
                (
                    context,
                    {
                        "explicit_only": True,
                        "include_unconfigured": False,
                        "picker_hints": False,
                        "canonical_order": True,
                        "pricing": False,
                        "capabilities": True,
                        "refresh": False,
                        "probe_custom_providers": False,
                        "probe_current_custom_provider": False,
                        "max_models": 100,
                    },
                )
            ],
        )
        self.assertEqual(response["type"], "models.list.response")
        self.assertEqual(response["protocolVersion"], protocol.PROTOCOL_VERSION)
        self.assertEqual(response["requestId"], "models-1")
        self.assertEqual(response["currentProvider"], "openai-codex")
        self.assertEqual(response["currentModel"], "gpt-5.4")
        self.assertEqual(response["currentReasoningEffort"], "high")
        self.assertEqual(
            response["reasoningEfforts"],
            ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
        )
        self.assertEqual(
            response["models"],
            [
                {
                    "provider": "openai-codex",
                    "providerName": "OpenAI Codex",
                    "model": "gpt-5.4",
                    "supportsReasoning": True,
                },
                {
                    "provider": "openai-codex",
                    "providerName": "OpenAI Codex",
                    "model": "gpt-5.3-codex",
                    "supportsReasoning": False,
                },
            ],
        )

    def test_models_catalog_degrades_to_current_config_and_an_empty_list(self):
        config = {
            "model": {"default": "anthropic/claude-sonnet-4.6"},
            "agent": {"reasoning_effort": "off"},
        }
        with fake_hermes_inventory(
            config=config,
            error=RuntimeError("inventory unavailable"),
        ):
            response = protocol.models_list_response(
                request_id_value="models-fallback"
            )

        self.assertEqual(response["models"], [])
        self.assertEqual(response["currentProvider"], "openrouter")
        self.assertEqual(response["currentModel"], "anthropic/claude-sonnet-4.6")
        self.assertEqual(response["currentReasoningEffort"], "none")

    # ── skills enumeration ─────────────────────────────────────────────

    def test_installed_skills_projects_only_documented_fields(self):
        payload = json.dumps(
            {
                "success": True,
                "skills": [
                    {
                        "name": "  codex  ",
                        "description": "  Delegate coding.  ",
                        "category": "autonomous-ai-agents",
                        "secret": "must-not-cross",
                    },
                    {"name": "bare"},
                ],
            }
        )
        with fake_hermes_skills(skills_list=lambda: payload):
            self.assertEqual(
                protocol.installed_skills(),
                [
                    {
                        "name": "codex",
                        "enabled": True,
                        "description": "Delegate coding.",
                        "source": "autonomous-ai-agents",
                    },
                    {"name": "bare", "enabled": True},
                ],
            )

    def test_installed_skills_degrades_to_empty_on_every_failure(self):
        def older_hermes():
            raise ImportError("skills_list is unavailable")

        def not_json():
            return "<html>not json</html>"

        def unsuccessful():
            return json.dumps({"success": False, "error": "boom"})

        def malformed_entries():
            return json.dumps({"success": True, "skills": ["a string", {}, 5]})

        for loader in (older_hermes, not_json, unsuccessful, malformed_entries, None):
            with self.subTest(loader=getattr(loader, "__name__", "absent")):
                with fake_hermes_skills(skills_list=loader):
                    self.assertEqual(protocol.installed_skills(), [])

    def test_describe_reports_an_empty_skill_list_when_hermes_has_none(self):
        with fake_hermes_skills(
            skills_list=lambda: json.dumps({"success": True, "skills": []})
        ):
            response = protocol.describe_response(
                request_id_value="describe-4",
                hermes_version="0.19.0",
                model="gpt-5.6-terra",
                reasoning_effort="medium",
            )
        # Always present: an empty list is the truthful answer, never omitted.
        self.assertEqual(response["skills"], [])

    # ── skill.body.response ────────────────────────────────────────────

    def test_skill_body_response_round_trips(self):
        response = protocol.skill_body_response(
            request_id_value="body-1",
            skill_name="codex",
            markdown="# Codex\n\nDelegate coding.",
        )
        self.assertEqual(response["type"], "skill.body.response")
        self.assertEqual(response["requestId"], "body-1")
        self.assertEqual(response["protocolVersion"], protocol.PROTOCOL_VERSION)
        self.assertEqual(response["skillName"], "codex")
        self.assertEqual(response["markdown"], "# Codex\n\nDelegate coding.")

    def test_skill_body_response_sends_explicit_null_when_unavailable(self):
        for markdown in (None, ""):
            with self.subTest(markdown=markdown):
                response = protocol.skill_body_response(
                    request_id_value="body-2",
                    skill_name="missing",
                    markdown=markdown,
                )
                # Present but null — the caller asked about a named skill and
                # must tell "nothing to show" from a dropped reply.
                self.assertIn("markdown", response)
                self.assertIsNone(response["markdown"])

    def test_skill_body_reads_the_authored_markdown_without_preprocessing(self):
        seen = {}

        def skill_view(name, preprocess=True, **kwargs):
            seen["name"] = name
            seen["preprocess"] = preprocess
            return json.dumps({"success": True, "content": "# Codex\n"})

        with fake_hermes_skills(skill_view=skill_view):
            self.assertEqual(protocol.skill_body("  codex  "), "# Codex\n")
        self.assertEqual(seen["name"], "codex")
        # T3 renders the skill for a human; Hermes' template/inline-shell
        # rendering must not run.
        self.assertFalse(seen["preprocess"])

    def test_skill_body_truncates_a_pathological_body(self):
        oversized = "x" * (protocol.MAX_SKILL_BODY_CHARS + 5_000)
        with fake_hermes_skills(
            skill_view=lambda *a, **kw: json.dumps(
                {"success": True, "content": oversized}
            )
        ):
            body = protocol.skill_body("huge")
        self.assertEqual(len(body), protocol.MAX_SKILL_BODY_CHARS)

    def test_skill_body_degrades_to_none_on_every_failure(self):
        def older_hermes(*a, **kw):
            raise ImportError("skill_view is unavailable")

        def not_json(*a, **kw):
            return "<html>not json</html>"

        def unknown_skill(*a, **kw):
            return json.dumps({"success": False, "error": "Skill 'x' not found."})

        def blank_content(*a, **kw):
            return json.dumps({"success": True, "content": "   "})

        for viewer in (older_hermes, not_json, unknown_skill, blank_content, None):
            with self.subTest(viewer=getattr(viewer, "__name__", "absent")):
                with fake_hermes_skills(skill_view=viewer):
                    self.assertIsNone(protocol.skill_body("codex"))

        # A blank request never reaches Hermes at all.
        with fake_hermes_skills(skill_view=older_hermes):
            self.assertIsNone(protocol.skill_body("   "))
            self.assertIsNone(protocol.skill_body(None))

    def test_tool_types_map_to_canonical_items(self):
        self.assertEqual(
            protocol.canonical_tool_item_type("terminal"), "command_execution"
        )
        self.assertEqual(
            protocol.canonical_tool_item_type("apply_patch"), "file_change"
        )
        self.assertEqual(
            protocol.canonical_tool_item_type("custom_vendor_tool"),
            "dynamic_tool_call",
        )

    def test_tool_data_never_forwards_arbitrary_args(self):
        self.assertEqual(
            protocol.canonical_tool_data(
                "terminal",
                {"command": "pytest", "cwd": "/repo", "credential": "secret"},
            ),
            {"command": "pytest", "cwd": "/repo"},
        )
        self.assertIsNone(
            protocol.canonical_tool_data(
                "custom_vendor_tool", {"credential": "must-not-cross"}
            )
        )

    # ── media.deliver ──────────────────────────────────────────────────

    def test_media_deliver_encodes_the_payload_and_applies_every_wire_bound(self):
        import base64

        payload = b"\x89PNG fake bytes"
        frame = protocol.media_deliver(
            delivery_id_value="media-1",
            thread_id="home-thread",
            kind="cron",
            label="  " + "L" * 400 + "  ",
            name="chart.png",
            mime_type="image/png",
            data=payload,
            turn_id="turn-9",
            caption="c" * (protocol.MAX_MEDIA_CAPTION_CHARS + 50),
            created_at="2026-07-27T00:00:00Z",
        )
        self.assertEqual(frame["type"], "media.deliver")
        self.assertEqual(frame["protocolVersion"], protocol.PROTOCOL_VERSION)
        self.assertEqual(frame["deliveryId"], "media-1")
        self.assertEqual(frame["threadId"], "home-thread")
        self.assertEqual(frame["turnId"], "turn-9")
        self.assertEqual(frame["kind"], "cron")
        self.assertEqual(len(frame["label"]), protocol.MAX_HOME_DELIVERY_LABEL_CHARS)
        self.assertEqual(frame["name"], "chart.png")
        self.assertEqual(frame["mimeType"], "image/png")
        # `sizeBytes` and `data` are derived from the same bytes, so they can
        # never disagree — and the payload round-trips exactly.
        self.assertEqual(frame["sizeBytes"], len(payload))
        self.assertEqual(base64.b64decode(frame["data"]), payload)
        self.assertEqual(len(frame["caption"]), protocol.MAX_MEDIA_CAPTION_CHARS)
        self.assertEqual(frame["createdAt"], "2026-07-27T00:00:00Z")

    def test_media_deliver_omits_optional_fields_rather_than_sending_empty(self):
        frame = protocol.media_deliver(
            delivery_id_value="media-2",
            thread_id="home-thread",
            kind="message",
            label="Hermes",
            name="brief.pdf",
            mime_type="application/pdf",
            data=b"%PDF",
        )
        self.assertNotIn("turnId", frame)
        self.assertNotIn("caption", frame)

    def test_media_deliver_degrades_provenance_but_never_the_payload_shape(self):
        frame = protocol.media_deliver(
            delivery_id_value="media-3",
            thread_id="home-thread",
            kind="not-a-kind",
            label="   ",
            name="   ",
            mime_type="",
            data=b"x",
        )
        # A misclassification must cost a badge, never a server rejection of a
        # delivery the plugin has already queued.
        self.assertEqual(frame["kind"], "other")
        self.assertEqual(frame["label"], "Hermes")
        self.assertEqual(frame["name"], "attachment.bin")
        self.assertEqual(frame["mimeType"], "application/octet-stream")

    def test_media_deliver_requires_a_delivery_id(self):
        with self.assertRaisesRegex(ValueError, "deliveryId"):
            protocol.media_deliver(
                delivery_id_value="   ",
                thread_id="home-thread",
                kind="message",
                label="Hermes",
                name="a.bin",
                mime_type="application/octet-stream",
                data=b"x",
            )

    def test_media_deliver_rejects_an_empty_or_oversized_payload(self):
        # Truncation would corrupt the file, so unlike text these fail loudly
        # instead of being clamped — and never reach the durable queue.
        for data, pattern in (
            (b"", "non-empty"),
            (b"x" * (protocol.MAX_MEDIA_BYTES + 1), "ceiling"),
        ):
            with self.subTest(size=len(data)):
                with self.assertRaisesRegex(ValueError, pattern):
                    protocol.media_deliver(
                        delivery_id_value="media-4",
                        thread_id="home-thread",
                        kind="message",
                        label="Hermes",
                        name="big.bin",
                        mime_type="application/octet-stream",
                        data=data,
                    )

    def test_media_deliver_ack_is_an_accepted_server_command(self):
        message = {
            "type": "media.deliver.ack",
            "protocolVersion": protocol.PROTOCOL_VERSION,
        }
        self.assertEqual(protocol.validate_server_frame(message), message)

    # ── inbound turn attachments ───────────────────────────────────────

    def test_turn_attachments_decode_base64_to_bytes(self):
        import base64

        message = {
            "type": "turn.start",
            "attachments": [
                {
                    "name": "notes.txt",
                    "mimeType": "text/plain",
                    "sizeBytes": 5,
                    "data": base64.b64encode(b"hello").decode("ascii"),
                },
                {"name": "blob", "data": base64.b64encode(b"\x00\x01").decode()},
            ],
        }
        decoded = protocol.turn_attachments(message)
        self.assertEqual(
            decoded,
            [
                {"name": "notes.txt", "mimeType": "text/plain", "data": b"hello"},
                # A missing MIME degrades to octet-stream, never empty.
                {
                    "name": "blob",
                    "mimeType": "application/octet-stream",
                    "data": b"\x00\x01",
                },
            ],
        )

    def test_a_frame_without_attachments_decodes_to_an_empty_list(self):
        self.assertEqual(protocol.turn_attachments({"type": "turn.start"}), [])

    def test_malformed_turn_attachments_raise_rather_than_dropping_files(self):
        # T3 validates against its schema before sending, so a bad entry here
        # is version drift; silently losing a user's file is worse than a
        # correlated protocol.error they can see.
        for attachments in (
            "not-a-list",
            [{"mimeType": "text/plain", "data": "aGk="}],  # no name
            [{"name": "x.txt"}],  # no data
            [{"name": "x.txt", "data": "!!! not base64 !!!"}],
            [{"name": "x.txt", "data": ""}],
        ):
            with self.subTest(attachments=attachments):
                with self.assertRaises(ValueError):
                    protocol.turn_attachments({"attachments": attachments})

    def test_an_oversized_turn_attachment_is_rejected(self):
        import base64

        oversized = base64.b64encode(
            b"x" * (protocol.MAX_MEDIA_BYTES + 1)
        ).decode("ascii")
        with self.assertRaisesRegex(ValueError, "ceiling"):
            protocol.turn_attachments(
                {"attachments": [{"name": "huge.bin", "data": oversized}]}
            )


if __name__ == "__main__":
    unittest.main()

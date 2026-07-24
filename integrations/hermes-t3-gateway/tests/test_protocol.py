from __future__ import annotations

import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "t3_gateway_protocol", ROOT / "protocol.py"
)
assert SPEC and SPEC.loader
protocol = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(protocol)


class ProtocolTests(unittest.TestCase):
    def test_hello_matches_v1_contract(self):
        hello = protocol.connection_hello(
            hermes_version="0.19.0",
            authentication={"type": "enrollment-token", "token": "once"},
            hello_request_id="request-1",
        )
        self.assertEqual(hello["type"], "connection.hello")
        self.assertEqual(hello["requestId"], "request-1")
        self.assertEqual(hello["protocolVersion"], 1)
        self.assertFalse(hello["capabilities"]["attachments"])
        self.assertTrue(hello["capabilities"]["streaming"])

    def test_server_frame_validation_is_closed(self):
        with self.assertRaisesRegex(ValueError, "unsupported"):
            protocol.validate_server_frame({"type": "made.up", "protocolVersion": 1})
        with self.assertRaisesRegex(ValueError, "version"):
            protocol.validate_server_frame({"type": "ping", "protocolVersion": 2})

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


if __name__ == "__main__":
    unittest.main()

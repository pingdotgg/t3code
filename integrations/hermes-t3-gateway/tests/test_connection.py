from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
PACKAGE = "hermes_t3_gateway_test"

package = types.ModuleType(PACKAGE)
package.__path__ = [str(ROOT)]
sys.modules.setdefault(PACKAGE, package)

for name in ("protocol", "connection"):
    spec = importlib.util.spec_from_file_location(
        f"{PACKAGE}.{name}", ROOT / f"{name}.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"{PACKAGE}.{name}"] = module
    spec.loader.exec_module(module)

connection = sys.modules[f"{PACKAGE}.connection"]


class FakeSocket:
    def __init__(self, response):
        self.response = response
        self.sent = []
        self.closed = False

    async def send(self, value):
        self.sent.append(json.loads(value))

    async def recv(self):
        request_id = self.sent[0]["requestId"]
        return json.dumps({**self.response, "requestId": request_id})

    async def close(self):
        self.closed = True


class ConnectionTests(unittest.IsolatedAsyncioTestCase):
    def test_url_normalization(self):
        self.assertEqual(
            connection.websocket_url("https://t3.example"),
            "wss://t3.example/api/hermes-gateway/ws",
        )
        self.assertEqual(
            connection.websocket_url("http://siva.davis7.space:8484/"),
            "ws://siva.davis7.space:8484/api/hermes-gateway/ws",
        )
        with self.assertRaises(ValueError):
            connection.websocket_url("ftp://invalid.example")

    async def test_enrollment_handshake_returns_credential(self):
        socket = FakeSocket(
            {
                "type": "connection.accepted",
                "protocolVersion": 1,
                "instanceId": "provider-instance",
                "nickname": "Research",
                "credential": "persistent-secret",
            }
        )
        accepted = await connection.authenticate_socket(
            socket,
            authentication={"type": "enrollment-token", "token": "once"},
            hermes_version="0.19.0",
        )
        self.assertEqual(accepted["credential"], "persistent-secret")
        self.assertEqual(
            socket.sent[0]["authentication"],
            {"type": "enrollment-token", "token": "once"},
        )

    async def test_rejected_handshake_fails_closed(self):
        socket = FakeSocket(
            {
                "type": "connection.rejected",
                "code": "version-incompatible",
                "message": "upgrade required",
                "expectedProtocolVersion": 1,
            }
        )
        with self.assertRaises(connection.ConnectionRejected) as raised:
            await connection.authenticate_socket(
                socket,
                authentication={
                    "type": "instance-credential",
                    "instanceId": "provider-instance",
                    "credential": "secret",
                },
                hermes_version="0.19.0",
            )
        self.assertEqual(raised.exception.code, "version-incompatible")


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import asyncio
import importlib.util
import json
import sys
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


class FakeRouter:
    def __init__(self) -> None:
        self.routes: list[tuple[str, str]] = []

    def _decorator(self, method: str, path: str):
        def decorate(function):
            self.routes.append((method, path))
            return function

        return decorate

    def get(self, path: str):
        return self._decorator("GET", path)

    def post(self, path: str):
        return self._decorator("POST", path)


class FakeHttpException(Exception):
    def __init__(self, *, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class FakeRequest:
    pass


class HermesPluginContractTest(unittest.TestCase):
    def test_manifest_and_root_entry_point_follow_hermes_contract(self) -> None:
        manifest = {}
        for line in (REPOSITORY_ROOT / "plugin.yaml").read_text(
            encoding="utf-8"
        ).splitlines():
            if not line or line[0].isspace() or ":" not in line:
                continue
            key, value = line.split(":", 1)
            manifest[key] = value.strip()
        self.assertEqual(manifest["name"], "t3code")
        self.assertEqual(manifest["kind"], "standalone")

        parent = types.ModuleType("hermes_plugins")
        parent.__path__ = []
        module_name = "hermes_plugins.t3code_contract_test"
        spec = importlib.util.spec_from_file_location(
            module_name,
            REPOSITORY_ROOT / "__init__.py",
            submodule_search_locations=[str(REPOSITORY_ROOT)],
        )
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"hermes_plugins": parent, module_name: module}):
            spec.loader.exec_module(module)
            self.assertTrue(callable(module.register))
            self.assertIsNone(module.register(object()))

    def test_dashboard_manifest_assets_and_api_routes_are_loadable(self) -> None:
        dashboard = REPOSITORY_ROOT / "dashboard"
        manifest = json.loads(
            (dashboard / "manifest.json").read_text(encoding="utf-8")
        )
        self.assertEqual(manifest["name"], "t3code")
        self.assertTrue((dashboard / manifest["entry"]).is_file())
        self.assertTrue((dashboard / manifest["css"]).is_file())
        self.assertTrue((dashboard / manifest["api"]).is_file())

        fake_fastapi = types.ModuleType("fastapi")
        fake_fastapi.APIRouter = FakeRouter
        fake_fastapi.HTTPException = FakeHttpException
        fake_fastapi.Request = FakeRequest
        spec = importlib.util.spec_from_file_location(
            "hermes_dashboard_plugin_t3code_contract_test",
            dashboard / manifest["api"],
        )
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"fastapi": fake_fastapi}):
            spec.loader.exec_module(module)

        self.assertEqual(
            module.router.routes,
            [
                ("GET", "/status"),
                ("POST", "/install"),
                ("POST", "/update"),
                ("POST", "/uninstall"),
            ],
        )

        active = 0
        peak = 0
        state_lock = threading.Lock()

        def install(_config):
            nonlocal active, peak
            with state_lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.02)
            with state_lock:
                active -= 1
            return {}

        async def invoke_concurrently() -> None:
            await asyncio.gather(
                module._run_action("install", FakeRequest()),
                module._run_action("install", FakeRequest()),
            )

        with (
            patch.object(module.service, "install", side_effect=install),
            patch.object(module, "_response", return_value={}),
        ):
            asyncio.run(invoke_concurrently())
            asyncio.run(invoke_concurrently())

        self.assertEqual(peak, 1)

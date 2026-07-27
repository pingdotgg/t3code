from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from integrations.hermes_plugin.config import load_config


class PluginConfigTest(unittest.TestCase):
    def test_resolves_runtime_and_s6_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch.dict(
                os.environ,
                {
                    "HERMES_HOME": str(root / "hermes"),
                    "T3CODE_HERMES_SERVICE_DIR": str(root / "service" / "t3code"),
                    "T3CODE_HERMES_PORT": "4773",
                    "T3CODE_HERMES_WATCH_INTERVAL_SECONDS": "60",
                    "T3CODE_HERMES_WATCH_MISSES": "3",
                },
                clear=False,
            ):
                config = load_config(plugin_root=root / "plugin")

        self.assertEqual(config.binary_path, root / "hermes" / "t3code" / "bin" / "t3")
        self.assertEqual(config.data_dir, root / "hermes" / "t3code" / "data")
        self.assertEqual(
            config.service_state_path,
            root / "hermes" / "t3code" / "service-state.json",
        )
        self.assertEqual(
            config.lifecycle_lock_path,
            root / "hermes" / "t3code" / "service-lifecycle.lock",
        )
        self.assertEqual(config.port, 4773)
        self.assertEqual(
            config.watchdog_service_dir, root / "service" / "t3code-plugin-watchdog"
        )
        self.assertEqual(config.watch_interval_seconds, 60)
        self.assertEqual(config.watch_misses, 3)

    def test_rejects_invalid_repository(self) -> None:
        with patch.dict(
            os.environ, {"T3CODE_HERMES_REPOSITORY": "../not-a-repository"}, clear=False
        ):
            with self.assertRaisesRegex(ValueError, "owner/repository"):
                load_config(plugin_root=Path.cwd())

    def test_uses_the_standard_hermes_identity_when_running_as_root(self) -> None:
        with (
            patch.dict(
                os.environ,
                {
                    "T3CODE_HERMES_SERVICE_USER": "",
                    "T3CODE_HERMES_SERVICE_GROUP": "",
                },
                clear=False,
            ),
            patch("integrations.hermes_plugin.config.os.geteuid", return_value=0),
        ):
            config = load_config(plugin_root=Path.cwd())

        self.assertEqual(config.service_user, "hermes")
        self.assertIsNone(config.service_group)

from __future__ import annotations

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

from integrations.hermes_plugin.config import load_config
from integrations.hermes_plugin.releases import ReleaseAsset
from integrations.hermes_plugin.service import (
    ServiceStatus,
    _render_watchdog_run,
    _t3_service_args,
    install,
    update,
)


class ServiceDefinitionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.config = load_config(plugin_root=root / "plugin")

    def test_uses_t3_native_s6_service_command(self) -> None:
        config = replace(
            self.config,
            hermes_home=(Path(self.temporary.name) / "Hermes' Home=production").resolve(),
        )

        for action in ("install", "update"):
            with self.subTest(action=action):
                args = _t3_service_args(config, action)

                self.assertEqual(args[0], str(config.binary_path))
                self.assertEqual(args[1:3], ["service", action])
                self.assertIn("--supervisor", args)
                self.assertIn("s6", args)
                self.assertIn(str(config.service_dir), args)
                self.assertIn("--host", args)
                self.assertIn("--port", args)
                self.assertIn("--service-user", args)
                self.assertIn(config.service_user, args)
                self.assertEqual(args.count("--service-environment"), 1)
                environment_index = args.index("--service-environment")
                self.assertEqual(
                    args[environment_index + 1],
                    f"HERMES_HOME={config.hermes_home}",
                )

        self.assertNotIn("--service-environment", _t3_service_args(config, "uninstall"))

    def test_watchdog_definition_tracks_plugin_and_both_services(self) -> None:
        run = _render_watchdog_run(
            self.config, self.config.runtime_root / "plugin-watchdog.py"
        )

        self.assertTrue(run.startswith("#!/bin/sh\nset -eu\nexec "))
        self.assertIn(str(self.config.plugin_root), run)
        self.assertIn(str(self.config.service_dir), run)
        self.assertIn(str(self.config.watchdog_service_dir), run)
        self.assertIn(str(self.config.watch_interval_seconds), run)
        self.assertIn(str(self.config.watch_misses), run)

    def test_install_delegates_the_service_definition_to_t3(self) -> None:
        root = Path(self.temporary.name)
        config = replace(
            self.config,
            service_dir=root / "service" / "t3code",
            watchdog_service_dir=root / "service" / "t3code-plugin-watchdog",
        )
        release = ReleaseAsset(
            version="1.2.3",
            tag="v1.2.3",
            binary_url="https://example.test/t3",
            checksum_url="https://example.test/t3.sha256",
        )
        current = ServiceStatus(
            binary_installed=True,
            binary_version="1.2.3",
            service_installed=True,
            service_running=True,
            watchdog_installed=True,
            watchdog_running=True,
            reachable=True,
            host=config.host,
            port=config.port,
            service_dir=str(config.service_dir),
            data_dir=str(config.data_dir),
        )
        completed = CompletedProcess(args=[], returncode=0, stdout="", stderr="")

        with (
            patch(
                "integrations.hermes_plugin.service.install_release",
                return_value=release,
            ),
            patch(
                "integrations.hermes_plugin.service._command",
                return_value=completed,
            ) as command,
            patch("integrations.hermes_plugin.service._install_watchdog") as watchdog,
            patch(
                "integrations.hermes_plugin.service.status",
                return_value=current,
            ),
        ):
            result = install(config)

        command.assert_called_once_with(_t3_service_args(config, "install"), timeout=45)
        watchdog.assert_called_once_with(config)
        self.assertEqual(result["release"], "1.2.3")
        self.assertEqual(result["status"]["port"], config.port)

    def test_update_delegates_restart_to_the_native_service_command(self) -> None:
        root = Path(self.temporary.name)
        config = replace(
            self.config,
            service_dir=root / "service" / "t3code",
            watchdog_service_dir=root / "service" / "t3code-plugin-watchdog",
        )
        release = ReleaseAsset(
            version="1.2.4",
            tag="v1.2.4",
            binary_url="https://example.test/t3",
            checksum_url="https://example.test/t3.sha256",
        )
        current = ServiceStatus(
            binary_installed=True,
            binary_version="1.2.4",
            service_installed=True,
            service_running=True,
            watchdog_installed=True,
            watchdog_running=True,
            reachable=True,
            host=config.host,
            port=config.port,
            service_dir=str(config.service_dir),
            data_dir=str(config.data_dir),
        )
        completed = CompletedProcess(args=[], returncode=0, stdout="", stderr="")

        with (
            patch(
                "integrations.hermes_plugin.service.install_release",
                return_value=release,
            ),
            patch(
                "integrations.hermes_plugin.service._command",
                return_value=completed,
            ) as command,
            patch("integrations.hermes_plugin.service._install_watchdog") as watchdog,
            patch(
                "integrations.hermes_plugin.service.status",
                return_value=current,
            ),
        ):
            result = update(config)

        command.assert_called_once_with(_t3_service_args(config, "update"), timeout=45)
        watchdog.assert_called_once_with(config)
        self.assertEqual(result["release"], "1.2.4")

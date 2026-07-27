from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
import time
import unittest
from dataclasses import replace
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

from integrations.hermes_plugin import service as service_module
from integrations.hermes_plugin.config import load_config
from integrations.hermes_plugin.releases import ReleaseAsset
from integrations.hermes_plugin.service import (
    ServiceError,
    ServiceStatus,
    _install_watchdog,
    _remove_service_dir,
    _render_watchdog_run,
    _set_desired_state,
    _t3_service_args,
    install,
    lifecycle_lock,
    reconcile,
    status,
    uninstall,
    update,
)


class ServiceDefinitionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.config = load_config(plugin_root=root / "plugin")

    def test_removes_only_top_level_s6_svperms_and_preserves_script(self) -> None:
        service_dir = Path(self.temporary.name) / "service" / "t3code"
        service_dir.mkdir(parents=True)
        run_path = service_dir / "run"
        run_path.write_text(
            "#!/bin/sh\n"
            "set -eu\n"
            "s6-svperms -G hermes /run/service/t3code\n"
            "  s6-svperms nested-is-not-top-level\n"
            "exec s6-setuidgid hermes t3 serve\n",
            encoding="utf-8",
        )
        run_path.chmod(0o751)

        service_module._remove_redundant_s6_svperms(service_dir)

        self.assertEqual(
            run_path.read_text(encoding="utf-8"),
            "#!/bin/sh\n"
            "set -eu\n"
            "  s6-svperms nested-is-not-top-level\n"
            "exec s6-setuidgid hermes t3 serve\n",
        )
        self.assertEqual(run_path.stat().st_mode & 0o777, 0o751)

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
        watchdog_path = self.config.watchdog_service_dir / "plugin-watchdog.py"
        run = _render_watchdog_run(self.config, watchdog_path)

        self.assertTrue(run.startswith("#!/bin/sh\nset -eu\nexec "))
        self.assertNotIn("s6-setuidgid", run)
        self.assertIn(str(watchdog_path), run)
        self.assertIn(str(self.config.plugin_root), run)
        self.assertIn(str(self.config.service_dir), run)
        self.assertIn(str(self.config.watchdog_service_dir), run)
        self.assertIn(str(self.config.service_state_path), run)
        self.assertIn(str(self.config.lifecycle_lock_path), run)
        self.assertIn(str(self.config.watch_interval_seconds), run)
        self.assertIn(str(self.config.watch_misses), run)

    def test_watchdog_executable_is_copied_into_its_ephemeral_slot(self) -> None:
        root = Path(self.temporary.name)
        config = replace(
            self.config,
            service_dir=root / "service" / "t3code",
            watchdog_service_dir=root / "service" / "t3code-plugin-watchdog",
        )
        completed = CompletedProcess(args=[], returncode=0, stdout="", stderr="")

        with (
            patch(
                "integrations.hermes_plugin.service._command",
                return_value=completed,
            ),
            patch(
                "integrations.hermes_plugin.service._wait_for_service_up",
                return_value=123,
            ),
            patch("integrations.hermes_plugin.service._seed_supervise_skeleton"),
        ):
            _install_watchdog(config)

        watchdog_path = config.watchdog_service_dir / "plugin-watchdog.py"
        self.assertTrue(watchdog_path.is_file())
        run = (config.watchdog_service_dir / "run").read_text(encoding="utf-8")
        self.assertIn(str(watchdog_path), run)
        self.assertNotIn(str(config.runtime_root / "plugin-watchdog.py"), run)

    def test_install_delegates_the_service_definition_to_t3(self) -> None:
        root = Path(self.temporary.name)
        config = replace(
            self.config,
            runtime_root=root / "runtime",
            binary_path=root / "runtime" / "bin" / "t3",
            data_dir=root / "runtime" / "data",
            service_dir=root / "service" / "t3code",
            watchdog_service_dir=root / "service" / "t3code-plugin-watchdog",
        )
        config.binary_path.parent.mkdir(parents=True)
        config.binary_path.write_bytes(b"verified t3 binary")
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

        def write_service(args, **_kwargs):
            config.service_dir.mkdir(parents=True, exist_ok=True)
            run_path = config.service_dir / "run"
            run_path.write_text(
                "#!/bin/sh\ns6-svperms -G hermes service\nexec t3 serve\n",
                encoding="utf-8",
            )
            run_path.chmod(0o751)
            return completed

        with (
            patch(
                "integrations.hermes_plugin.service.install_release",
                return_value=release,
            ),
            patch(
                "integrations.hermes_plugin.service._command",
                side_effect=write_service,
            ) as command,
            patch(
                "integrations.hermes_plugin.service._verify_t3_service_up",
                return_value=123,
            ),
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
        state = json.loads(config.service_state_path.read_text(encoding="utf-8"))
        self.assertEqual(state["desired_state"], "installed")
        self.assertEqual(state["binary_version"], "1.2.3")
        run_path = config.service_dir / "run"
        self.assertEqual(
            run_path.read_text(encoding="utf-8"),
            "#!/bin/sh\nexec t3 serve\n",
        )
        self.assertEqual(run_path.stat().st_mode & 0o777, 0o751)

    def test_update_delegates_restart_to_the_native_service_command(self) -> None:
        root = Path(self.temporary.name)
        config = replace(
            self.config,
            runtime_root=root / "runtime",
            binary_path=root / "runtime" / "bin" / "t3",
            data_dir=root / "runtime" / "data",
            service_dir=root / "service" / "t3code",
            watchdog_service_dir=root / "service" / "t3code-plugin-watchdog",
        )
        config.binary_path.parent.mkdir(parents=True)
        config.binary_path.write_bytes(b"verified updated t3 binary")
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

        def write_service(args, **_kwargs):
            config.service_dir.mkdir(parents=True, exist_ok=True)
            run_path = config.service_dir / "run"
            run_path.write_text(
                "#!/bin/sh\ns6-svperms -G hermes service\nexec t3 serve\n",
                encoding="utf-8",
            )
            run_path.chmod(0o751)
            return completed

        with (
            patch(
                "integrations.hermes_plugin.service.install_release",
                return_value=release,
            ),
            patch(
                "integrations.hermes_plugin.service._command",
                side_effect=write_service,
            ) as command,
            patch(
                "integrations.hermes_plugin.service._verify_t3_service_up",
                return_value=123,
            ),
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
        state = json.loads(config.service_state_path.read_text(encoding="utf-8"))
        self.assertEqual(state["desired_state"], "installed")
        run_path = config.service_dir / "run"
        self.assertEqual(
            run_path.read_text(encoding="utf-8"),
            "#!/bin/sh\nexec t3 serve\n",
        )
        self.assertEqual(run_path.stat().st_mode & 0o777, 0o751)

    def test_failed_update_keeps_metadata_for_the_verified_replacement(
        self,
    ) -> None:
        root = Path(self.temporary.name)
        config = replace(
            self.config,
            runtime_root=root / "runtime",
            binary_path=root / "runtime" / "bin" / "t3",
            data_dir=root / "runtime" / "data",
            service_dir=root / "service" / "t3code",
            watchdog_service_dir=root / "service" / "t3code-plugin-watchdog",
        )
        config.binary_path.parent.mkdir(parents=True)
        config.binary_path.write_bytes(b"old binary")
        _set_desired_state(config, "installed", version="1.2.3")
        release = ReleaseAsset(
            version="1.2.4",
            tag="v1.2.4",
            binary_url="https://example.test/t3",
            checksum_url="https://example.test/t3.sha256",
        )
        replacement = b"new checksum-verified binary"

        def replace_release(_config):
            config.binary_path.write_bytes(replacement)
            return release

        with (
            patch(
                "integrations.hermes_plugin.service.install_release",
                side_effect=replace_release,
            ),
            patch(
                "integrations.hermes_plugin.service._command",
                side_effect=ServiceError("s6 activation failed"),
            ),
            self.assertRaisesRegex(ServiceError, "activation failed"),
        ):
            update(config)

        state = json.loads(config.service_state_path.read_text(encoding="utf-8"))
        self.assertEqual(state["binary_version"], "1.2.4")
        self.assertEqual(
            state["binary_sha256"],
            hashlib.sha256(replacement).hexdigest(),
        )

    def test_reconcile_restores_missing_ephemeral_services_from_desired_state(
        self,
    ) -> None:
        root = Path(self.temporary.name)
        config = replace(
            self.config,
            runtime_root=root / "runtime",
            binary_path=root / "runtime" / "bin" / "t3",
            data_dir=root / "runtime" / "data",
            service_dir=root / "service" / "t3code",
            watchdog_service_dir=root / "service" / "t3code-plugin-watchdog",
        )
        config.binary_path.parent.mkdir(parents=True)
        config.binary_path.write_text("#!/bin/sh\n", encoding="utf-8")
        config.binary_path.chmod(0o755)
        config.runtime_root.mkdir(parents=True, exist_ok=True)
        config.scan_dir.mkdir(parents=True, exist_ok=True)
        (config.runtime_root / "service-state.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "desired_state": "installed",
                    "binary_sha256": hashlib.sha256(
                        config.binary_path.read_bytes()
                    ).hexdigest(),
                }
            )
            + "\n",
            encoding="utf-8",
        )
        completed = CompletedProcess(args=[], returncode=0, stdout="", stderr="")

        def run_command(args, **_kwargs):
            if args[1:3] == ["service", "install"]:
                config.service_dir.mkdir(parents=True, exist_ok=True)
                run_path = config.service_dir / "run"
                run_path.write_text(
                    "#!/bin/sh\ns6-svperms -G hermes service\nexec t3 serve\n",
                    encoding="utf-8",
                )
                run_path.chmod(0o751)
            return completed

        def install_watchdog(_config) -> None:
            config.watchdog_service_dir.mkdir(parents=True, exist_ok=True)
            (config.watchdog_service_dir / "run").touch()

        with (
            patch(
                "integrations.hermes_plugin.service.binary_version",
                return_value="1.2.3",
            ),
            patch(
                "integrations.hermes_plugin.service._command",
                side_effect=run_command,
            ) as command,
            patch(
                "integrations.hermes_plugin.service._verify_t3_service_up",
                return_value=123,
            ),
            patch(
                "integrations.hermes_plugin.service._install_watchdog",
                side_effect=install_watchdog,
            ) as watchdog,
            patch(
                "integrations.hermes_plugin.service.install_release"
            ) as install_release,
        ):
            result = reconcile(config)

        self.assertEqual(result["action"], "recovered")
        command.assert_any_call(_t3_service_args(config, "install"), timeout=45)
        watchdog.assert_called_once_with(config)
        install_release.assert_not_called()
        run_path = config.service_dir / "run"
        self.assertEqual(
            run_path.read_text(encoding="utf-8"),
            "#!/bin/sh\nexec t3 serve\n",
        )
        self.assertEqual(run_path.stat().st_mode & 0o777, 0o751)

    def test_explicit_uninstall_prevents_later_recovery(self) -> None:
        root = Path(self.temporary.name)
        config = replace(
            self.config,
            runtime_root=root / "runtime",
            binary_path=root / "runtime" / "bin" / "t3",
            data_dir=root / "runtime" / "data",
            service_dir=root / "service" / "t3code",
            watchdog_service_dir=root / "service" / "t3code-plugin-watchdog",
        )
        config.binary_path.parent.mkdir(parents=True)
        config.binary_path.write_bytes(b"verified t3 binary")
        for service_dir in (config.service_dir, config.watchdog_service_dir):
            service_dir.mkdir(parents=True, exist_ok=True)
            (service_dir / "run").touch()
        completed = CompletedProcess(args=[], returncode=0, stdout="", stderr="")

        def run_command(args, **_kwargs):
            if args[0] == "s6-svok" and Path(args[1]).name.startswith("."):
                return CompletedProcess(args=args, returncode=1, stdout="", stderr="")
            return completed

        with patch(
            "integrations.hermes_plugin.service._command",
            side_effect=run_command,
        ) as command:
            result = uninstall(config)
            recovery = reconcile(config)

        state = json.loads(config.service_state_path.read_text(encoding="utf-8"))
        self.assertEqual(result["action"], "uninstalled")
        self.assertEqual(state["desired_state"], "uninstalled")
        self.assertEqual(recovery["action"], "not_requested")
        self.assertFalse(
            any(
                call.args
                and call.args[0][0] == str(config.binary_path)
                and call.args[0][1:3] == ["service", "install"]
                for call in command.call_args_list
            )
        )

    def test_reconcile_is_a_noop_when_both_slots_are_already_present(self) -> None:
        root = Path(self.temporary.name)
        config = replace(
            self.config,
            runtime_root=root / "runtime",
            binary_path=root / "runtime" / "bin" / "t3",
            data_dir=root / "runtime" / "data",
            service_dir=root / "service" / "t3code",
            watchdog_service_dir=root / "service" / "t3code-plugin-watchdog",
        )
        config.runtime_root.mkdir(parents=True)
        config.service_state_path.write_text(
            json.dumps({"version": 1, "desired_state": "installed"}) + "\n",
            encoding="utf-8",
        )
        config.service_dir.mkdir(parents=True)
        (config.service_dir / "run").write_text(
            "#!/bin/sh\n"
            "  # t3-service-environment:begin\n"
            f"  export HERMES_HOME='{config.hermes_home}'\n"
            "  # t3-service-environment:end\n"
            "exec t3 serve\n",
            encoding="utf-8",
        )
        config.watchdog_service_dir.mkdir(parents=True)
        (config.watchdog_service_dir / "run").touch()

        with (
            patch(
                "integrations.hermes_plugin.service._command",
                return_value=CompletedProcess(
                    args=[], returncode=0, stdout="up (pid 123) 1 seconds\n", stderr=""
                ),
            ) as command,
            patch(
                "integrations.hermes_plugin.service._install_watchdog"
            ) as watchdog,
            patch(
                "integrations.hermes_plugin.service.install_release"
            ) as install_release,
        ):
            result = reconcile(config)

        self.assertEqual(result["action"], "not_needed")
        self.assertEqual(command.call_count, 2)
        self.assertTrue(
            all(call.args[0][0] == "s6-svstat" for call in command.call_args_list)
        )
        watchdog.assert_not_called()
        install_release.assert_not_called()

    def test_reconcile_repairs_running_empty_environment_once(self) -> None:
        root = Path(self.temporary.name)
        config = replace(
            self.config,
            hermes_home=root / "hermes",
            runtime_root=root / "hermes" / "t3code",
            binary_path=root / "hermes" / "t3code" / "bin" / "t3",
            data_dir=root / "hermes" / "t3code" / "data",
            service_dir=root / "service" / "t3code",
            watchdog_service_dir=root / "service" / "t3code-plugin-watchdog",
        )
        config.binary_path.parent.mkdir(parents=True)
        config.binary_path.write_bytes(b"verified replacement binary")
        _set_desired_state(config, "installed", version="1.2.4")
        config.service_dir.mkdir(parents=True)
        service_run = config.service_dir / "run"
        service_run.write_text(
            "#!/bin/sh\n"
            "  # t3-service-environment:begin\n"
            "  # t3-service-environment:end\n"
            "s6-svperms -G hermes service\n"
            "exec old-deleted-launcher serve\n",
            encoding="utf-8",
        )
        service_run.chmod(0o700)
        config.watchdog_service_dir.mkdir(parents=True)
        (config.watchdog_service_dir / "run").touch()
        updates = 0

        def run_command(args, **_kwargs):
            nonlocal updates
            if args[0] == "s6-svstat":
                return CompletedProcess(
                    args=args,
                    returncode=0,
                    stdout=f"up (pid {456 if updates else 123}) 1 seconds\n",
                    stderr="",
                )
            if args[1:3] == ["service", "update"]:
                updates += 1
                service_run.write_text(
                    "#!/bin/sh\n"
                    "  # t3-service-environment:begin\n"
                    f"  export HERMES_HOME='{config.hermes_home}'\n"
                    "  # t3-service-environment:end\n"
                    "s6-svperms -G hermes service\n"
                    "exec current-launcher serve\n",
                    encoding="utf-8",
                )
                service_run.chmod(0o700)
                return CompletedProcess(
                    args=args,
                    returncode=0,
                    stdout="Updated T3 Code service.\n",
                    stderr="",
                )
            raise AssertionError(f"unexpected command: {args[0]}")

        with (
            patch(
                "integrations.hermes_plugin.service.binary_version",
                return_value="1.2.4",
            ),
            patch(
                "integrations.hermes_plugin.service._command",
                side_effect=run_command,
            ) as command,
            patch(
                "integrations.hermes_plugin.service._process_has_expected_hermes_home",
                return_value=True,
            ),
            patch(
                "integrations.hermes_plugin.service.install_release"
            ) as install_release,
        ):
            repaired = reconcile(config)
            current = reconcile(config)

        self.assertEqual(repaired["action"], "repaired")
        self.assertEqual(current["action"], "not_needed")
        self.assertEqual(updates, 1)
        command.assert_any_call(_t3_service_args(config, "update"), timeout=45)
        self.assertIn(
            f"  export HERMES_HOME='{config.hermes_home}'\n",
            service_run.read_text(encoding="utf-8"),
        )
        self.assertNotIn(
            "s6-svperms ",
            service_run.read_text(encoding="utf-8"),
        )
        install_release.assert_not_called()

    def test_update_success_is_not_repaired_when_service_never_stably_starts(
        self,
    ) -> None:
        root = Path(self.temporary.name)
        config = replace(
            self.config,
            hermes_home=root / "hermes",
            runtime_root=root / "hermes" / "t3code",
            binary_path=root / "hermes" / "t3code" / "bin" / "t3",
            data_dir=root / "hermes" / "t3code" / "data",
            service_dir=root / "service" / "t3code",
            watchdog_service_dir=root / "service" / "t3code-plugin-watchdog",
        )
        config.binary_path.parent.mkdir(parents=True)
        config.binary_path.write_bytes(b"verified replacement binary")
        _set_desired_state(config, "installed", version="1.2.4")
        config.service_dir.mkdir(parents=True)
        service_run = config.service_dir / "run"
        service_run.write_text(
            "#!/bin/sh\n"
            "  # t3-service-environment:begin\n"
            "  # t3-service-environment:end\n"
            "exec old-deleted-launcher serve\n",
            encoding="utf-8",
        )
        config.watchdog_service_dir.mkdir(parents=True)
        (config.watchdog_service_dir / "run").touch()

        def run_command(args, **_kwargs):
            if args[0] == "s6-svstat":
                return CompletedProcess(
                    args=args,
                    returncode=0,
                    stdout="down (exitcode 1) 0 seconds\n",
                    stderr="",
                )
            if args[1:3] == ["service", "update"]:
                service_run.write_text(
                    "#!/bin/sh\n"
                    "  # t3-service-environment:begin\n"
                    f"  export HERMES_HOME='{config.hermes_home}'\n"
                    "  # t3-service-environment:end\n"
                    "exec current-launcher serve\n",
                    encoding="utf-8",
                )
                return CompletedProcess(args=args, returncode=0, stdout="", stderr="")
            raise AssertionError(f"unexpected command: {args}")

        with (
            patch(
                "integrations.hermes_plugin.service.binary_version",
                return_value="1.2.4",
            ),
            patch(
                "integrations.hermes_plugin.service._command",
                side_effect=run_command,
            ),
            patch(
                "integrations.hermes_plugin.service._SERVICE_START_TIMEOUT_SECONDS",
                0,
                create=True,
            ),
            patch(
                "integrations.hermes_plugin.service._reachable",
                return_value=False,
            ),
            self.assertRaisesRegex(ServiceError, "stable positive pid"),
        ):
            reconcile(config)

        current = status(config)
        self.assertEqual(current.reconciliation_status, "failed")
        self.assertNotEqual(current.reconciliation_status, "repaired")

    def test_stable_service_verification_requires_same_positive_pid_twice(
        self,
    ) -> None:
        service_dir = Path(self.temporary.name) / "service" / "t3code"
        service_dir.mkdir(parents=True)
        (service_dir / "run").touch()
        outputs = iter(
            [
                "up (pid -1) 0 seconds\n",
                "up (pid 41) 0 seconds\n",
                "up (pid 42) 0 seconds\n",
                "up (pid 42) 1 seconds\n",
            ]
        )

        with (
            patch(
                "integrations.hermes_plugin.service._command",
                side_effect=lambda args, **_kwargs: CompletedProcess(
                    args=args,
                    returncode=0,
                    stdout=next(outputs),
                    stderr="",
                ),
            ) as command,
            patch("integrations.hermes_plugin.service.time.sleep"),
        ):
            pid = service_module._wait_for_service_up(
                service_dir,
                timeout=5,
                poll_interval=0,
                stable_seconds=0,
            )

        self.assertEqual(pid, 42)
        self.assertEqual(command.call_count, 4)

    def test_split_brain_cleanup_refuses_ambiguous_exact_orphans(self) -> None:
        candidates = [
            service_module._StaleServiceProcess(child_pid=2882, supervisor_pid=2850),
            service_module._StaleServiceProcess(child_pid=3882, supervisor_pid=3850),
        ]

        with (
            patch(
                "integrations.hermes_plugin.service._find_stale_service_processes",
                return_value=candidates,
            ),
            patch("integrations.hermes_plugin.service.os.pidfd_open") as pidfd_open,
            self.assertRaisesRegex(ServiceError, "2 exact stale service processes"),
        ):
            service_module._terminate_exact_stale_service(self.config)

        pidfd_open.assert_not_called()

    def test_finds_only_exact_deleted_slot_process_that_owns_configured_port(
        self,
    ) -> None:
        proc_root = Path(self.temporary.name) / "proc"
        (proc_root / "net").mkdir(parents=True)
        (proc_root / "net" / "tcp").write_text(
            "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when "
            "retrnsmt   uid  timeout inode\n"
            "   0: 00000000:0EBD 00000000:0000 0A 00000000:00000000 00:00000000 "
            "00000000 10000 0 555\n",
            encoding="ascii",
        )
        config = replace(
            self.config,
            binary_path=Path("/opt/data/t3code/bin/t3"),
            service_dir=Path("/run/service/t3code"),
            watchdog_service_dir=Path("/run/service/t3code-plugin-watchdog"),
            service_user="10000",
            port=3773,
        )

        child = proc_root / "2882"
        (child / "fd").mkdir(parents=True)
        (child / "status").write_text(
            "Name:\tt3\nPPid:\t2850\nUid:\t10000\t10000\t10000\t10000\n",
            encoding="utf-8",
        )
        (child / "cmdline").write_bytes(b"/opt/data/t3code/bin/t3\0serve\0")
        os.symlink("/opt/data/t3code/bin/t3 (deleted)", child / "exe")
        os.symlink("/run/service/t3code (deleted)", child / "cwd")
        os.symlink("socket:[555]", child / "fd" / "3")

        supervisor = proc_root / "2850"
        supervisor.mkdir()
        (supervisor / "status").write_text(
            "Name:\ts6-supervise\nPPid:\t1\nUid:\t0\t0\t0\t0\n",
            encoding="utf-8",
        )
        (supervisor / "cmdline").write_bytes(
            b"/command/s6-supervise\0t3code\0"
        )
        os.symlink("/command/s6-supervise", supervisor / "exe")
        os.symlink("/run/service/t3code (deleted)", supervisor / "cwd")

        self.assertEqual(
            service_module._find_stale_service_processes(
                config,
                proc_root=proc_root,
            ),
            [
                service_module._StaleServiceProcess(
                    child_pid=2882,
                    supervisor_pid=2850,
                )
            ],
        )

    def test_live_process_must_have_exact_configured_hermes_home(self) -> None:
        proc_root = Path(self.temporary.name) / "proc"
        process = proc_root / "9621"
        process.mkdir(parents=True)
        process.joinpath("environ").write_bytes(
            b"PATH=/usr/bin\0HERMES_HOME=/opt/data\0"
        )
        config = replace(self.config, hermes_home=Path("/opt/data"))

        self.assertTrue(
            service_module._process_has_expected_hermes_home(
                9621,
                config,
                proc_root=proc_root,
            )
        )
        process.joinpath("environ").write_bytes(b"PATH=/usr/bin\0")
        self.assertFalse(
            service_module._process_has_expected_hermes_home(
                9621,
                config,
                proc_root=proc_root,
            )
        )

    def test_missing_live_hermes_home_fails_without_orphan_cleanup(self) -> None:
        with (
            patch(
                "integrations.hermes_plugin.service._wait_for_service_up",
                return_value=9621,
            ),
            patch(
                "integrations.hermes_plugin.service._process_has_expected_hermes_home",
                return_value=False,
            ),
            patch(
                "integrations.hermes_plugin.service._terminate_exact_stale_service",
            ) as terminate,
            self.assertRaisesRegex(ServiceError, "missing the configured HERMES_HOME"),
        ):
            service_module._verify_t3_service_up(self.config)

        terminate.assert_not_called()

    def test_failed_start_reaps_exact_old_service_then_verifies_current_slot(
        self,
    ) -> None:
        root = Path(self.temporary.name)
        config = replace(
            self.config,
            service_dir=root / "service" / "t3code",
            watchdog_service_dir=root / "service" / "t3code-plugin-watchdog",
        )
        service_dir = config.service_dir
        service_dir.mkdir(parents=True)
        (service_dir / "run").touch()

        with (
            patch(
                "integrations.hermes_plugin.service._wait_for_service_up",
                side_effect=[
                    ServiceError("never reached a stable positive pid"),
                    9621,
                ],
            ) as wait_for_up,
            patch(
                "integrations.hermes_plugin.service._reachable",
                return_value=True,
            ),
            patch(
                "integrations.hermes_plugin.service._terminate_exact_stale_service",
            ) as terminate,
            patch(
                "integrations.hermes_plugin.service._process_has_expected_hermes_home",
                return_value=True,
            ),
            patch(
                "integrations.hermes_plugin.service._command",
                return_value=CompletedProcess(
                    args=[],
                    returncode=0,
                    stdout="",
                    stderr="",
                ),
            ) as command,
        ):
            pid = service_module._verify_t3_service_up(config)

        self.assertEqual(pid, 9621)
        terminate.assert_called_once_with(config)
        command.assert_called_once_with(
            ["s6-svc", "-u", str(service_dir)],
            timeout=5,
        )
        self.assertEqual(wait_for_up.call_count, 2)

    def test_watchdog_update_reuses_existing_supervised_slot(self) -> None:
        root = Path(self.temporary.name)
        config = replace(
            self.config,
            service_dir=root / "service" / "t3code",
            watchdog_service_dir=root / "service" / "t3code-plugin-watchdog",
        )
        config.watchdog_service_dir.mkdir(parents=True)
        old_run = config.watchdog_service_dir / "run"
        old_run.write_text("#!/bin/sh\nexec old-watchdog\n", encoding="utf-8")
        slot_inode = config.watchdog_service_dir.stat().st_ino

        with (
            patch(
                "integrations.hermes_plugin.service._command",
                return_value=CompletedProcess(
                    args=[],
                    returncode=0,
                    stdout="",
                    stderr="",
                ),
            ),
            patch(
                "integrations.hermes_plugin.service._wait_for_service_up",
                return_value=99,
            ),
            patch(
                "integrations.hermes_plugin.service._remove_service_dir"
            ) as remove_service_dir,
        ):
            _install_watchdog(config)

        self.assertEqual(config.watchdog_service_dir.stat().st_ino, slot_inode)
        remove_service_dir.assert_not_called()
        self.assertIn(
            "plugin-watchdog.py",
            old_run.read_text(encoding="utf-8"),
        )

    def test_incomplete_supervisor_reap_blocks_duplicate_scan_name(self) -> None:
        service_dir = Path(self.temporary.name) / "service" / "t3code"
        tombstone = service_dir.with_name(".t3code.removing.2850")
        tombstone.mkdir(parents=True)

        with (
            patch(
                "integrations.hermes_plugin.service._command",
                return_value=CompletedProcess(
                    args=[],
                    returncode=0,
                    stdout="",
                    stderr="",
                ),
            ),
            self.assertRaisesRegex(ServiceError, "old supervisor removal"),
        ):
            service_module._prepare_service_dir(service_dir)

        self.assertFalse(service_dir.exists())
        self.assertTrue(tombstone.exists())

    def test_reaped_tombstone_is_removed_before_reusing_scan_name(self) -> None:
        service_dir = Path(self.temporary.name) / "service" / "t3code"
        tombstone = service_dir.with_name(".t3code.removing.2850")
        tombstone.mkdir(parents=True)

        with (
            patch(
                "integrations.hermes_plugin.service._command",
                return_value=CompletedProcess(
                    args=[],
                    returncode=1,
                    stdout="",
                    stderr="",
                ),
            ),
            patch("integrations.hermes_plugin.service._seed_supervise_skeleton"),
        ):
            service_module._prepare_service_dir(service_dir)

        self.assertTrue(service_dir.is_dir())
        self.assertFalse(tombstone.exists())

    def test_reconcile_adapts_complete_stopped_service_before_starting(
        self,
    ) -> None:
        root = Path(self.temporary.name)
        config = replace(
            self.config,
            runtime_root=root / "runtime",
            binary_path=root / "runtime" / "bin" / "t3",
            data_dir=root / "runtime" / "data",
            service_dir=root / "service" / "t3code",
            watchdog_service_dir=root / "service" / "t3code-plugin-watchdog",
        )
        config.binary_path.parent.mkdir(parents=True)
        config.binary_path.write_bytes(b"verified binary")
        config.service_state_path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "desired_state": "installed",
                    "binary_sha256": hashlib.sha256(
                        config.binary_path.read_bytes()
                    ).hexdigest(),
                }
            )
            + "\n",
            encoding="utf-8",
        )
        config.service_dir.mkdir(parents=True)
        service_run = config.service_dir / "run"
        service_run.write_text(
            "#!/bin/sh\n"
            "  # t3-service-environment:begin\n"
            f"  export HERMES_HOME='{config.hermes_home}'\n"
            "  # t3-service-environment:end\n"
            "s6-svperms -G hermes service\n"
            "exec t3 serve\n",
            encoding="utf-8",
        )
        service_run.chmod(0o751)
        config.watchdog_service_dir.mkdir(parents=True)
        (config.watchdog_service_dir / "run").touch()

        def run_command(args, **_kwargs):
            return CompletedProcess(
                args=args,
                returncode=0,
                stdout="down (exitcode 0) 1 seconds\n"
                if args[0] == "s6-svstat"
                else "",
                stderr="",
            )

        with (
            patch(
                "integrations.hermes_plugin.service.binary_version",
                return_value="1.2.3",
            ),
            patch(
                "integrations.hermes_plugin.service._command",
                side_effect=run_command,
            ) as command,
            patch(
                "integrations.hermes_plugin.service._verify_t3_service_up",
                return_value=123,
            ),
            patch(
                "integrations.hermes_plugin.service._wait_for_service_up",
                return_value=124,
            ),
            patch(
                "integrations.hermes_plugin.service._install_watchdog"
            ) as watchdog,
        ):
            result = reconcile(config)

        self.assertEqual(result["action"], "started")
        command.assert_any_call(["s6-svc", "-u", str(config.service_dir)], timeout=5)
        command.assert_any_call(
            ["s6-svc", "-u", str(config.watchdog_service_dir)],
            timeout=5,
        )
        watchdog.assert_not_called()
        self.assertEqual(
            service_run.read_text(encoding="utf-8"),
            "#!/bin/sh\n"
            "  # t3-service-environment:begin\n"
            f"  export HERMES_HOME='{config.hermes_home}'\n"
            "  # t3-service-environment:end\n"
            "exec t3 serve\n",
        )
        self.assertEqual(service_run.stat().st_mode & 0o777, 0o751)

    def test_recovery_failure_is_exposed_without_hiding_service_status(self) -> None:
        root = Path(self.temporary.name)
        config = replace(
            self.config,
            runtime_root=root / "runtime",
            binary_path=root / "runtime" / "bin" / "missing-t3",
            data_dir=root / "runtime" / "data",
            service_dir=root / "service" / "t3code",
            watchdog_service_dir=root / "service" / "t3code-plugin-watchdog",
        )
        config.runtime_root.mkdir(parents=True)
        config.service_state_path.write_text(
            json.dumps({"version": 1, "desired_state": "installed"}) + "\n",
            encoding="utf-8",
        )

        with self.assertRaisesRegex(ServiceError, "Install and start"):
            reconcile(config)

        current = status(config)
        self.assertFalse(current.binary_installed)
        self.assertEqual(current.desired_state, "installed")
        self.assertEqual(current.reconciliation_status, "failed")
        self.assertIn("Install and start", current.reconciliation_error or "")

        config.binary_path.parent.mkdir(parents=True)
        config.binary_path.write_bytes(b"replacement verified binary")
        _set_desired_state(config, "installed", version="1.2.4")
        repaired = status(config)
        self.assertEqual(repaired.reconciliation_status, "idle")
        self.assertIsNone(repaired.reconciliation_error)

    def test_legacy_binary_without_explicit_intent_is_not_executed_or_recovered(
        self,
    ) -> None:
        root = Path(self.temporary.name)
        config = replace(
            self.config,
            runtime_root=root / "runtime",
            binary_path=root / "runtime" / "bin" / "t3",
            data_dir=root / "runtime" / "data",
            service_dir=root / "service" / "t3code",
            watchdog_service_dir=root / "service" / "t3code-plugin-watchdog",
        )
        config.binary_path.parent.mkdir(parents=True)
        config.binary_path.write_bytes(b"legacy verified t3 binary")
        with (
            patch(
                "integrations.hermes_plugin.service.binary_version",
            ) as binary_version,
            patch(
                "integrations.hermes_plugin.service.install_release"
            ) as install_release,
        ):
            result = reconcile(config)

        self.assertEqual(result["action"], "not_requested")
        self.assertFalse(config.service_state_path.exists())
        binary_version.assert_not_called()
        install_release.assert_not_called()

    def test_uninstall_does_not_touch_slots_if_intent_cannot_be_persisted(
        self,
    ) -> None:
        config = replace(
            self.config,
            runtime_root=Path(self.temporary.name) / "runtime",
            binary_path=Path(self.temporary.name) / "runtime" / "bin" / "t3",
            data_dir=Path(self.temporary.name) / "runtime" / "data",
        )
        with (
            patch(
                "integrations.hermes_plugin.service._set_desired_state",
                side_effect=ServiceError("state volume is read-only"),
            ),
            patch(
                "integrations.hermes_plugin.service._remove_service_dir"
            ) as remove_service_dir,
        ):
            with self.assertRaisesRegex(ServiceError, "read-only"):
                uninstall(config)

        remove_service_dir.assert_not_called()

    def test_reconcile_rejects_a_changed_installed_binary(self) -> None:
        root = Path(self.temporary.name)
        config = replace(
            self.config,
            runtime_root=root / "runtime",
            binary_path=root / "runtime" / "bin" / "t3",
            data_dir=root / "runtime" / "data",
            service_dir=root / "service" / "t3code",
            watchdog_service_dir=root / "service" / "t3code-plugin-watchdog",
        )
        config.binary_path.parent.mkdir(parents=True)
        config.binary_path.write_bytes(b"changed binary")
        config.service_state_path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "desired_state": "installed",
                    "binary_sha256": "0" * 64,
                }
            )
            + "\n",
            encoding="utf-8",
        )

        with (
            patch(
                "integrations.hermes_plugin.service.binary_version",
                return_value="1.2.3",
            ),
            self.assertRaisesRegex(ServiceError, "checksum mismatch"),
        ):
            reconcile(config)

    def test_checksum_mismatch_is_rejected_before_binary_execution(self) -> None:
        root = Path(self.temporary.name)
        config = replace(
            self.config,
            runtime_root=root / "runtime",
            binary_path=root / "runtime" / "bin" / "t3",
            data_dir=root / "runtime" / "data",
            service_dir=root / "service" / "t3code",
            watchdog_service_dir=root / "service" / "t3code-plugin-watchdog",
        )
        config.binary_path.parent.mkdir(parents=True)
        config.binary_path.write_bytes(b"tampered binary")
        config.service_state_path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "desired_state": "installed",
                    "binary_sha256": "0" * 64,
                }
            )
            + "\n",
            encoding="utf-8",
        )

        with (
            patch(
                "integrations.hermes_plugin.service.binary_version"
            ) as binary_version,
            self.assertRaisesRegex(ServiceError, "checksum mismatch"),
        ):
            reconcile(config)

        binary_version.assert_not_called()

    def test_lifecycle_lock_serializes_independent_callers(self) -> None:
        config = replace(
            self.config,
            runtime_root=Path(self.temporary.name) / "runtime",
            binary_path=Path(self.temporary.name) / "runtime" / "bin" / "t3",
            data_dir=Path(self.temporary.name) / "runtime" / "data",
        )
        active = 0
        peak = 0
        counter_lock = threading.Lock()

        def enter() -> None:
            nonlocal active, peak
            with lifecycle_lock(config):
                with counter_lock:
                    active += 1
                    peak = max(peak, active)
                time.sleep(0.02)
                with counter_lock:
                    active -= 1

        threads = [threading.Thread(target=enter) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(peak, 1)

    def test_reconcile_lock_failure_is_reported_in_status(self) -> None:
        config = replace(
            self.config,
            runtime_root=Path(self.temporary.name) / "runtime",
            binary_path=Path(self.temporary.name) / "runtime" / "bin" / "t3",
            data_dir=Path(self.temporary.name) / "runtime" / "data",
            service_dir=Path(self.temporary.name) / "service" / "t3code",
            watchdog_service_dir=Path(self.temporary.name)
            / "service"
            / "t3code-plugin-watchdog",
        )

        with (
            patch(
                "integrations.hermes_plugin.service.lifecycle_lock",
                side_effect=ServiceError("lifecycle lock is read-only"),
            ),
            self.assertRaisesRegex(ServiceError, "read-only"),
        ):
            reconcile(config)

        current = status(config)
        self.assertEqual(current.reconciliation_status, "failed")
        self.assertEqual(
            current.reconciliation_error,
            "lifecycle lock is read-only",
        )

    def test_root_dashboard_preserves_runtime_owner_on_lifecycle_files(
        self,
    ) -> None:
        root = Path(self.temporary.name)
        config = replace(
            self.config,
            runtime_root=root / "runtime",
            binary_path=root / "runtime" / "bin" / "t3",
            data_dir=root / "runtime" / "data",
        )
        config.binary_path.parent.mkdir(parents=True)
        config.binary_path.write_bytes(b"verified t3 binary")
        owner = config.runtime_root.stat()

        with (
            patch(
                "integrations.hermes_plugin.service.os.geteuid",
                return_value=0,
            ),
            patch(
                "integrations.hermes_plugin.service.os.fchown"
            ) as fchown,
        ):
            with lifecycle_lock(config):
                pass
            _set_desired_state(config, "installed", version="1.2.3")

        self.assertEqual(fchown.call_count, 2)
        for call in fchown.call_args_list:
            self.assertEqual(call.args[1:], (owner.st_uid, owner.st_gid))

    def test_remove_does_not_delete_when_supervisor_commands_cannot_run(
        self,
    ) -> None:
        service_dir = Path(self.temporary.name) / "service" / "t3code"
        service_dir.mkdir(parents=True)
        (service_dir / "run").touch()

        with (
            patch(
                "integrations.hermes_plugin.service._command",
                side_effect=ServiceError("s6 unavailable"),
            ),
            patch(
                "integrations.hermes_plugin.service.shutil.rmtree"
            ) as rmtree,
            self.assertRaisesRegex(ServiceError, "s6 unavailable"),
        ):
            _remove_service_dir(service_dir)

        rmtree.assert_not_called()

    def test_remove_deletes_incomplete_slot_after_rescan(self) -> None:
        service_dir = Path(self.temporary.name) / "service" / "t3code"
        service_dir.mkdir(parents=True)
        completed = CompletedProcess(args=[], returncode=0, stdout="", stderr="")

        def run_command(args, **_kwargs):
            if args[0] == "s6-svscanctl":
                self.assertFalse(service_dir.exists())
                self.assertEqual(
                    len(list(service_dir.parent.glob(".t3code.removing.*"))),
                    1,
                )
            return CompletedProcess(
                args=args,
                returncode=1 if args[0] == "s6-svok" else 0,
                stdout="",
                stderr="",
            )

        with patch(
            "integrations.hermes_plugin.service._command",
            side_effect=run_command,
        ) as command:
            _remove_service_dir(service_dir)

        self.assertFalse(service_dir.exists())
        command.assert_any_call(
            ["s6-svscanctl", "-an", str(service_dir.parent)],
            timeout=5,
        )

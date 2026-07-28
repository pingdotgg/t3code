from __future__ import annotations

import hashlib
import io
import json
import shutil
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr
from dataclasses import replace
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import Mock, patch

from integrations.hermes_plugin.config import load_config
from integrations.hermes_plugin import coherent_update, update_process


class CoherentUpdateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        base = load_config(plugin_root=root / "plugin")
        self.config = replace(
            base,
            hermes_home=root / "hermes",
            runtime_root=root / "hermes" / "t3code",
            binary_path=root / "hermes" / "t3code" / "bin" / "t3",
            data_dir=root / "hermes" / "t3code" / "data",
            service_dir=root / "service" / "t3code",
            watchdog_service_dir=root / "service" / "t3code-plugin-watchdog",
        )

    def test_dashboard_update_uses_a_fresh_process_handoff(self) -> None:
        completed = CompletedProcess(
            args=[],
            returncode=0,
            stdout=json.dumps(
                {
                    "ok": True,
                    "action": "updated",
                    "version": "0.0.30",
                    "source_commit": "a" * 40,
                }
            ),
            stderr="",
        )

        with (
            patch(
                "integrations.hermes_plugin.coherent_update._command",
                return_value=completed,
            ) as command,
            patch(
                "integrations.hermes_plugin.service.update"
            ) as runtime_only_update,
        ):
            result = coherent_update.update(self.config)

        argv = command.call_args.args[0]
        self.assertEqual(argv[0], coherent_update.sys.executable)
        self.assertEqual(argv[1], "-I")
        self.assertEqual(Path(argv[2]).name, "update_process.py")
        self.assertEqual(argv[-1], "update")
        self.assertEqual(result["version"], "0.0.30")
        self.assertTrue(self.config.runtime_root.is_dir())
        runtime_only_update.assert_not_called()

    def test_source_cutover_checks_out_the_exact_release_commit(self) -> None:
        target = coherent_update.ProductTarget(
            version="0.0.30",
            tag="v0.0.30",
            source_commit="b" * 40,
            staged_binary=self.config.runtime_root / "transaction" / "t3",
            binary_sha256="c" * 64,
        )
        with (
            patch(
                "integrations.hermes_plugin.coherent_update._git_output",
                return_value="",
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._command",
                return_value=CompletedProcess([], 0, "", ""),
            ) as command,
            patch(
                "integrations.hermes_plugin.coherent_update._clear_plugin_bytecode"
            ),
        ):
            coherent_update._advance_source(self.config, target)

        self.assertEqual(
            command.call_args.args[0],
            [
                "git",
                "checkout",
                "--detach",
                target.source_commit,
            ],
        )

    def test_source_cutover_refuses_work_created_after_preflight(self) -> None:
        target = coherent_update.ProductTarget(
            version="0.0.30",
            tag="v0.0.30",
            source_commit="b" * 40,
            staged_binary=self.config.runtime_root / "transaction" / "t3",
            binary_sha256="c" * 64,
        )
        with (
            patch(
                "integrations.hermes_plugin.coherent_update._git_output",
                return_value=" M dashboard/plugin_api.py\n",
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._command"
            ) as command,
            self.assertRaisesRegex(
                coherent_update.UpdateError,
                "changed while Update was staging",
            ),
        ):
            coherent_update._advance_source(self.config, target)

        command.assert_not_called()

    def test_fresh_entrypoint_preserves_plugin_root_and_operation(self) -> None:
        plugin_root = str(self.config.plugin_root)
        with (
            patch.object(
                update_process.sys,
                "argv",
                ["update_process.py", plugin_root, "update"],
            ),
            patch.object(
                coherent_update,
                "main",
                return_value=0,
            ) as update_main,
        ):
            exit_code = update_process.main()

        self.assertEqual(exit_code, 0)
        update_main.assert_called_once_with([plugin_root, "update"])

    def test_fresh_entrypoint_imports_code_from_the_supplied_target(self) -> None:
        target_root = Path(self.temporary.name) / "target-plugin"
        package = target_root / "integrations" / "hermes_plugin"
        package.mkdir(parents=True)
        marker = target_root / "loaded-target"
        package.joinpath("coherent_update.py").write_text(
            "from pathlib import Path\n"
            "def main(argv):\n"
            f"    Path({str(marker)!r}).write_text(argv[1], encoding='utf-8')\n"
            "    return 0\n",
            encoding="utf-8",
        )
        worker = Path(coherent_update.__file__).with_name("update_process.py")

        result = coherent_update._command(
            [
                coherent_update.sys.executable,
                "-I",
                str(worker),
                str(target_root),
                "update",
            ],
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(marker.read_text(encoding="utf-8"), "update")

    def test_dirty_checkout_fails_before_target_resolution_or_mutation(self) -> None:
        host = Mock()
        host.preflight.return_value = None
        (self.config.plugin_root / ".git").mkdir(parents=True)

        def git(_config, args, **_kwargs):
            if args == ["status", "--porcelain", "--untracked-files=all"]:
                return " M dashboard/plugin_api.py\n"
            raise AssertionError(f"unexpected git call: {args}")

        with (
            patch(
                "integrations.hermes_plugin.coherent_update._load_host_contract",
                return_value=host,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._git_output",
                side_effect=git,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target"
            ) as resolve_target,
            patch(
                "integrations.hermes_plugin.coherent_update._advance_source"
            ) as advance_source,
            self.assertRaisesRegex(
                coherent_update.UpdateError,
                "uncommitted changes",
            ),
        ):
            coherent_update._perform_locked(self.config, "update")

        resolve_target.assert_not_called()
        advance_source.assert_not_called()

    def test_install_validates_any_prior_installed_runtime(self) -> None:
        host = Mock()
        (self.config.plugin_root / ".git").mkdir(parents=True)
        prior_state = {
            "version": 1,
            "desired_state": "installed",
            "binary_sha256": hashlib.sha256(b"old runtime").hexdigest(),
        }

        def git(_config, args, **_kwargs):
            if args == ["status", "--porcelain", "--untracked-files=all"]:
                return ""
            if args == ["rev-parse", "HEAD"]:
                return "b" * 40
            raise AssertionError(f"unexpected git call: {args}")

        with (
            patch(
                "integrations.hermes_plugin.coherent_update._git_output",
                side_effect=git,
            ),
            patch(
                "integrations.hermes_plugin.service._read_service_state",
                return_value=prior_state,
            ),
            patch(
                "integrations.hermes_plugin.service._validate_recovery_binary",
            ) as validate_binary,
        ):
            commit = coherent_update._preflight_checkout(
                self.config,
                host,
                "install",
            )

        self.assertEqual(commit, "b" * 40)
        validate_binary.assert_called_once_with(self.config, prior_state)

    def test_snapshot_rejects_a_changed_prior_installed_runtime(self) -> None:
        self.config.plugin_root.mkdir(parents=True)
        self.config.binary_path.parent.mkdir(parents=True)
        self.config.binary_path.write_bytes(b"changed runtime")
        self.config.service_state_path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "desired_state": "installed",
                    "binary_sha256": hashlib.sha256(
                        b"different verified runtime"
                    ).hexdigest(),
                }
            ),
            encoding="utf-8",
        )
        with (
            patch(
                "integrations.hermes_plugin.coherent_update._command",
                return_value=CompletedProcess([], 1, "", ""),
            ),
            self.assertRaisesRegex(
                coherent_update.UpdateError,
                "changed before it could be snapshotted",
            ),
        ):
            coherent_update._snapshot_product(
                self.config,
                "a" * 40,
            )

    def test_missing_hermes_handoff_fails_before_any_component_mutation(
        self,
    ) -> None:
        with (
            patch(
                "integrations.hermes_plugin.coherent_update._load_host_contract",
                side_effect=coherent_update.UpdateError(
                    "Hermes does not provide managed plugin update handoff v1"
                ),
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._preflight_checkout"
            ) as preflight,
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target"
            ) as resolve_target,
            patch(
                "integrations.hermes_plugin.coherent_update._advance_source"
            ) as advance_source,
            self.assertRaisesRegex(
                coherent_update.UpdateError,
                "managed plugin update handoff v1",
            ),
        ):
            coherent_update._perform_locked(self.config, "update")

        preflight.assert_not_called()
        resolve_target.assert_not_called()
        advance_source.assert_not_called()

    def test_missing_handoff_install_adopts_exact_current_release(self) -> None:
        source_commit = "a" * 40
        runtime = b"retained v43 runtime"
        binary_sha256 = hashlib.sha256(runtime).hexdigest()
        self.config.binary_path.parent.mkdir(parents=True)
        self.config.binary_path.write_bytes(runtime)
        (self.config.plugin_root / ".git").mkdir(parents=True)
        self.config.service_state_path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "desired_state": "installed",
                    "binary_sha256": hashlib.sha256(b"stale v42 runtime").hexdigest(),
                    "binary_version": "0.0.28-f8y.20260727.42",
                    "product_version": "0.0.28-f8y.20260727.42",
                    "product_source_commit": "b" * 40,
                }
            )
            + "\n",
            encoding="utf-8",
        )
        target = coherent_update.ProductTarget(
            version="0.0.28-f8y.20260728.43",
            tag="v0.0.28-f8y.20260728.43",
            source_commit=source_commit,
            staged_binary=self.config.runtime_root / "transaction" / "t3",
            binary_sha256=binary_sha256,
        )
        activation = {
            "ok": True,
            "service_pid": 9621,
            "http_healthy": True,
        }

        def git(_config, args, **_kwargs):
            if args == ["status", "--porcelain", "--untracked-files=all"]:
                return ""
            if args == ["rev-parse", "HEAD"]:
                return source_commit
            raise AssertionError(f"unexpected git call: {args}")

        with (
            patch(
                "integrations.hermes_plugin.coherent_update._load_host_contract",
                side_effect=coherent_update.UpdateError(
                    "Hermes does not provide managed plugin update handoff v1"
                ),
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._git_output",
                side_effect=git,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target",
                return_value=target,
            ),
            patch(
                "integrations.hermes_plugin.service.binary_version",
                return_value=target.version,
            ),
            patch(
                "integrations.hermes_plugin.service._validate_recovery_binary"
            ) as validate_stale_state,
            patch(
                "integrations.hermes_plugin.service."
                "_activate_staged_product_locked",
                return_value=activation,
            ) as activate,
            patch(
                "integrations.hermes_plugin.coherent_update._snapshot_product"
            ) as snapshot,
            patch(
                "integrations.hermes_plugin.coherent_update._advance_source"
            ) as advance_source,
            patch(
                "integrations.hermes_plugin.coherent_update._run_fresh_activation"
            ) as fresh_activation,
        ):
            result = coherent_update._perform_locked(self.config, "install")

        self.assertEqual(
            result,
            {
                "ok": True,
                "action": "installed",
                "version": target.version,
                "source_commit": source_commit,
                "service_pid": 9621,
            },
        )
        activate.assert_called_once_with(
            self.config,
            staged_binary=self.config.binary_path,
            product_version=target.version,
            source_commit=source_commit,
            binary_sha256=binary_sha256,
        )
        validate_stale_state.assert_not_called()
        snapshot.assert_not_called()
        advance_source.assert_not_called()
        fresh_activation.assert_not_called()

    def test_missing_handoff_install_refuses_dirty_checkout(self) -> None:
        (self.config.plugin_root / ".git").mkdir(parents=True)
        with (
            patch(
                "integrations.hermes_plugin.coherent_update._load_host_contract",
                side_effect=coherent_update.UpdateError("missing handoff"),
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._git_output",
                return_value=" M dashboard/plugin_api.py\n",
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target"
            ) as resolve_target,
            patch(
                "integrations.hermes_plugin.service."
                "_activate_staged_product_locked"
            ) as activate,
            self.assertRaisesRegex(
                coherent_update.UpdateError,
                "uncommitted changes",
            ),
        ):
            coherent_update._perform_locked(self.config, "install")

        resolve_target.assert_not_called()
        activate.assert_not_called()

    def test_missing_handoff_install_rolls_back_partial_activation(self) -> None:
        source_commit = "a" * 40
        runtime = b"retained runtime"
        binary_sha256 = hashlib.sha256(runtime).hexdigest()
        self.config.binary_path.parent.mkdir(parents=True)
        self.config.binary_path.write_bytes(runtime)
        (self.config.plugin_root / ".git").mkdir(parents=True)
        stale_state = (
            json.dumps(
                {
                    "version": 1,
                    "desired_state": "installed",
                    "binary_sha256": hashlib.sha256(b"stale runtime").hexdigest(),
                }
            )
            + "\n"
        ).encode()
        self.config.service_state_path.write_bytes(stale_state)
        target = coherent_update.ProductTarget(
            version="0.0.28-f8y.20260728.43",
            tag="v0.0.28-f8y.20260728.43",
            source_commit=source_commit,
            staged_binary=self.config.runtime_root / "transaction" / "t3",
            binary_sha256=binary_sha256,
        )

        def git(_config, args, **_kwargs):
            if args == ["status", "--porcelain", "--untracked-files=all"]:
                return ""
            if args == ["rev-parse", "HEAD"]:
                return source_commit
            raise AssertionError(f"unexpected git call: {args}")

        def fail_after_service_mutation(*_args, **_kwargs):
            for service_dir in (
                self.config.service_dir,
                self.config.watchdog_service_dir,
            ):
                service_dir.mkdir(parents=True)
                (service_dir / "run").touch()
            self.config.service_state_path.write_text(
                '{"version":1,"desired_state":"installed",'
                '"product_version":"incorrect-success"}\n',
                encoding="utf-8",
            )
            raise coherent_update.UpdateError("HTTP health failed")

        def remove_service_dir(path):
            shutil.rmtree(path, ignore_errors=True)

        with (
            patch(
                "integrations.hermes_plugin.coherent_update._load_host_contract",
                side_effect=coherent_update.UpdateError("missing handoff"),
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._git_output",
                side_effect=git,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target",
                return_value=target,
            ),
            patch(
                "integrations.hermes_plugin.service.binary_version",
                return_value=target.version,
            ),
            patch(
                "integrations.hermes_plugin.service."
                "_activate_staged_product_locked",
                side_effect=fail_after_service_mutation,
            ),
            patch(
                "integrations.hermes_plugin.service._remove_service_dir",
                side_effect=remove_service_dir,
            ),
            self.assertRaisesRegex(
                coherent_update.UpdateError,
                "HTTP health failed; adoption rollback succeeded",
            ),
        ):
            coherent_update._perform_locked(self.config, "install")

        self.assertFalse(self.config.service_dir.exists())
        self.assertFalse(self.config.watchdog_service_dir.exists())
        self.assertEqual(
            json.loads(self.config.service_state_path.read_bytes()),
            json.loads(stale_state),
        )

    def test_missing_handoff_install_reports_adoption_rollback_failure(
        self,
    ) -> None:
        source_commit = "a" * 40
        runtime = b"retained runtime"
        binary_sha256 = hashlib.sha256(runtime).hexdigest()
        self.config.binary_path.parent.mkdir(parents=True)
        self.config.binary_path.write_bytes(runtime)
        (self.config.plugin_root / ".git").mkdir(parents=True)
        target = coherent_update.ProductTarget(
            version="0.0.28-f8y.20260728.43",
            tag="v0.0.28-f8y.20260728.43",
            source_commit=source_commit,
            staged_binary=self.config.runtime_root / "transaction" / "t3",
            binary_sha256=binary_sha256,
        )

        def git(_config, args, **_kwargs):
            if args == ["status", "--porcelain", "--untracked-files=all"]:
                return ""
            if args == ["rev-parse", "HEAD"]:
                return source_commit
            raise AssertionError(f"unexpected git call: {args}")

        with (
            patch(
                "integrations.hermes_plugin.coherent_update._load_host_contract",
                side_effect=coherent_update.UpdateError("missing handoff"),
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._git_output",
                side_effect=git,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target",
                return_value=target,
            ),
            patch(
                "integrations.hermes_plugin.service.binary_version",
                return_value=target.version,
            ),
            patch(
                "integrations.hermes_plugin.service."
                "_activate_staged_product_locked",
                side_effect=coherent_update.UpdateError("activation failed"),
            ),
            patch(
                "integrations.hermes_plugin.service."
                "_restore_runtime_after_product_rollback",
                side_effect=RuntimeError(
                    "rollback failed with token=SENSITIVE_VALUE"
                ),
            ),
            self.assertRaisesRegex(
                coherent_update.UpdateError,
                "adoption rollback failed",
            ) as raised,
        ):
            coherent_update._perform_locked(self.config, "install")

        self.assertNotIn("SENSITIVE_VALUE", str(raised.exception))
        self.assertIn("token=[REDACTED]", str(raised.exception))

    def test_missing_handoff_install_refuses_incomplete_update_recovery(
        self,
    ) -> None:
        snapshot = self.config.runtime_root / ".product-update-snapshot"
        snapshot.mkdir(parents=True)
        with (
            patch(
                "integrations.hermes_plugin.coherent_update._load_host_contract",
                side_effect=coherent_update.UpdateError("missing handoff"),
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target"
            ) as resolve_target,
            patch(
                "integrations.hermes_plugin.service."
                "_activate_staged_product_locked"
            ) as activate,
            self.assertRaisesRegex(
                coherent_update.UpdateError,
                "incomplete coherent Update recovery artifacts",
            ),
        ):
            coherent_update._perform_locked(self.config, "install")

        resolve_target.assert_not_called()
        activate.assert_not_called()

    def test_missing_handoff_install_refuses_an_older_coherent_pair(self) -> None:
        current_commit = "a" * 40
        current_runtime = b"older retained runtime"
        self.config.binary_path.parent.mkdir(parents=True)
        self.config.binary_path.write_bytes(current_runtime)
        (self.config.plugin_root / ".git").mkdir(parents=True)
        target = coherent_update.ProductTarget(
            version="0.0.28-f8y.20260728.43",
            tag="v0.0.28-f8y.20260728.43",
            source_commit="b" * 40,
            staged_binary=self.config.runtime_root / "transaction" / "t3",
            binary_sha256=hashlib.sha256(b"newest runtime").hexdigest(),
        )

        def git(_config, args, **_kwargs):
            if args == ["status", "--porcelain", "--untracked-files=all"]:
                return ""
            if args == ["rev-parse", "HEAD"]:
                return current_commit
            raise AssertionError(f"unexpected git call: {args}")

        with (
            patch(
                "integrations.hermes_plugin.coherent_update._load_host_contract",
                side_effect=coherent_update.UpdateError("missing handoff"),
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._git_output",
                side_effect=git,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target",
                return_value=target,
            ),
            patch(
                "integrations.hermes_plugin.service."
                "_activate_staged_product_locked"
            ) as activate,
            self.assertRaisesRegex(
                coherent_update.UpdateError,
                "newest compatible coherent release",
            ),
        ):
            coherent_update._perform_locked(self.config, "install")

        activate.assert_not_called()

    def test_missing_handoff_install_refuses_runtime_identity_mismatches(
        self,
    ) -> None:
        source_commit = "a" * 40
        current_runtime = b"retained runtime"
        current_sha256 = hashlib.sha256(current_runtime).hexdigest()
        self.config.binary_path.parent.mkdir(parents=True)
        self.config.binary_path.write_bytes(current_runtime)
        (self.config.plugin_root / ".git").mkdir(parents=True)

        def git(_config, args, **_kwargs):
            if args == ["status", "--porcelain", "--untracked-files=all"]:
                return ""
            if args == ["rev-parse", "HEAD"]:
                return source_commit
            raise AssertionError(f"unexpected git call: {args}")

        cases = (
            (
                "version",
                "0.0.28-f8y.20260728.42",
                current_sha256,
                "runtime version",
            ),
            (
                "checksum",
                "0.0.28-f8y.20260728.43",
                hashlib.sha256(b"different release runtime").hexdigest(),
                "runtime checksum",
            ),
        )
        for name, reported_version, expected_sha256, error_pattern in cases:
            with self.subTest(name=name):
                target = coherent_update.ProductTarget(
                    version="0.0.28-f8y.20260728.43",
                    tag="v0.0.28-f8y.20260728.43",
                    source_commit=source_commit,
                    staged_binary=self.config.runtime_root / name / "t3",
                    binary_sha256=expected_sha256,
                )
                with (
                    patch(
                        "integrations.hermes_plugin.coherent_update."
                        "_load_host_contract",
                        side_effect=coherent_update.UpdateError("missing handoff"),
                    ),
                    patch(
                        "integrations.hermes_plugin.coherent_update._git_output",
                        side_effect=git,
                    ),
                    patch(
                        "integrations.hermes_plugin.coherent_update._resolve_target",
                        return_value=target,
                    ),
                    patch(
                        "integrations.hermes_plugin.service.binary_version",
                        return_value=reported_version,
                    ),
                    patch(
                        "integrations.hermes_plugin.service."
                        "_activate_staged_product_locked"
                    ) as activate,
                    self.assertRaisesRegex(
                        coherent_update.UpdateError,
                        error_pattern,
                    ),
                ):
                    coherent_update._perform_locked(self.config, "install")

                activate.assert_not_called()

    def test_missing_handoff_install_requires_a_retained_runtime(self) -> None:
        source_commit = "a" * 40
        target = coherent_update.ProductTarget(
            version="0.0.28-f8y.20260728.43",
            tag="v0.0.28-f8y.20260728.43",
            source_commit=source_commit,
            staged_binary=self.config.runtime_root / "transaction" / "t3",
            binary_sha256=hashlib.sha256(b"release runtime").hexdigest(),
        )
        (self.config.plugin_root / ".git").mkdir(parents=True)

        def git(_config, args, **_kwargs):
            if args == ["status", "--porcelain", "--untracked-files=all"]:
                return ""
            if args == ["rev-parse", "HEAD"]:
                return source_commit
            raise AssertionError(f"unexpected git call: {args}")

        with (
            patch(
                "integrations.hermes_plugin.coherent_update._load_host_contract",
                side_effect=coherent_update.UpdateError("missing handoff"),
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._git_output",
                side_effect=git,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target",
                return_value=target,
            ),
            patch(
                "integrations.hermes_plugin.service."
                "_activate_staged_product_locked"
            ) as activate,
            self.assertRaisesRegex(
                coherent_update.UpdateError,
                "cannot find a retained runtime",
            ),
        ):
            coherent_update._perform_locked(self.config, "install")

        activate.assert_not_called()

    def test_missing_handoff_install_refuses_source_movement(self) -> None:
        initial_commit = "a" * 40
        target = coherent_update.ProductTarget(
            version="0.0.28-f8y.20260728.43",
            tag="v0.0.28-f8y.20260728.43",
            source_commit=initial_commit,
            staged_binary=self.config.runtime_root / "transaction" / "t3",
            binary_sha256=hashlib.sha256(b"retained runtime").hexdigest(),
        )
        self.config.binary_path.parent.mkdir(parents=True)
        self.config.binary_path.write_bytes(b"retained runtime")
        (self.config.plugin_root / ".git").mkdir(parents=True)
        commits = iter((initial_commit, "b" * 40))

        def git(_config, args, **_kwargs):
            if args == ["status", "--porcelain", "--untracked-files=all"]:
                return ""
            if args == ["rev-parse", "HEAD"]:
                return next(commits)
            raise AssertionError(f"unexpected git call: {args}")

        with (
            patch(
                "integrations.hermes_plugin.coherent_update._load_host_contract",
                side_effect=coherent_update.UpdateError("missing handoff"),
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._git_output",
                side_effect=git,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target",
                return_value=target,
            ),
            patch(
                "integrations.hermes_plugin.service."
                "_activate_staged_product_locked"
            ) as activate,
            self.assertRaisesRegex(
                coherent_update.UpdateError,
                "changed while Install was verifying",
            ),
        ):
            coherent_update._perform_locked(self.config, "install")

        activate.assert_not_called()

    def test_missing_handoff_install_refuses_checkout_dirtied_while_verifying(
        self,
    ) -> None:
        source_commit = "a" * 40
        target = coherent_update.ProductTarget(
            version="0.0.28-f8y.20260728.43",
            tag="v0.0.28-f8y.20260728.43",
            source_commit=source_commit,
            staged_binary=self.config.runtime_root / "transaction" / "t3",
            binary_sha256=hashlib.sha256(b"retained runtime").hexdigest(),
        )
        self.config.binary_path.parent.mkdir(parents=True)
        self.config.binary_path.write_bytes(b"retained runtime")
        (self.config.plugin_root / ".git").mkdir(parents=True)
        statuses = iter(("", " M dashboard/plugin_api.py\n"))

        def git(_config, args, **_kwargs):
            if args == ["status", "--porcelain", "--untracked-files=all"]:
                return next(statuses)
            if args == ["rev-parse", "HEAD"]:
                return source_commit
            raise AssertionError(f"unexpected git call: {args}")

        with (
            patch(
                "integrations.hermes_plugin.coherent_update._load_host_contract",
                side_effect=coherent_update.UpdateError("missing handoff"),
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._git_output",
                side_effect=git,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target",
                return_value=target,
            ),
            patch(
                "integrations.hermes_plugin.service."
                "_activate_staged_product_locked"
            ) as activate,
            self.assertRaisesRegex(
                coherent_update.UpdateError,
                "changed while Install was verifying",
            ),
        ):
            coherent_update._perform_locked(self.config, "install")

        activate.assert_not_called()

    def test_worker_errors_redact_credentials_and_secret_urls(self) -> None:
        error_output = io.StringIO()
        with (
            patch(
                "integrations.hermes_plugin.coherent_update.load_config",
                side_effect=coherent_update.UpdateError(
                    "fetch https://account:SENSITIVE_URL_VALUE@example.test/repo.git"
                    "?access_token=SENSITIVE_QUERY_VALUE failed with "
                    "Bearer SENSITIVE_BEARER_VALUE"
                ),
            ),
            redirect_stderr(error_output),
        ):
            exit_code = coherent_update.main(
                [str(self.config.plugin_root), "update"]
            )

        rendered = error_output.getvalue()
        self.assertEqual(exit_code, 1)
        self.assertNotIn("SENSITIVE_URL_VALUE", rendered)
        self.assertNotIn("SENSITIVE_QUERY_VALUE", rendered)
        self.assertNotIn("SENSITIVE_BEARER_VALUE", rendered)
        self.assertIn("[REDACTED]", rendered)

    def test_source_advance_runtime_failure_rolls_back_complete_unit(self) -> None:
        target = coherent_update.ProductTarget(
            version="0.0.30",
            tag="v0.0.30",
            source_commit="b" * 40,
            staged_binary=self.config.runtime_root / "transaction" / "t3",
            binary_sha256="c" * 64,
        )
        snapshot = coherent_update.ProductSnapshot(
            source_commit="a" * 40,
            binary_backup=self.config.runtime_root / "transaction" / "old-t3",
            state_backup=b'{"desired_state":"installed"}\n',
        )
        host = Mock()
        host.preflight.return_value = None
        host.rollback.return_value = {
            "reloaded": True,
            "loaded_source_commit": snapshot.source_commit,
            "loaded_product_version": None,
        }

        with (
            patch(
                "integrations.hermes_plugin.coherent_update._load_host_contract",
                return_value=host,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._preflight_checkout",
                return_value=snapshot.source_commit,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target",
                return_value=target,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._snapshot_product",
                return_value=snapshot,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._advance_source"
            ) as advance_source,
            patch(
                "integrations.hermes_plugin.coherent_update._run_fresh_activation",
                side_effect=coherent_update.UpdateError(
                    "runtime replacement failed"
                ),
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._rollback_product",
                return_value={"ok": True},
            ) as rollback,
            self.assertRaisesRegex(
                coherent_update.UpdateError,
                "rollback succeeded",
            ),
        ):
            coherent_update._perform_locked(self.config, "update")

        advance_source.assert_called_once_with(self.config, target)
        rollback.assert_called_once_with(self.config, snapshot)
        host.rollback.assert_called_once()

    def test_runtime_success_service_failure_is_not_partial_success(self) -> None:
        target = coherent_update.ProductTarget(
            version="0.0.30",
            tag="v0.0.30",
            source_commit="b" * 40,
            staged_binary=self.config.runtime_root / "transaction" / "t3",
            binary_sha256="c" * 64,
        )
        snapshot = coherent_update.ProductSnapshot(
            source_commit="a" * 40,
            binary_backup=self.config.runtime_root / "transaction" / "old-t3",
            state_backup=b'{"desired_state":"installed"}\n',
        )
        host = Mock()
        host.rollback.return_value = {
            "reloaded": True,
            "loaded_source_commit": snapshot.source_commit,
            "loaded_product_version": None,
        }

        with (
            patch(
                "integrations.hermes_plugin.coherent_update._load_host_contract",
                return_value=host,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._preflight_checkout",
                return_value=snapshot.source_commit,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target",
                return_value=target,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._snapshot_product",
                return_value=snapshot,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._advance_source"
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._run_fresh_activation",
                side_effect=coherent_update.UpdateError(
                    "service health verification failed"
                ),
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._rollback_product",
                return_value={"ok": True},
            ) as rollback,
            self.assertRaisesRegex(
                coherent_update.UpdateError,
                "service health verification failed.*rollback succeeded",
            ),
        ):
            coherent_update._perform_locked(self.config, "update")

        rollback.assert_called_once_with(self.config, snapshot)

    def test_failed_rollback_retains_recovery_artifacts(self) -> None:
        snapshot_root = self.config.runtime_root / ".product-update-snapshot"
        snapshot_root.mkdir(parents=True)
        transaction_path = coherent_update._transaction_path(self.config)
        transaction_path.write_text("{}\n", encoding="utf-8")
        target_root = self.config.runtime_root / ".product-update-target"
        target_root.mkdir()
        target = coherent_update.ProductTarget(
            version="0.0.30",
            tag="v0.0.30",
            source_commit="b" * 40,
            staged_binary=target_root / "t3",
            binary_sha256="c" * 64,
        )
        snapshot = coherent_update.ProductSnapshot(
            source_commit="a" * 40,
            binary_backup=snapshot_root / "t3",
            state_backup=b'{"desired_state":"installed"}\n',
        )

        with (
            patch(
                "integrations.hermes_plugin.coherent_update._load_host_contract",
                return_value=Mock(),
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._preflight_checkout",
                return_value=snapshot.source_commit,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target",
                return_value=target,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._snapshot_product",
                return_value=snapshot,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._advance_source"
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._run_fresh_activation",
                side_effect=coherent_update.UpdateError("activation failed"),
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._rollback_product",
                return_value={"ok": False, "failures": ["service still down"]},
            ),
            self.assertRaisesRegex(
                coherent_update.UpdateError,
                "rollback failed",
            ),
        ):
            coherent_update._perform_locked(self.config, "update")

        self.assertTrue(snapshot_root.is_dir())
        self.assertTrue(target_root.is_dir())
        self.assertTrue(transaction_path.is_file())

    def test_raised_host_rollback_retains_recovery_artifacts(self) -> None:
        snapshot_root = self.config.runtime_root / ".product-update-snapshot"
        snapshot_root.mkdir(parents=True)
        transaction_path = coherent_update._transaction_path(self.config)
        transaction_path.write_text("{}\n", encoding="utf-8")
        target_root = self.config.runtime_root / ".product-update-target"
        target_root.mkdir()
        target = coherent_update.ProductTarget(
            version="0.0.30",
            tag="v0.0.30",
            source_commit="b" * 40,
            staged_binary=target_root / "t3",
            binary_sha256="c" * 64,
        )
        snapshot = coherent_update.ProductSnapshot(
            source_commit="a" * 40,
            binary_backup=snapshot_root / "t3",
            state_backup=None,
        )
        host = Mock()
        host.rollback.side_effect = RuntimeError(
            "host rollback failed with token=SHOULD_NOT_APPEAR"
        )
        with (
            patch(
                "integrations.hermes_plugin.coherent_update._load_host_contract",
                return_value=host,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._preflight_checkout",
                return_value=snapshot.source_commit,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target",
                return_value=target,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._snapshot_product",
                return_value=snapshot,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._advance_source"
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._run_fresh_activation",
                side_effect=coherent_update.UpdateError("activation failed"),
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._rollback_product",
                return_value={"ok": True, "failures": []},
            ),
            self.assertRaisesRegex(
                coherent_update.UpdateError,
                "rollback failed",
            ) as raised,
        ):
            coherent_update._perform_locked(self.config, "update")

        self.assertNotIn("SHOULD_NOT_APPEAR", str(raised.exception))
        self.assertIn("token=[REDACTED]", str(raised.exception))
        self.assertTrue(snapshot_root.is_dir())
        self.assertTrue(target_root.is_dir())
        self.assertTrue(transaction_path.is_file())

    def test_rollback_preserves_explicit_uninstalled_intent(self) -> None:
        self.config.plugin_root.mkdir(parents=True)
        backup = self.config.runtime_root / ".product-update-snapshot" / "t3"
        backup.parent.mkdir(parents=True)
        backup.write_bytes(b"prior runtime")
        snapshot = coherent_update.ProductSnapshot(
            source_commit="a" * 40,
            binary_backup=backup,
            state_backup=b'{"desired_state":"uninstalled"}\n',
        )

        with (
            patch(
                "integrations.hermes_plugin.coherent_update._git_output",
                return_value="",
            ),
            patch("integrations.hermes_plugin.coherent_update._command"),
            patch(
                "integrations.hermes_plugin.coherent_update._clear_plugin_bytecode"
            ),
            patch(
                "integrations.hermes_plugin.service."
                "_restore_runtime_after_product_rollback"
            ) as restore_runtime,
        ):
            result = coherent_update._rollback_product(self.config, snapshot)

        self.assertTrue(result["ok"])
        self.assertEqual(self.config.binary_path.read_bytes(), b"prior runtime")
        restore_runtime.assert_called_once_with(
            self.config,
            installed_intent=False,
        )

    def test_rollback_restores_source_runtime_state_and_installed_intent(
        self,
    ) -> None:
        root = Path(self.temporary.name)
        plugin_root = root / "rollback-plugin"
        plugin_root.mkdir()
        config = replace(
            self.config,
            plugin_root=plugin_root,
            runtime_root=root / "rollback-runtime",
            binary_path=root / "rollback-runtime" / "bin" / "t3",
        )
        for args in (
            ["git", "init", "-q"],
            ["git", "config", "user.name", "Test"],
            ["git", "config", "user.email", "test@example.invalid"],
        ):
            coherent_update._command(args, cwd=plugin_root)
        source = plugin_root / "plugin-source.py"
        source.write_text("old = True\n", encoding="utf-8")
        coherent_update._command(["git", "add", "."], cwd=plugin_root)
        coherent_update._command(
            ["git", "commit", "-q", "-m", "old"],
            cwd=plugin_root,
        )
        old_commit = coherent_update._git_output(
            config,
            ["rev-parse", "HEAD"],
        )
        old_ref = coherent_update._git_output(
            config,
            ["symbolic-ref", "--short", "HEAD"],
        )
        config.binary_path.parent.mkdir(parents=True)
        config.binary_path.write_bytes(b"old runtime")
        prior_state = {
            "version": 1,
            "desired_state": "installed",
            "binary_sha256": hashlib.sha256(b"old runtime").hexdigest(),
            "binary_version": "0.0.29",
            "product_version": "0.0.29",
            "product_source_commit": old_commit,
        }
        config.service_state_path.write_text(
            json.dumps(prior_state) + "\n",
            encoding="utf-8",
        )
        snapshot = coherent_update._snapshot_product(config, old_commit)

        source.write_text("new = True\n", encoding="utf-8")
        coherent_update._command(["git", "add", "."], cwd=plugin_root)
        coherent_update._command(
            ["git", "commit", "-q", "-m", "new"],
            cwd=plugin_root,
        )
        new_commit = coherent_update._git_output(
            config,
            ["rev-parse", "HEAD"],
        )
        coherent_update._command(
            ["git", "checkout", "--detach", new_commit],
            cwd=plugin_root,
        )
        coherent_update._command(
            ["git", "branch", "-f", old_ref, old_commit],
            cwd=plugin_root,
        )
        config.binary_path.write_bytes(b"new runtime")
        config.service_state_path.write_text(
            '{"version":1,"desired_state":"installed",'
            '"product_version":"0.0.30"}\n',
            encoding="utf-8",
        )

        with patch(
            "integrations.hermes_plugin.service."
            "_restore_runtime_after_product_rollback"
        ) as restore_runtime:
            result = coherent_update._rollback_product(config, snapshot)

        self.assertTrue(result["ok"], result["failures"])
        self.assertEqual(
            coherent_update._git_output(config, ["rev-parse", "HEAD"]),
            old_commit,
        )
        self.assertEqual(
            coherent_update._git_output(
                config,
                ["symbolic-ref", "--short", "HEAD"],
            ),
            old_ref,
        )
        self.assertEqual(source.read_text(encoding="utf-8"), "old = True\n")
        self.assertEqual(config.binary_path.read_bytes(), b"old runtime")
        self.assertEqual(
            json.loads(config.service_state_path.read_text(encoding="utf-8")),
            prior_state,
        )
        restore_runtime.assert_called_once_with(
            config,
            installed_intent=True,
        )

    def test_host_handoff_must_attest_the_loaded_target_identity(self) -> None:
        transaction_path = self.config.runtime_root / "transaction.json"
        transaction_path.parent.mkdir(parents=True)
        target = coherent_update.ProductTarget(
            version="0.0.30",
            tag="v0.0.30",
            source_commit="b" * 40,
            staged_binary=self.config.runtime_root / "staged-t3",
            binary_sha256="c" * 64,
        )
        transaction_path.write_text(
            json.dumps(
                {
                    "target": target.to_dict(),
                    "snapshot": coherent_update.ProductSnapshot(
                        source_commit="a" * 40,
                        binary_backup=None,
                        state_backup=None,
                    ).to_dict(),
                }
            ),
            encoding="utf-8",
        )
        host = Mock()
        host.complete.return_value = {
            "reloaded": True,
            "loaded_source_commit": "a" * 40,
            "loaded_product_version": target.version,
        }
        with (
            patch(
                "integrations.hermes_plugin.coherent_update._git_output",
                return_value=target.source_commit,
            ),
            patch(
                "integrations.hermes_plugin.service."
                "_activate_staged_product_locked",
                return_value={"service_pid": 9621, "http_healthy": True},
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._load_host_contract",
                return_value=host,
            ),
            self.assertRaisesRegex(
                coherent_update.UpdateError,
                "did not prove",
            ),
        ):
            coherent_update._activate_transaction(
                self.config,
                transaction_path,
            )

    def test_lifecycle_lock_serializes_update_processes(self) -> None:
        active = 0
        peak = 0
        state_lock = threading.Lock()

        def perform(_config, _operation):
            nonlocal active, peak
            with state_lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.05)
            with state_lock:
                active -= 1
            return {"ok": True}

        with patch(
            "integrations.hermes_plugin.coherent_update._perform_locked",
            side_effect=perform,
        ):
            threads = [
                threading.Thread(
                    target=coherent_update._run_in_process,
                    args=(self.config, "update"),
                )
                for _ in range(2)
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=2)

        self.assertEqual(peak, 1)

    def test_success_requires_source_runtime_service_and_host_activation(
        self,
    ) -> None:
        target = coherent_update.ProductTarget(
            version="0.0.30",
            tag="v0.0.30",
            source_commit="b" * 40,
            staged_binary=self.config.runtime_root / "transaction" / "t3",
            binary_sha256="c" * 64,
        )
        snapshot = coherent_update.ProductSnapshot(
            source_commit="a" * 40,
            binary_backup=self.config.runtime_root / "transaction" / "old-t3",
            state_backup=b'{"desired_state":"installed"}\n',
        )
        activation = {
            "ok": True,
            "service_pid": 9621,
            "http_healthy": True,
            "host_reloaded": True,
        }
        host = Mock()

        with (
            patch(
                "integrations.hermes_plugin.coherent_update._load_host_contract",
                return_value=host,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._preflight_checkout",
                return_value=snapshot.source_commit,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target",
                return_value=target,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._snapshot_product",
                return_value=snapshot,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._advance_source"
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._run_fresh_activation",
                return_value=activation,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._rollback_product"
            ) as rollback,
        ):
            result = coherent_update._perform_locked(self.config, "update")

        self.assertEqual(
            result,
            {
                "ok": True,
                "action": "updated",
                "version": target.version,
                "source_commit": target.source_commit,
                "service_pid": 9621,
            },
        )
        rollback.assert_not_called()

    def test_negative_service_pid_can_never_report_update_success(self) -> None:
        target = coherent_update.ProductTarget(
            version="0.0.30",
            tag="v0.0.30",
            source_commit="b" * 40,
            staged_binary=self.config.runtime_root / "transaction" / "t3",
            binary_sha256="c" * 64,
        )
        snapshot = coherent_update.ProductSnapshot(
            source_commit="a" * 40,
            binary_backup=None,
            state_backup=None,
        )
        host = Mock()
        host.rollback.return_value = {
            "reloaded": True,
            "loaded_source_commit": snapshot.source_commit,
            "loaded_product_version": None,
        }
        with (
            patch(
                "integrations.hermes_plugin.coherent_update._load_host_contract",
                return_value=host,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._preflight_checkout",
                return_value=snapshot.source_commit,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target",
                return_value=target,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._snapshot_product",
                return_value=snapshot,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._advance_source"
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._run_fresh_activation",
                return_value={
                    "ok": True,
                    "service_pid": -1,
                    "http_healthy": True,
                    "host_reloaded": True,
                },
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._rollback_product",
                return_value={"ok": True, "failures": []},
            ) as rollback,
            self.assertRaisesRegex(
                coherent_update.UpdateError,
                "activation did not prove",
            ),
        ):
            coherent_update._perform_locked(self.config, "update")

        rollback.assert_called_once_with(self.config, snapshot)


if __name__ == "__main__":
    unittest.main()

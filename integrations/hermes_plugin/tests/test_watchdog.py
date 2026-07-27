from __future__ import annotations

import json
import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch

from integrations.hermes_plugin.watchdog import cleanup_orphaned_services


class WatchdogTest(unittest.TestCase):
    def test_removes_both_service_directories_and_rescans(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            scan_dir = Path(temporary)
            t3_service = scan_dir / "t3code"
            watchdog_service = scan_dir / "t3code-plugin-watchdog"
            service_state = scan_dir / "persistent" / "service-state.json"
            lifecycle_lock = scan_dir / "persistent" / "service-lifecycle.lock"
            t3_service.mkdir()
            watchdog_service.mkdir()

            with (
                patch(
                    "integrations.hermes_plugin.watchdog._run",
                    side_effect=lambda args, **_kwargs: args[0] != "s6-svok",
                ) as run,
                patch("integrations.hermes_plugin.watchdog.time.sleep"),
            ):
                cleaned_up = cleanup_orphaned_services(
                    plugin_root=scan_dir / "plugin",
                    scan_dir=scan_dir,
                    t3_service_dir=t3_service,
                    watchdog_service_dir=watchdog_service,
                    service_state_path=service_state,
                    lifecycle_lock_path=lifecycle_lock,
                )
                watchdog_tombstones = list(
                    scan_dir.glob(".t3code-plugin-watchdog.removing.*")
                )
            desired_state = json.loads(
                service_state.read_text(encoding="utf-8")
            )["desired_state"]

        self.assertFalse(t3_service.exists())
        self.assertFalse(watchdog_service.exists())
        self.assertTrue(cleaned_up)
        self.assertEqual(len(watchdog_tombstones), 1)
        self.assertEqual(desired_state, "uninstalled")
        run.assert_any_call(["s6-svscanctl", "-an", str(scan_dir)], timeout=5)

    def test_keeps_services_until_uninstalled_intent_is_durable(self) -> None:
        scan_dir = Path("/run/service")
        with (
            patch(
                "integrations.hermes_plugin.watchdog.persist_uninstalled_state",
                return_value=False,
            ),
            patch(
                "integrations.hermes_plugin.watchdog.lifecycle_lock",
                return_value=nullcontext(),
            ),
            patch(
                "integrations.hermes_plugin.watchdog.remove_service"
            ) as remove_service,
            patch("integrations.hermes_plugin.watchdog.shutil.rmtree") as rmtree,
        ):
            cleaned_up = cleanup_orphaned_services(
                plugin_root=Path("/plugin"),
                scan_dir=scan_dir,
                t3_service_dir=scan_dir / "t3code",
                watchdog_service_dir=scan_dir / "t3code-plugin-watchdog",
                service_state_path=Path("/data/t3code/service-state.json"),
                lifecycle_lock_path=Path("/data/t3code/service-lifecycle.lock"),
            )

        self.assertFalse(cleaned_up)
        remove_service.assert_not_called()
        rmtree.assert_not_called()

    def test_rechecks_plugin_presence_inside_lifecycle_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plugin_root = root / "plugin"
            plugin_root.mkdir()
            (plugin_root / "plugin.yaml").touch()
            with (
                patch(
                    "integrations.hermes_plugin.watchdog.lifecycle_lock",
                    return_value=nullcontext(),
                ),
                patch(
                    "integrations.hermes_plugin.watchdog.persist_uninstalled_state"
                ) as persist,
            ):
                cleaned_up = cleanup_orphaned_services(
                    plugin_root=plugin_root,
                    scan_dir=root / "service",
                    t3_service_dir=root / "service" / "t3code",
                    watchdog_service_dir=root
                    / "service"
                    / "t3code-plugin-watchdog",
                    service_state_path=root / "runtime" / "service-state.json",
                    lifecycle_lock_path=root
                    / "runtime"
                    / "service-lifecycle.lock",
                )

        self.assertFalse(cleaned_up)
        persist.assert_not_called()

    def test_root_watchdog_preserves_state_directory_ownership(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_path = Path(temporary) / "service-state.json"
            owner = state_path.parent.stat()
            with (
                patch(
                    "integrations.hermes_plugin.watchdog.os.geteuid",
                    return_value=0,
                ),
                patch(
                    "integrations.hermes_plugin.watchdog.os.fchown"
                ) as fchown,
            ):
                from integrations.hermes_plugin.watchdog import (
                    persist_uninstalled_state,
                )

                persisted = persist_uninstalled_state(state_path)

        self.assertTrue(persisted)
        fchown.assert_called_once()
        self.assertEqual(fchown.call_args.args[1:], (owner.st_uid, owner.st_gid))

    def test_supervisor_failure_leaves_watchdog_managed_tree_intact(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            scan_dir = Path(temporary)
            service_dir = scan_dir / "t3code"
            service_dir.mkdir()
            (service_dir / "run").touch()
            with (
                patch(
                    "integrations.hermes_plugin.watchdog._run",
                    return_value=False,
                ),
                patch(
                    "integrations.hermes_plugin.watchdog.shutil.rmtree"
                ) as rmtree,
            ):
                from integrations.hermes_plugin.watchdog import remove_service

                removed = remove_service(service_dir, scan_dir=scan_dir)

        self.assertFalse(removed)
        rmtree.assert_not_called()

    def test_incomplete_watchdog_managed_tree_is_removed_after_rescan(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            scan_dir = Path(temporary)
            service_dir = scan_dir / "t3code"
            service_dir.mkdir()
            with patch(
                "integrations.hermes_plugin.watchdog._run",
                side_effect=lambda args, **_kwargs: args[0] != "s6-svok",
            ) as run:
                from integrations.hermes_plugin.watchdog import remove_service

                removed = remove_service(service_dir, scan_dir=scan_dir)

            self.assertTrue(removed)
            run.assert_any_call(
                ["s6-svscanctl", "-an", str(scan_dir)],
                timeout=5,
            )
            self.assertFalse(
                list(scan_dir.glob(".t3code.removing.*"))
            )

    def test_unreaped_supervisor_keeps_hidden_tree_and_blocks_success(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            scan_dir = Path(temporary)
            service_dir = scan_dir / "t3code"
            service_dir.mkdir()
            with (
                patch(
                    "integrations.hermes_plugin.watchdog._run",
                    return_value=True,
                ),
                patch(
                    "integrations.hermes_plugin.watchdog._SUPERVISOR_REAP_TIMEOUT_SECONDS",
                    0,
                ),
            ):
                from integrations.hermes_plugin.watchdog import remove_service

                removed = remove_service(service_dir, scan_dir=scan_dir)

            self.assertFalse(removed)
            self.assertFalse(service_dir.exists())
            self.assertEqual(
                len(list(scan_dir.glob(".t3code.removing.*"))),
                1,
            )

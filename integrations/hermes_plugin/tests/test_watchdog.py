from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from integrations.hermes_plugin.watchdog import cleanup_orphaned_services


class WatchdogTest(unittest.TestCase):
    def test_removes_both_service_directories_and_rescans(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            scan_dir = Path(temporary)
            t3_service = scan_dir / "t3code"
            watchdog_service = scan_dir / "t3code-plugin-watchdog"
            t3_service.mkdir()
            watchdog_service.mkdir()

            with (
                patch("integrations.hermes_plugin.watchdog._run") as run,
                patch("integrations.hermes_plugin.watchdog.time.sleep"),
            ):
                cleanup_orphaned_services(
                    scan_dir=scan_dir,
                    t3_service_dir=t3_service,
                    watchdog_service_dir=watchdog_service,
                )

        self.assertFalse(t3_service.exists())
        self.assertFalse(watchdog_service.exists())
        run.assert_any_call(["s6-svscanctl", "-an", str(scan_dir)], timeout=5)

"""Delayed cleanup for s6 services orphaned by Hermes plugin removal."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import time
from pathlib import Path


def _run(command: list[str], *, timeout: float = 15) -> None:
    try:
        subprocess.run(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def remove_service(service_dir: Path, *, scan_dir: Path) -> None:
    if not service_dir.exists():
        return
    _run(["s6-svc", "-d", str(service_dir)], timeout=5)
    _run(["s6-svwait", "-D", "-t", "10000", str(service_dir)])
    _run(["s6-svscanctl", "-an", str(scan_dir)], timeout=5)
    time.sleep(0.2)
    shutil.rmtree(service_dir, ignore_errors=True)


def cleanup_orphaned_services(
    *,
    scan_dir: Path,
    t3_service_dir: Path,
    watchdog_service_dir: Path,
) -> None:
    remove_service(t3_service_dir, scan_dir=scan_dir)
    # Removing our own directory is safe: the running interpreter has already
    # loaded this module, and s6-svscan is notified immediately afterwards.
    shutil.rmtree(watchdog_service_dir, ignore_errors=True)
    _run(["s6-svscanctl", "-an", str(scan_dir)], timeout=5)


def monitor(
    *,
    plugin_root: Path,
    scan_dir: Path,
    t3_service_dir: Path,
    watchdog_service_dir: Path,
    interval_seconds: int,
    misses_required: int,
) -> None:
    misses = 0
    marker = plugin_root / "plugin.yaml"
    while True:
        time.sleep(interval_seconds)
        if marker.is_file():
            misses = 0
            continue
        misses += 1
        if misses < misses_required:
            continue
        cleanup_orphaned_services(
            scan_dir=scan_dir,
            t3_service_dir=t3_service_dir,
            watchdog_service_dir=watchdog_service_dir,
        )
        return


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plugin-root", type=Path, required=True)
    parser.add_argument("--scan-dir", type=Path, required=True)
    parser.add_argument("--t3-service-dir", type=Path, required=True)
    parser.add_argument("--watchdog-service-dir", type=Path, required=True)
    parser.add_argument("--interval-seconds", type=int, required=True)
    parser.add_argument("--misses-required", type=int, required=True)
    args = parser.parse_args(argv)
    if args.interval_seconds < 1 or args.misses_required < 1:
        parser.error("interval and misses must be positive")
    monitor(
        plugin_root=args.plugin_root,
        scan_dir=args.scan_dir,
        t3_service_dir=args.t3_service_dir,
        watchdog_service_dir=args.watchdog_service_dir,
        interval_seconds=args.interval_seconds,
        misses_required=args.misses_required,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

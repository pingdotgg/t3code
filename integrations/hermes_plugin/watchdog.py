"""Delayed cleanup for s6 services orphaned by Hermes plugin removal."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

_SUPERVISOR_REAP_TIMEOUT_SECONDS = 10.0
_SUPERVISOR_REAP_POLL_SECONDS = 0.1


@contextmanager
def lifecycle_lock(lock_path: Path):
    descriptor: int | None = None
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(
            lock_path,
            os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW,
            0o600,
        )
        if os.geteuid() == 0:
            owner = lock_path.parent.stat()
            os.fchown(descriptor, owner.st_uid, owner.st_gid)
        fcntl.flock(descriptor, fcntl.LOCK_EX)
    except OSError:
        if descriptor is not None:
            os.close(descriptor)
        raise
    try:
        yield
    finally:
        os.close(descriptor)


def persist_uninstalled_state(service_state_path: Path) -> bool:
    """Record plugin-removal intent before deleting the orphaned slots."""

    state = {
        "version": 1,
        "desired_state": "uninstalled",
        "updated_at": int(time.time()),
    }
    temporary: Path | None = None
    try:
        service_state_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=service_state_path.parent,
            prefix=f".{service_state_path.name}.",
            suffix=".tmp",
            delete=False,
        ) as output:
            temporary = Path(output.name)
            output.write(json.dumps(state, indent=2, sort_keys=True) + "\n")
            output.flush()
            os.fsync(output.fileno())
            if os.geteuid() == 0:
                owner = service_state_path.parent.stat()
                os.fchown(output.fileno(), owner.st_uid, owner.st_gid)
                os.fsync(output.fileno())
        os.replace(temporary, service_state_path)
        directory = os.open(service_state_path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        return True
    except OSError as error:
        try:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        except OSError:
            pass
        print(
            f"T3 watchdog could not persist uninstalled state at "
            f"{service_state_path}: {error}; cleanup will retry",
            file=sys.stderr,
        )
        return False


def _run(command: list[str], *, timeout: float = 15) -> bool:
    try:
        result = subprocess.run(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def _removal_tombstones(service_dir: Path) -> list[Path]:
    return list(service_dir.parent.glob(f".{service_dir.name}.removing.*"))


def _reap_tombstone(tombstone: Path) -> bool:
    deadline = time.monotonic() + _SUPERVISOR_REAP_TIMEOUT_SECONDS
    while _run(["s6-svok", str(tombstone)], timeout=5):
        if time.monotonic() >= deadline:
            return False
        time.sleep(_SUPERVISOR_REAP_POLL_SECONDS)
    shutil.rmtree(tombstone, ignore_errors=True)
    return not tombstone.exists()


def remove_service(service_dir: Path, *, scan_dir: Path) -> bool:
    if not service_dir.exists():
        return all(
            _reap_tombstone(tombstone)
            for tombstone in _removal_tombstones(service_dir)
        )
    if (service_dir / "run").is_file():
        if not _run(["s6-svc", "-d", str(service_dir)], timeout=5):
            return False
        if not _run(["s6-svwait", "-D", "-t", "10000", str(service_dir)]):
            return False
    tombstone = service_dir.with_name(
        f".{service_dir.name}.removing.{os.getpid()}"
    )
    if tombstone.exists():
        return False
    try:
        os.replace(service_dir, tombstone)
    except OSError:
        return False
    if not _run(["s6-svscanctl", "-an", str(scan_dir)], timeout=5):
        try:
            os.replace(tombstone, service_dir)
        except OSError:
            pass
        return False
    return _reap_tombstone(tombstone)


def hide_current_service(service_dir: Path, *, scan_dir: Path) -> bool:
    """Remove our scan name; the next install reaps the hidden supervisor."""

    if not service_dir.exists():
        return True
    tombstone = service_dir.with_name(
        f".{service_dir.name}.removing.{os.getpid()}"
    )
    if tombstone.exists():
        return False
    try:
        os.replace(service_dir, tombstone)
    except OSError:
        return False
    if _run(["s6-svscanctl", "-an", str(scan_dir)], timeout=5):
        return True
    try:
        os.replace(tombstone, service_dir)
    except OSError:
        pass
    return False


def cleanup_orphaned_services(
    *,
    plugin_root: Path,
    scan_dir: Path,
    t3_service_dir: Path,
    watchdog_service_dir: Path,
    service_state_path: Path,
    lifecycle_lock_path: Path,
) -> bool:
    try:
        with lifecycle_lock(lifecycle_lock_path):
            if (plugin_root / "plugin.yaml").is_file():
                return False
            if not persist_uninstalled_state(service_state_path):
                return False
            if not remove_service(t3_service_dir, scan_dir=scan_dir):
                return False
            # Keep our live supervise tree intact under a hidden name until
            # this process exits. A later install removes the tombstone only
            # after s6-svok confirms that this supervisor has been reaped.
            return hide_current_service(
                watchdog_service_dir,
                scan_dir=scan_dir,
            )
    except OSError as error:
        print(
            f"T3 watchdog could not acquire lifecycle lock at "
            f"{lifecycle_lock_path}: {error}; cleanup will retry",
            file=sys.stderr,
        )
        return False


def monitor(
    *,
    plugin_root: Path,
    scan_dir: Path,
    t3_service_dir: Path,
    watchdog_service_dir: Path,
    service_state_path: Path,
    lifecycle_lock_path: Path,
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
        cleaned_up = cleanup_orphaned_services(
            plugin_root=plugin_root,
            scan_dir=scan_dir,
            t3_service_dir=t3_service_dir,
            watchdog_service_dir=watchdog_service_dir,
            service_state_path=service_state_path,
            lifecycle_lock_path=lifecycle_lock_path,
        )
        if cleaned_up:
            return


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plugin-root", type=Path, required=True)
    parser.add_argument("--scan-dir", type=Path, required=True)
    parser.add_argument("--t3-service-dir", type=Path, required=True)
    parser.add_argument("--watchdog-service-dir", type=Path, required=True)
    parser.add_argument("--service-state-path", type=Path, required=True)
    parser.add_argument("--lifecycle-lock-path", type=Path, required=True)
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
        service_state_path=args.service_state_path,
        lifecycle_lock_path=args.lifecycle_lock_path,
        interval_seconds=args.interval_seconds,
        misses_required=args.misses_required,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

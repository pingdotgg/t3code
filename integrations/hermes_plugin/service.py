"""T3 Code binary and s6 lifecycle management for the Hermes plugin."""

from __future__ import annotations

import shlex
import shutil
import socket
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

from .config import PluginConfig
from .releases import binary_version, install_release


class ServiceError(RuntimeError):
    """Raised when an s6 lifecycle command fails."""


@dataclass(frozen=True)
class ServiceStatus:
    binary_installed: bool
    binary_version: str | None
    service_installed: bool
    service_running: bool
    watchdog_installed: bool
    watchdog_running: bool
    reachable: bool
    host: str
    port: int
    service_dir: str
    data_dir: str

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def _command(
    command: list[str], *, timeout: float = 30, check: bool = True
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ServiceError(f"could not run {command[0]}: {error}") from error
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        suffix = f": {detail}" if detail else ""
        raise ServiceError(
            f"{command[0]} exited with status {result.returncode}{suffix}"
        )
    return result


def _service_running(service_dir: Path) -> bool:
    if not (service_dir / "run").is_file():
        return False
    result = _command(["s6-svstat", str(service_dir)], timeout=5, check=False)
    return result.returncode == 0 and result.stdout.lstrip().startswith("up ")


def _reachable(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.75):
            return True
    except OSError:
        return False


def status(config: PluginConfig) -> ServiceStatus:
    return ServiceStatus(
        binary_installed=config.binary_path.is_file(),
        binary_version=binary_version(config.binary_path),
        service_installed=(config.service_dir / "run").is_file(),
        service_running=_service_running(config.service_dir),
        watchdog_installed=(config.watchdog_service_dir / "run").is_file(),
        watchdog_running=_service_running(config.watchdog_service_dir),
        reachable=_reachable(config.port),
        host=config.host,
        port=config.port,
        service_dir=str(config.service_dir),
        data_dir=str(config.data_dir),
    )


def _seed_supervise_skeleton(service_dir: Path) -> None:
    """Use Hermes' native dynamic-service ownership setup when available."""

    try:
        from hermes_cli.service_manager import _seed_supervise_skeleton as seed
    except ImportError:
        return
    seed(service_dir)


def _prepare_service_dir(service_dir: Path) -> None:
    service_dir.mkdir(parents=True, exist_ok=True)
    _seed_supervise_skeleton(service_dir)


def _t3_service_args(config: PluginConfig, action: str) -> list[str]:
    args = [
        str(config.binary_path),
        "service",
        action,
        "--supervisor",
        "s6",
        "--service-dir",
        str(config.service_dir),
        "--base-dir",
        str(config.data_dir),
        "--host",
        config.host,
        "--port",
        str(config.port),
        "--service-user",
        config.service_user,
    ]
    if action in {"install", "update"}:
        args.extend(
            ["--service-environment", f"HERMES_HOME={config.hermes_home}"]
        )
    if config.service_group:
        args.extend(["--service-group", config.service_group])
    return args


def _render_watchdog_run(config: PluginConfig, watchdog_path: Path) -> str:
    args = [
        sys.executable,
        str(watchdog_path),
        "--plugin-root",
        str(config.plugin_root),
        "--scan-dir",
        str(config.scan_dir),
        "--t3-service-dir",
        str(config.service_dir),
        "--watchdog-service-dir",
        str(config.watchdog_service_dir),
        "--interval-seconds",
        str(config.watch_interval_seconds),
        "--misses-required",
        str(config.watch_misses),
    ]
    return "#!/bin/sh\nset -eu\nexec " + " ".join(map(shlex.quote, args)) + "\n"


def _install_watchdog(config: PluginConfig) -> None:
    config.runtime_root.mkdir(parents=True, exist_ok=True)
    watchdog_path = config.runtime_root / "plugin-watchdog.py"
    source = Path(__file__).with_name("watchdog.py")
    shutil.copyfile(source, watchdog_path)
    watchdog_path.chmod(0o755)

    service_dir = config.watchdog_service_dir
    temporary = service_dir.with_name(f".{service_dir.name}.tmp")
    shutil.rmtree(temporary, ignore_errors=True)
    temporary.mkdir(parents=True)
    try:
        run_path = temporary / "run"
        run_path.write_text(
            _render_watchdog_run(config, watchdog_path), encoding="utf-8"
        )
        run_path.chmod(0o755)
        _seed_supervise_skeleton(temporary)
        if service_dir.exists():
            _remove_service_dir(service_dir)
        temporary.replace(service_dir)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise

    _command(["s6-svscanctl", "-a", str(config.scan_dir)], timeout=5)
    for _ in range(100):
        result = _command(["s6-svok", str(service_dir)], timeout=5, check=False)
        if result.returncode == 0:
            break
        time.sleep(0.05)
    else:
        raise ServiceError("watchdog service was not picked up by s6")
    _command(["s6-svc", "-u", str(service_dir)], timeout=5)


def _remove_service_dir(service_dir: Path) -> None:
    if not service_dir.exists():
        return
    _command(["s6-svc", "-d", str(service_dir)], timeout=5, check=False)
    _command(
        ["s6-svwait", "-D", "-t", "10000", str(service_dir)],
        timeout=15,
        check=False,
    )
    # Match Hermes' dynamic-service teardown: ask s6-svscan to reap the
    # supervisor, then give it one loop turn before removing its files.
    _command(
        ["s6-svscanctl", "-an", str(service_dir.parent)],
        timeout=5,
        check=False,
    )
    time.sleep(0.2)
    shutil.rmtree(service_dir, ignore_errors=True)


def install(config: PluginConfig) -> dict[str, object]:
    release = install_release(config)
    config.data_dir.mkdir(parents=True, exist_ok=True)
    _prepare_service_dir(config.service_dir)
    _command(_t3_service_args(config, "install"), timeout=45)
    try:
        _install_watchdog(config)
    except Exception:
        _command(_t3_service_args(config, "uninstall"), timeout=30, check=False)
        _remove_service_dir(config.service_dir)
        raise
    return {
        "ok": True,
        "action": "installed",
        "release": release.version,
        "status": status(config).to_dict(),
    }


def update(config: PluginConfig) -> dict[str, object]:
    release = install_release(config)
    _prepare_service_dir(config.service_dir)
    _command(_t3_service_args(config, "update"), timeout=45)
    _install_watchdog(config)
    return {
        "ok": True,
        "action": "updated",
        "release": release.version,
        "status": status(config).to_dict(),
    }


def uninstall(config: PluginConfig) -> dict[str, object]:
    _remove_service_dir(config.watchdog_service_dir)
    removed = False
    if config.binary_path.is_file():
        result = _command(
            _t3_service_args(config, "uninstall"), timeout=30, check=False
        )
        removed = result.returncode == 0
    _remove_service_dir(config.service_dir)
    _command(["s6-svscanctl", "-an", str(config.scan_dir)], timeout=5, check=False)
    return {
        "ok": True,
        "action": "uninstalled",
        "removed": removed,
        "status": status(config).to_dict(),
    }

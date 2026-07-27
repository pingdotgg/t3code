"""T3 Code binary and s6 lifecycle management for the Hermes plugin."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
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
    desired_state: str = "unknown"
    reconciliation_status: str = "idle"
    reconciliation_error: str | None = None

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


_STATE_VERSION = 1
_DESIRED_INSTALLED = "installed"
_DESIRED_UNINSTALLED = "uninstalled"
_RECONCILIATION_LOCK = threading.Lock()
_RUNTIME_RECONCILIATION: dict[str, dict[str, str | None]] = {}


def _timestamp() -> str:
    return datetime.now(UTC).isoformat()


@contextmanager
def lifecycle_lock(config: PluginConfig):
    """Serialize lifecycle and state changes across dashboard/watchdog processes."""

    path = config.lifecycle_lock_path
    descriptor: int | None = None
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(
            path,
            os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW,
            0o600,
        )
        if os.geteuid() == 0:
            owner = path.parent.stat()
            os.fchown(descriptor, owner.st_uid, owner.st_gid)
        fcntl.flock(descriptor, fcntl.LOCK_EX)
    except OSError as error:
        if descriptor is not None:
            os.close(descriptor)
        raise ServiceError(f"could not acquire service lifecycle lock: {error}") from error
    try:
        yield
    finally:
        os.close(descriptor)


def _binary_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
    except OSError as error:
        raise ServiceError(f"could not read installed T3 binary: {error}") from error
    return digest.hexdigest()


def _read_service_state(config: PluginConfig) -> dict[str, object] | None:
    path = config.service_state_path
    if not path.exists():
        return None
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ServiceError(
            f"could not read persistent service state at {path}: {error}; "
            "use Install and start or Remove service to repair it"
        ) from error
    if not isinstance(state, dict) or state.get("version") != _STATE_VERSION:
        raise ServiceError(
            f"persistent service state at {path} is unsupported; "
            "use Install and start or Remove service to repair it"
        )
    desired_state = state.get("desired_state")
    if desired_state not in {_DESIRED_INSTALLED, _DESIRED_UNINSTALLED}:
        raise ServiceError(
            f"persistent service state at {path} has an invalid desired_state; "
            "use Install and start or Remove service to repair it"
        )
    return state


def _write_service_state(config: PluginConfig, state: dict[str, object]) -> None:
    path = config.service_state_path
    temporary: Path | None = None
    payload = json.dumps(state, indent=2, sort_keys=True) + "\n"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as output:
            temporary = Path(output.name)
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
            if os.geteuid() == 0:
                owner = path.parent.stat()
                os.fchown(output.fileno(), owner.st_uid, owner.st_gid)
                os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except OSError as error:
        try:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise ServiceError(f"could not persist service desired state: {error}") from error


def _set_desired_state(
    config: PluginConfig,
    desired_state: str,
    *,
    version: str | None = None,
) -> None:
    state: dict[str, object] = {
        "version": _STATE_VERSION,
        "desired_state": desired_state,
        "updated_at": _timestamp(),
    }
    if desired_state == _DESIRED_INSTALLED:
        state["binary_sha256"] = _binary_sha256(config.binary_path)
        if version is not None:
            state["binary_version"] = version
    _write_service_state(config, state)
    with _RECONCILIATION_LOCK:
        _RUNTIME_RECONCILIATION.pop(str(config.service_state_path), None)


def _record_reconciliation(
    config: PluginConfig,
    reconciliation_status: str,
    error: str | None = None,
) -> None:
    result = {
        "status": reconciliation_status,
        "error": error,
        "updated_at": _timestamp(),
    }
    key = str(config.service_state_path)
    with _RECONCILIATION_LOCK:
        _RUNTIME_RECONCILIATION[key] = result
    try:
        state = _read_service_state(config)
        if state is None:
            return
        state["last_reconciliation"] = result
        _write_service_state(config, state)
    except ServiceError:
        # The in-process status still exposes the failure. Reconciliation
        # reporting must never make dashboard startup less reliable.
        pass


def record_reconciliation_failure(config: PluginConfig, error: Exception) -> None:
    _record_reconciliation(config, "failed", str(error))


def _service_state_for_status(
    config: PluginConfig,
) -> tuple[str, str, str | None]:
    desired_state = "unknown"
    reconciliation_status = "idle"
    reconciliation_error = None
    try:
        state = _read_service_state(config)
        if state is not None:
            desired_state = str(state["desired_state"])
            last = state.get("last_reconciliation")
            if isinstance(last, dict):
                reconciliation_status = str(last.get("status") or "idle")
                raw_error = last.get("error")
                reconciliation_error = (
                    str(raw_error) if raw_error is not None else None
                )
    except ServiceError as error:
        reconciliation_status = "failed"
        reconciliation_error = str(error)

    key = str(config.service_state_path)
    with _RECONCILIATION_LOCK:
        runtime = _RUNTIME_RECONCILIATION.get(key)
    if runtime is not None:
        reconciliation_status = str(runtime["status"])
        raw_error = runtime["error"]
        reconciliation_error = str(raw_error) if raw_error is not None else None
    return desired_state, reconciliation_status, reconciliation_error


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
    try:
        result = _command(["s6-svstat", str(service_dir)], timeout=5, check=False)
    except ServiceError:
        return False
    return result.returncode == 0 and result.stdout.lstrip().startswith("up ")


def _reachable(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.75):
            return True
    except OSError:
        return False


def status(config: PluginConfig) -> ServiceStatus:
    desired_state, reconciliation_status, reconciliation_error = (
        _service_state_for_status(config)
    )
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
        desired_state=desired_state,
        reconciliation_status=reconciliation_status,
        reconciliation_error=reconciliation_error,
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


def _remove_redundant_s6_svperms(service_dir: Path) -> None:
    """Adapt T3's native s6 script for Hermes' pre-seeded supervise tree."""

    run_path = service_dir / "run"
    temporary: Path | None = None
    try:
        descriptor = os.open(run_path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        with os.fdopen(descriptor, encoding="utf-8") as source:
            mode = stat.S_IMODE(os.fstat(source.fileno()).st_mode)
            contents = source.read()
        adapted = "".join(
            line
            for line in contents.splitlines(keepends=True)
            if not line.startswith("s6-svperms ")
        )
        if adapted == contents:
            return
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=service_dir,
            prefix=".run.",
            suffix=".tmp",
            delete=False,
        ) as output:
            temporary = Path(output.name)
            output.write(adapted)
            output.flush()
            os.fchmod(output.fileno(), mode)
            os.fsync(output.fileno())
        os.replace(temporary, run_path)
        directory = os.open(service_dir, os.O_RDONLY | os.O_CLOEXEC)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except (OSError, UnicodeError) as error:
        try:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise ServiceError(
            f"could not adapt the T3 s6 run script at {run_path}: {error}"
        ) from error


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


def _write_t3_s6_service(
    config: PluginConfig,
    action: str,
    *,
    timeout: float,
) -> subprocess.CompletedProcess[str]:
    result = _command(_t3_service_args(config, action), timeout=timeout)
    _remove_redundant_s6_svperms(config.service_dir)
    return result


def _render_watchdog_run(config: PluginConfig, watchdog_path: Path) -> str:
    args = [sys.executable, str(watchdog_path), "--plugin-root"]
    args.extend(
        [
            str(config.plugin_root),
            "--scan-dir",
            str(config.scan_dir),
            "--t3-service-dir",
            str(config.service_dir),
            "--watchdog-service-dir",
            str(config.watchdog_service_dir),
            "--service-state-path",
            str(config.service_state_path),
            "--lifecycle-lock-path",
            str(config.lifecycle_lock_path),
            "--interval-seconds",
            str(config.watch_interval_seconds),
            "--misses-required",
            str(config.watch_misses),
        ]
    )
    return "#!/bin/sh\nset -eu\nexec " + " ".join(map(shlex.quote, args)) + "\n"


def _install_watchdog(config: PluginConfig) -> None:
    source = Path(__file__).with_name("watchdog.py")
    service_dir = config.watchdog_service_dir
    temporary = service_dir.with_name(f".{service_dir.name}.tmp")
    shutil.rmtree(temporary, ignore_errors=True)
    temporary.mkdir(parents=True)
    try:
        watchdog_path = temporary / "plugin-watchdog.py"
        shutil.copyfile(source, watchdog_path)
        watchdog_path.chmod(0o755)
        run_path = temporary / "run"
        run_path.write_text(
            _render_watchdog_run(
                config,
                service_dir / watchdog_path.name,
            ),
            encoding="utf-8",
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

    if not (service_dir / "run").is_file():
        # A failed install can leave a directory that s6 cannot launch. Ask
        # the scanner to reap any supervisor it may have allocated before
        # deleting the inert slot.
        _command(
            ["s6-svscanctl", "-an", str(service_dir.parent)],
            timeout=5,
        )
        time.sleep(0.2)
        shutil.rmtree(service_dir, ignore_errors=True)
        if service_dir.exists():
            raise ServiceError(f"could not remove incomplete s6 slot {service_dir}")
        return

    supervised = _command(
        ["s6-svok", str(service_dir)],
        timeout=5,
        check=False,
    )
    if supervised.returncode != 0:
        raise ServiceError(
            f"refusing to remove complete s6 slot {service_dir} because its "
            "supervisor is unavailable"
        )
    _command(["s6-svc", "-d", str(service_dir)], timeout=5)
    _command(
        ["s6-svwait", "-D", "-t", "10000", str(service_dir)],
        timeout=15,
    )
    # Match Hermes' dynamic-service teardown: ask s6-svscan to reap the
    # supervisor, then give it one loop turn before removing its files.
    _command(
        ["s6-svscanctl", "-an", str(service_dir.parent)],
        timeout=5,
    )
    time.sleep(0.2)
    shutil.rmtree(service_dir, ignore_errors=True)
    if service_dir.exists():
        raise ServiceError(f"could not remove s6 slot {service_dir}")


def install(config: PluginConfig) -> dict[str, object]:
    with lifecycle_lock(config):
        return _install_locked(config)


def _install_locked(config: PluginConfig) -> dict[str, object]:
    release = install_release(config)
    # The verified binary replacement and its durable recovery metadata are
    # one transaction. If later s6 activation fails, boot can retry from this
    # local binary instead of rejecting it against the previous checksum.
    _set_desired_state(config, _DESIRED_INSTALLED, version=release.version)
    config.data_dir.mkdir(parents=True, exist_ok=True)
    _prepare_service_dir(config.service_dir)
    _write_t3_s6_service(config, "install", timeout=45)
    try:
        _install_watchdog(config)
    except Exception:
        try:
            _command(
                _t3_service_args(config, "uninstall"),
                timeout=30,
                check=False,
            )
        except ServiceError:
            pass
        _remove_service_dir(config.watchdog_service_dir)
        _remove_service_dir(config.service_dir)
        raise
    return {
        "ok": True,
        "action": "installed",
        "release": release.version,
        "status": status(config).to_dict(),
    }


def update(config: PluginConfig) -> dict[str, object]:
    with lifecycle_lock(config):
        return _update_locked(config)


def _update_locked(config: PluginConfig) -> dict[str, object]:
    release = install_release(config)
    _set_desired_state(config, _DESIRED_INSTALLED, version=release.version)
    _prepare_service_dir(config.service_dir)
    _write_t3_s6_service(config, "update", timeout=45)
    _install_watchdog(config)
    return {
        "ok": True,
        "action": "updated",
        "release": release.version,
        "status": status(config).to_dict(),
    }


def uninstall(config: PluginConfig) -> dict[str, object]:
    with lifecycle_lock(config):
        return _uninstall_locked(config)


def _uninstall_locked(config: PluginConfig) -> dict[str, object]:
    # Persist operator intent before touching the ephemeral slots. If teardown
    # is interrupted or fails, the next dashboard boot must not resurrect the
    # service the user explicitly asked to remove.
    _set_desired_state(config, _DESIRED_UNINSTALLED)
    _remove_service_dir(config.watchdog_service_dir)
    removed = False
    if config.binary_path.is_file():
        result = _command(
            _t3_service_args(config, "uninstall"), timeout=30, check=False
        )
        removed = result.returncode == 0
    _remove_service_dir(config.service_dir)
    _command(["s6-svscanctl", "-an", str(config.scan_dir)], timeout=5, check=False)
    remaining = [
        str(service_dir)
        for service_dir in (config.service_dir, config.watchdog_service_dir)
        if service_dir.exists()
    ]
    if remaining:
        raise ServiceError(
            "service removal did not finish for "
            + ", ".join(remaining)
            + "; desired state remains uninstalled and boot recovery is disabled"
        )
    return {
        "ok": True,
        "action": "uninstalled",
        "removed": removed,
        "status": status(config).to_dict(),
    }


def _validate_recovery_binary(
    config: PluginConfig, state: dict[str, object]
) -> str:
    if not config.binary_path.is_file():
        raise ServiceError(
            f"automatic recovery cannot find the installed T3 binary at "
            f"{config.binary_path}; use Install and start to download a "
            "checksum-verified release"
        )
    expected_checksum = state.get("binary_sha256")
    if isinstance(expected_checksum, str):
        actual_checksum = _binary_sha256(config.binary_path)
        if actual_checksum != expected_checksum:
            raise ServiceError(
                f"automatic recovery found a checksum mismatch for "
                f"{config.binary_path}; use Install and start to replace the "
                "corrupt binary"
            )
    else:
        raise ServiceError(
            "automatic recovery has no trusted checksum for the installed "
            "T3 binary; use Install and start to verify it and establish "
            "durable desired state"
        )
    version = binary_version(config.binary_path)
    if version is None:
        raise ServiceError(
            f"automatic recovery cannot execute the installed T3 binary at "
            f"{config.binary_path}; use Install and start to replace it with "
            "a checksum-verified release"
        )
    return version


def reconcile(config: PluginConfig) -> dict[str, object]:
    """Restore missing ephemeral s6 slots from durable operator intent."""

    lock_acquired = False
    try:
        with lifecycle_lock(config):
            lock_acquired = True
            return _reconcile_locked(config)
    except Exception as error:
        if not lock_acquired:
            record_reconciliation_failure(config, error)
        raise


def _reconcile_locked(config: PluginConfig) -> dict[str, object]:
    try:
        state = _read_service_state(config)
        if state is None or state["desired_state"] != _DESIRED_INSTALLED:
            _record_reconciliation(config, "not_requested")
            return {"ok": True, "action": "not_requested"}

        service_installed = (config.service_dir / "run").is_file()
        watchdog_installed = (config.watchdog_service_dir / "run").is_file()
        service_running = service_installed and _service_running(config.service_dir)
        watchdog_running = watchdog_installed and _service_running(
            config.watchdog_service_dir
        )
        if service_running and watchdog_running:
            _record_reconciliation(config, "not_needed")
            return {"ok": True, "action": "not_needed"}

        if service_installed and watchdog_installed:
            if not service_running:
                _validate_recovery_binary(config, state)
                _remove_redundant_s6_svperms(config.service_dir)
            _command(["s6-svscanctl", "-a", str(config.scan_dir)], timeout=5)
            if not service_running:
                _command(["s6-svc", "-u", str(config.service_dir)], timeout=5)
            if not watchdog_running:
                _command(
                    ["s6-svc", "-u", str(config.watchdog_service_dir)],
                    timeout=5,
                )
            _record_reconciliation(config, "started")
            return {"ok": True, "action": "started"}

        _validate_recovery_binary(config, state)
        if not config.scan_dir.is_dir():
            raise ServiceError(
                f"automatic recovery requires an active s6 scan directory at "
                f"{config.scan_dir}; verify this is a Hermes s6 container, "
                "then restart the dashboard"
            )
        if not service_installed and config.service_dir.exists():
            raise ServiceError(
                f"automatic recovery found an incomplete T3 s6 slot at "
                f"{config.service_dir}; use Remove service, then Install and start"
            )
        if not watchdog_installed and config.watchdog_service_dir.exists():
            raise ServiceError(
                f"automatic recovery found an incomplete watchdog s6 slot at "
                f"{config.watchdog_service_dir}; use Remove service, then "
                "Install and start"
            )

        installed_service_now = False
        try:
            if not service_installed:
                installed_service_now = True
                config.data_dir.mkdir(parents=True, exist_ok=True)
                _prepare_service_dir(config.service_dir)
                _write_t3_s6_service(config, "install", timeout=45)
                if not (config.service_dir / "run").is_file():
                    raise ServiceError(
                        "T3 recovery command completed without creating its s6 run file"
                    )
            if not watchdog_installed:
                _install_watchdog(config)
                if not (config.watchdog_service_dir / "run").is_file():
                    raise ServiceError(
                        "watchdog recovery completed without creating its s6 run file"
                    )
            if service_installed and not service_running:
                _remove_redundant_s6_svperms(config.service_dir)
                _command(["s6-svc", "-u", str(config.service_dir)], timeout=5)
            if watchdog_installed and not watchdog_running:
                _command(
                    ["s6-svc", "-u", str(config.watchdog_service_dir)],
                    timeout=5,
                )
        except Exception:
            if not watchdog_installed:
                _remove_service_dir(config.watchdog_service_dir)
            if installed_service_now:
                try:
                    _command(
                        _t3_service_args(config, "uninstall"),
                        timeout=30,
                        check=False,
                    )
                except ServiceError:
                    pass
                _remove_service_dir(config.service_dir)
            raise

        _record_reconciliation(config, "recovered")
        return {"ok": True, "action": "recovered"}
    except Exception as error:
        record_reconciliation_failure(config, error)
        raise

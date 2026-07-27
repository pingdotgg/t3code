"""T3 Code binary and s6 lifecycle management for the Hermes plugin."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import pwd
import re
import shlex
import shutil
import signal
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
_SERVICE_START_TIMEOUT_SECONDS = 10.0
_SERVICE_START_POLL_SECONDS = 0.1
_SERVICE_STABLE_SECONDS = 0.5
_PROCESS_EXIT_TIMEOUT_SECONDS = 10.0
_SVSTAT_PID = re.compile(r"^\s*up \(pid ([1-9][0-9]*)\)")


@dataclass(frozen=True)
class _StaleServiceProcess:
    child_pid: int
    supervisor_pid: int


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


def _service_pid(service_dir: Path) -> int | None:
    if not (service_dir / "run").is_file():
        return None
    try:
        result = _command(["s6-svstat", str(service_dir)], timeout=5, check=False)
    except ServiceError:
        return None
    if result.returncode != 0:
        return None
    match = _SVSTAT_PID.match(result.stdout)
    return int(match.group(1)) if match is not None else None


def _service_running(service_dir: Path) -> bool:
    return _service_pid(service_dir) is not None


def _wait_for_service_up(
    service_dir: Path,
    *,
    timeout: float | None = None,
    poll_interval: float | None = None,
    reject_pid: int | None = None,
    stable_seconds: float | None = None,
) -> int:
    """Require one positive PID to remain current for a bounded stable window."""

    if timeout is None:
        timeout = _SERVICE_START_TIMEOUT_SECONDS
    if poll_interval is None:
        poll_interval = _SERVICE_START_POLL_SECONDS
    if stable_seconds is None:
        stable_seconds = _SERVICE_STABLE_SECONDS
    deadline = time.monotonic() + timeout
    candidate_pid: int | None = None
    candidate_since = 0.0
    while True:
        pid = _service_pid(service_dir)
        if pid == reject_pid:
            pid = None
        now = time.monotonic()
        if pid is None:
            candidate_pid = None
        elif pid != candidate_pid:
            candidate_pid = pid
            candidate_since = now
        elif now - candidate_since >= stable_seconds:
            return pid
        if now >= deadline:
            raise ServiceError(
                f"s6 service {service_dir} did not reach a stable positive pid "
                f"within {timeout:g} seconds"
            )
        time.sleep(poll_interval)


def _reachable(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.75):
            return True
    except OSError:
        return False


def _proc_status(proc_dir: Path) -> tuple[int, int] | None:
    try:
        lines = (proc_dir / "status").read_text(encoding="utf-8").splitlines()
        fields = {
            key: value.strip()
            for line in lines
            if ":" in line
            for key, value in [line.split(":", 1)]
            if key in {"Uid", "PPid"}
        }
        uid = int(fields["Uid"].split()[0])
        parent_pid = int(fields["PPid"])
    except (OSError, KeyError, ValueError, IndexError):
        return None
    return uid, parent_pid


def _proc_command(proc_dir: Path) -> list[str] | None:
    try:
        raw = (proc_dir / "cmdline").read_bytes()
    except OSError:
        return None
    parts = raw.rstrip(b"\0").split(b"\0") if raw else []
    return [os.fsdecode(part) for part in parts]


def _proc_link(proc_dir: Path, name: str) -> tuple[str, bool] | None:
    try:
        target = os.readlink(proc_dir / name)
    except OSError:
        return None
    suffix = " (deleted)"
    return (
        target.removesuffix(suffix),
        target.endswith(suffix),
    )


def _process_has_expected_hermes_home(
    pid: int,
    config: PluginConfig,
    *,
    proc_root: Path = Path("/proc"),
) -> bool:
    try:
        environment = (proc_root / str(pid) / "environ").read_bytes().split(b"\0")
    except OSError:
        return False
    expected = b"HERMES_HOME=" + os.fsencode(config.hermes_home)
    return environment.count(expected) == 1


def _listening_socket_inodes(port: int, proc_root: Path) -> set[str]:
    inodes: set[str] = set()
    for table in ("tcp", "tcp6"):
        try:
            lines = (proc_root / "net" / table).read_text(
                encoding="ascii"
            ).splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            fields = line.split()
            if len(fields) < 10 or fields[3] != "0A":
                continue
            try:
                local_port = int(fields[1].rsplit(":", 1)[1], 16)
            except (IndexError, ValueError):
                continue
            if local_port == port:
                inodes.add(fields[9])
    return inodes


def _process_owns_socket(proc_dir: Path, socket_inodes: set[str]) -> bool:
    if not socket_inodes:
        return False
    try:
        descriptors = list((proc_dir / "fd").iterdir())
    except OSError:
        return False
    for descriptor in descriptors:
        try:
            target = os.readlink(descriptor)
        except OSError:
            continue
        if (
            target.startswith("socket:[")
            and target.endswith("]")
            and target[8:-1] in socket_inodes
        ):
            return True
    return False


def _expected_service_uid(config: PluginConfig) -> int:
    if config.service_user.isdecimal():
        return int(config.service_user)
    try:
        return pwd.getpwnam(config.service_user).pw_uid
    except KeyError as error:
        raise ServiceError(
            f"cannot validate a stale T3 process because service user "
            f"{config.service_user!r} is unavailable"
        ) from error


def _find_stale_service_processes(
    config: PluginConfig,
    *,
    proc_root: Path = Path("/proc"),
) -> list[_StaleServiceProcess]:
    """Find only deleted-slot T3 children that own the configured listen port."""

    expected_uid = _expected_service_uid(config)
    socket_inodes = _listening_socket_inodes(config.port, proc_root)
    matches: list[_StaleServiceProcess] = []
    try:
        processes = list(proc_root.iterdir())
    except OSError as error:
        raise ServiceError(f"could not inspect processes for stale T3 service: {error}")

    for proc_dir in processes:
        if not proc_dir.name.isdecimal():
            continue
        child_status = _proc_status(proc_dir)
        if child_status is None or child_status[0] != expected_uid:
            continue
        if _proc_command(proc_dir) != [str(config.binary_path), "serve"]:
            continue
        executable = _proc_link(proc_dir, "exe")
        working_dir = _proc_link(proc_dir, "cwd")
        if (
            executable != (str(config.binary_path), True)
            or working_dir != (str(config.service_dir), True)
            or not _process_owns_socket(proc_dir, socket_inodes)
        ):
            continue

        parent_pid = child_status[1]
        parent_dir = proc_root / str(parent_pid)
        parent_status = _proc_status(parent_dir)
        parent_command = _proc_command(parent_dir)
        parent_executable = _proc_link(parent_dir, "exe")
        parent_working_dir = _proc_link(parent_dir, "cwd")
        if (
            parent_status is None
            or parent_status[0] != 0
            or parent_command is None
            or len(parent_command) != 2
            or Path(parent_command[0]).name != "s6-supervise"
            or parent_command[1] != config.service_dir.name
            or parent_executable is None
            or Path(parent_executable[0]).name != "s6-supervise"
            or parent_working_dir != (str(config.service_dir), True)
        ):
            continue
        matches.append(
            _StaleServiceProcess(
                child_pid=int(proc_dir.name),
                supervisor_pid=parent_pid,
            )
        )
    return matches


def _wait_for_process_exit(pid: int, *, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while Path(f"/proc/{pid}").exists():
        if time.monotonic() >= deadline:
            raise ServiceError(
                f"stale T3 service process {pid} did not exit within "
                f"{timeout:g} seconds"
            )
        time.sleep(_SERVICE_START_POLL_SECONDS)


def _terminate_exact_stale_service(config: PluginConfig) -> None:
    candidates = _find_stale_service_processes(config)
    if len(candidates) != 1:
        raise ServiceError(
            f"refusing stale T3 cleanup: found {len(candidates)} exact stale "
            "service processes for the configured port; manual repair is required"
        )
    stale = candidates[0]
    try:
        pid_descriptor = os.pidfd_open(stale.child_pid)
    except OSError as error:
        raise ServiceError(
            f"could not safely open exact stale T3 process {stale.child_pid}: {error}"
        ) from error
    try:
        # Revalidate after pinning the PID so a process-exit/PID-reuse race
        # cannot redirect the signal to an unrelated process.
        if _find_stale_service_processes(config) != [stale]:
            raise ServiceError(
                "refusing stale T3 cleanup because process identity changed "
                "during validation"
            )
        try:
            signal.pidfd_send_signal(pid_descriptor, signal.SIGTERM)
        except OSError as error:
            raise ServiceError(
                f"could not terminate exact stale T3 process {stale.child_pid}: {error}"
            ) from error
    finally:
        os.close(pid_descriptor)
    _wait_for_process_exit(
        stale.child_pid,
        timeout=_PROCESS_EXIT_TIMEOUT_SECONDS,
    )
    _wait_for_process_exit(
        stale.supervisor_pid,
        timeout=_PROCESS_EXIT_TIMEOUT_SECONDS,
    )


def _verify_t3_service_up(
    config: PluginConfig,
    *,
    reject_pid: int | None = None,
) -> int:
    try:
        pid = _wait_for_service_up(
            config.service_dir,
            reject_pid=reject_pid,
        )
    except ServiceError:
        if not _reachable(config.port):
            raise
        _terminate_exact_stale_service(config)
        _command(["s6-svc", "-u", str(config.service_dir)], timeout=5)
        pid = _wait_for_service_up(
            config.service_dir,
            reject_pid=reject_pid,
        )
    if not _process_has_expected_hermes_home(pid, config):
        raise ServiceError(
            f"T3 service process {pid} is missing the configured HERMES_HOME"
        )
    return pid


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


def _clear_reaped_tombstones(service_dir: Path) -> None:
    tombstones = list(
        service_dir.parent.glob(f".{service_dir.name}.removing.*")
    )
    for tombstone in tombstones:
        supervised = _command(
            ["s6-svok", str(tombstone)],
            timeout=5,
            check=False,
        )
        if supervised.returncode == 0:
            raise ServiceError(
                f"refusing to create s6 slot {service_dir} while an old "
                "supervisor removal is incomplete"
            )
        shutil.rmtree(tombstone)


def _prepare_service_dir(service_dir: Path) -> None:
    _clear_reaped_tombstones(service_dir)
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


def _service_has_expected_hermes_home(config: PluginConfig) -> bool:
    """Check the native T3 environment marker without exposing its contents."""

    run_path = config.service_dir / "run"
    try:
        descriptor = os.open(run_path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        with os.fdopen(descriptor, encoding="utf-8") as source:
            contents = source.read()
    except (OSError, UnicodeError) as error:
        raise ServiceError(
            f"could not inspect the T3 s6 run script at {run_path}: {error}"
        ) from error

    begin = "  # t3-service-environment:begin\n"
    end = "  # t3-service-environment:end\n"
    block_start = contents.find(begin)
    if block_start < 0:
        return False
    content_start = block_start + len(begin)
    block_end = contents.find(end, content_start)
    if block_end < 0:
        return False

    assignments: list[str] = []
    for line in contents[content_start:block_end].splitlines():
        try:
            tokens = shlex.split(line.strip())
        except ValueError:
            if "HERMES_HOME" in line:
                return False
            continue
        if (
            len(tokens) == 2
            and tokens[0] == "export"
            and tokens[1].startswith("HERMES_HOME=")
        ):
            assignments.append(tokens[1].removeprefix("HERMES_HOME="))
        elif "HERMES_HOME" in line:
            return False
    return assignments == [str(config.hermes_home)]


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
    previous_pid = _service_pid(config.service_dir) if action == "update" else None
    result = _command(_t3_service_args(config, action), timeout=timeout)
    _remove_redundant_s6_svperms(config.service_dir)
    _verify_t3_service_up(config, reject_pid=previous_pid)
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
    _clear_reaped_tombstones(service_dir)
    if service_dir.is_symlink():
        raise ServiceError(f"refusing symlinked watchdog s6 slot {service_dir}")
    service_dir.mkdir(parents=True, exist_ok=True)
    _seed_supervise_skeleton(service_dir)

    def replace_file(path: Path, contents: bytes, mode: int) -> None:
        temporary: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                dir=service_dir,
                prefix=f".{path.name}.",
                suffix=".tmp",
                delete=False,
            ) as output:
                temporary = Path(output.name)
                output.write(contents)
                output.flush()
                os.fchmod(output.fileno(), mode)
                os.fsync(output.fileno())
            os.replace(temporary, path)
        except OSError as error:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
            raise ServiceError(f"could not write watchdog service file {path}: {error}")

    try:
        watchdog_path = service_dir / "plugin-watchdog.py"
        replace_file(watchdog_path, source.read_bytes(), 0o755)
        run_path = service_dir / "run"
        replace_file(
            run_path,
            _render_watchdog_run(
                config,
                watchdog_path,
            ).encode(),
            0o755,
        )
        directory = os.open(service_dir, os.O_RDONLY | os.O_CLOEXEC)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except OSError as error:
        raise ServiceError(f"could not install watchdog service: {error}") from error

    _command(["s6-svscanctl", "-a", str(config.scan_dir)], timeout=5)
    for _ in range(100):
        result = _command(["s6-svok", str(service_dir)], timeout=5, check=False)
        if result.returncode == 0:
            break
        time.sleep(0.05)
    else:
        raise ServiceError("watchdog service was not picked up by s6")
    _command(["s6-svc", "-r", str(service_dir)], timeout=5)
    _wait_for_service_up(service_dir)


def _remove_service_dir(service_dir: Path) -> None:
    if not service_dir.exists():
        return

    supervised = _command(
        ["s6-svok", str(service_dir)],
        timeout=5,
        check=False,
    )
    if (service_dir / "run").is_file() and supervised.returncode != 0:
        raise ServiceError(
            f"refusing to remove complete s6 slot {service_dir} because its "
            "supervisor is unavailable"
        )
    if supervised.returncode == 0:
        _command(["s6-svc", "-d", str(service_dir)], timeout=5)
        _command(
            ["s6-svwait", "-D", "-t", "10000", str(service_dir)],
            timeout=15,
        )

    # Remove the scan name before asking s6-svscan to reap it. Hidden entries
    # are not scan slots, so the old supervisor cannot survive while a new
    # supervisor is allocated for the same public name.
    tombstone = service_dir.with_name(
        f".{service_dir.name}.removing.{os.getpid()}"
    )
    if tombstone.exists():
        raise ServiceError(f"stale s6 removal tombstone already exists at {tombstone}")
    os.replace(service_dir, tombstone)
    try:
        _command(
            ["s6-svscanctl", "-an", str(service_dir.parent)],
            timeout=5,
        )
    except Exception:
        os.replace(tombstone, service_dir)
        raise
    deadline = time.monotonic() + _PROCESS_EXIT_TIMEOUT_SECONDS
    while supervised.returncode == 0:
        supervised = _command(
            ["s6-svok", str(tombstone)],
            timeout=5,
            check=False,
        )
        if supervised.returncode != 0:
            break
        if time.monotonic() >= deadline:
            raise ServiceError(
                f"s6 supervisor for {service_dir} did not exit after slot removal"
            )
        time.sleep(_SERVICE_START_POLL_SECONDS)
    shutil.rmtree(tombstone)


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
        service_repaired = False
        if service_installed and not _service_has_expected_hermes_home(config):
            _validate_recovery_binary(config, state)
            _write_t3_s6_service(config, "update", timeout=45)
            service_running = _service_running(config.service_dir)
            service_repaired = True
        if service_running and watchdog_running:
            action = "repaired" if service_repaired else "not_needed"
            _record_reconciliation(config, action)
            return {"ok": True, "action": action}

        if service_installed and watchdog_installed:
            if not service_running:
                _validate_recovery_binary(config, state)
                _remove_redundant_s6_svperms(config.service_dir)
            _command(["s6-svscanctl", "-a", str(config.scan_dir)], timeout=5)
            if not service_running:
                _command(["s6-svc", "-u", str(config.service_dir)], timeout=5)
                _verify_t3_service_up(config)
            if not watchdog_running:
                _command(
                    ["s6-svc", "-u", str(config.watchdog_service_dir)],
                    timeout=5,
                )
                _wait_for_service_up(config.watchdog_service_dir)
            action = "repaired" if service_repaired else "started"
            _record_reconciliation(config, action)
            return {"ok": True, "action": action}

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
                _verify_t3_service_up(config)
            if watchdog_installed and not watchdog_running:
                _command(
                    ["s6-svc", "-u", str(config.watchdog_service_dir)],
                    timeout=5,
                )
                _wait_for_service_up(config.watchdog_service_dir)
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

        action = "repaired" if service_repaired else "recovered"
        _record_reconciliation(config, action)
        return {"ok": True, "action": action}
    except Exception as error:
        record_reconciliation_failure(config, error)
        raise

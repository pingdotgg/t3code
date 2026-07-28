"""Transactional source-and-runtime updates for the Hermes product."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from . import service
from .config import PluginConfig, load_config
from .releases import stage_coherent_release


class UpdateError(RuntimeError):
    """Raised when a coherent product update cannot complete."""


def _redact_error(error: object) -> str:
    message = str(error)
    message = re.sub(
        r"(https?://)[^/\s@]+@",
        r"\1[REDACTED]@",
        message,
        flags=re.IGNORECASE,
    )
    message = re.sub(
        r"(https?://[^\s?]+)\?[^\s]+",
        r"\1?[REDACTED]",
        message,
        flags=re.IGNORECASE,
    )
    message = re.sub(
        r"\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b",
        "[REDACTED]",
        message,
    )
    message = re.sub(
        r"(?i)\b(Bearer\s+)[^\s,;]+",
        r"\1[REDACTED]",
        message,
    )
    message = re.sub(
        r"(?i)\b(access[_-]?token|pairing[_-]?token|token|password|secret)"
        r"\s*[=:]\s*([^\s,;]+)",
        r"\1=[REDACTED]",
        message,
    )
    return message


class HostUpdateContract(Protocol):
    """Hermes-owned lifecycle handoff required to reload mounted plugin code."""

    version: int

    def preflight(self, *, plugin_name: str, plugin_root: Path) -> None: ...

    def complete(
        self,
        *,
        plugin_name: str,
        plugin_root: Path,
        source_commit: str,
        product_version: str,
    ) -> dict[str, object]: ...

    def rollback(
        self,
        *,
        plugin_name: str,
        plugin_root: Path,
        source_commit: str,
        product_version: str | None,
    ) -> dict[str, object]: ...


@dataclass(frozen=True)
class ProductTarget:
    version: str
    tag: str
    source_commit: str
    staged_binary: Path
    binary_sha256: str

    def to_dict(self) -> dict[str, str]:
        return {
            "version": self.version,
            "tag": self.tag,
            "source_commit": self.source_commit,
            "staged_binary": str(self.staged_binary),
            "binary_sha256": self.binary_sha256,
        }

    @classmethod
    def from_dict(cls, value: dict[str, object]) -> ProductTarget:
        return cls(
            version=str(value["version"]),
            tag=str(value["tag"]),
            source_commit=str(value["source_commit"]),
            staged_binary=Path(str(value["staged_binary"])),
            binary_sha256=str(value["binary_sha256"]),
        )


@dataclass(frozen=True)
class ProductSnapshot:
    source_commit: str
    binary_backup: Path | None
    state_backup: bytes | None
    source_ref: str | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "source_commit": self.source_commit,
            "binary_backup": (
                str(self.binary_backup) if self.binary_backup is not None else None
            ),
            "state_backup": (
                self.state_backup.decode("utf-8")
                if self.state_backup is not None
                else None
            ),
            "source_ref": self.source_ref,
        }

    @classmethod
    def from_dict(cls, value: dict[str, object]) -> ProductSnapshot:
        raw_backup = value.get("binary_backup")
        raw_state = value.get("state_backup")
        return cls(
            source_commit=str(value["source_commit"]),
            binary_backup=Path(str(raw_backup)) if raw_backup is not None else None,
            state_backup=(
                str(raw_state).encode("utf-8") if raw_state is not None else None
            ),
            source_ref=(
                str(value["source_ref"])
                if value.get("source_ref") is not None
                else None
            ),
        )


@dataclass(frozen=True)
class AdoptionSnapshot:
    state_backup: bytes | None
    services_installed: bool


def _command(
    command: list[str],
    *,
    cwd: Path | None = None,
    timeout: float = 120,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            command,
            cwd=str(cwd) if cwd is not None else None,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise UpdateError(f"could not run {command[0]}: {error}") from error
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise UpdateError(
            f"{command[0]} exited with status {result.returncode}"
            + (f": {detail}" if detail else "")
        )
    return result


def _git_output(config: PluginConfig, args: list[str]) -> str:
    return _command(
        ["git", *args],
        cwd=config.plugin_root,
        timeout=60,
    ).stdout.strip()


def _load_host_contract() -> HostUpdateContract:
    try:
        from hermes_cli.managed_plugin_update import (  # type: ignore[import-not-found]
            get_managed_update_contract,
        )
    except ImportError as error:
        raise UpdateError(
            "Hermes does not provide managed plugin update handoff v1; "
            "upgrade Hermes to a release that delegates the t3code Update "
            "operation and reloads mounted plugin backends"
        ) from error
    contract = get_managed_update_contract("t3code")
    if (
        contract is None
        or getattr(contract, "version", None) != 1
        or not callable(getattr(contract, "preflight", None))
        or not callable(getattr(contract, "complete", None))
        or not callable(getattr(contract, "rollback", None))
    ):
        raise UpdateError(
            "Hermes managed plugin update handoff v1 is unavailable for t3code"
        )
    return contract


def _preflight_checkout(
    config: PluginConfig,
    host: HostUpdateContract,
    operation: str,
) -> str:
    host.preflight(plugin_name="t3code", plugin_root=config.plugin_root)
    commit = _clean_checkout_commit(config, operation="Update")
    state = service._read_service_state(config)
    if state is not None and state.get("desired_state") == "installed":
        service._validate_recovery_binary(config, state)
    if operation == "update":
        if state is None or state.get("desired_state") != "installed":
            raise UpdateError(
                "Update requires an installed coherent product; use Install and "
                "start for the first activation"
            )
    return commit


def _clean_checkout_commit(config: PluginConfig, *, operation: str) -> str:
    if not (config.plugin_root / ".git").exists():
        raise UpdateError("T3 Code plugin is not a git checkout")
    dirty = _git_output(
        config,
        ["status", "--porcelain", "--untracked-files=all"],
    )
    if dirty:
        raise UpdateError(
            f"T3 Code plugin checkout has uncommitted changes; {operation} made "
            "no changes. Commit or remove the local work before retrying."
        )
    commit = _git_output(config, ["rev-parse", "HEAD"])
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise UpdateError("could not identify the current plugin source commit")
    return commit


def _assert_checkout_unchanged(
    config: PluginConfig,
    *,
    source_commit: str,
) -> None:
    if (
        _git_output(
            config,
            ["status", "--porcelain", "--untracked-files=all"],
        )
        or _git_output(config, ["rev-parse", "HEAD"]) != source_commit
    ):
        raise UpdateError(
            "T3 Code plugin checkout changed while Install was verifying the "
            "current release; no activation was performed"
        )


def _resolve_target(config: PluginConfig) -> ProductTarget:
    config.runtime_root.mkdir(parents=True, exist_ok=True)
    transaction_root = Path(
        tempfile.mkdtemp(
            prefix=".product-update-",
            dir=config.runtime_root,
        )
    )
    try:
        release = stage_coherent_release(
            config,
            plugin_root=config.plugin_root,
            destination=transaction_root / "t3",
        )
        return ProductTarget(
            version=release.version,
            tag=release.tag,
            source_commit=release.source_commit,
            staged_binary=transaction_root / "t3",
            binary_sha256=release.binary_sha256,
        )
    except Exception:
        shutil.rmtree(transaction_root, ignore_errors=True)
        raise


def _adopt_current_release_without_host(
    config: PluginConfig,
) -> dict[str, object]:
    if (
        (config.runtime_root / ".product-update-snapshot").exists()
        or _transaction_path(config).exists()
    ):
        raise UpdateError(
            "Install found incomplete coherent Update recovery artifacts; the "
            "current release was not adopted"
        )
    source_commit = _clean_checkout_commit(config, operation="Install")
    target: ProductTarget | None = None
    try:
        target = _resolve_target(config)
        if target.source_commit != source_commit:
            raise UpdateError(
                "Install without the Hermes managed handoff can only adopt the "
                "newest compatible coherent release when its source tag already "
                "matches the current checkout"
            )
        _assert_checkout_unchanged(config, source_commit=source_commit)
        if not config.binary_path.is_file():
            raise UpdateError(
                "Install without the Hermes managed handoff cannot find a "
                "retained runtime matching the current release"
            )
        binary_sha256 = service._binary_sha256(config.binary_path)
        if binary_sha256 != target.binary_sha256:
            raise UpdateError(
                "Install without the Hermes managed handoff found a retained "
                "runtime checksum that does not match the current release"
            )
        binary_version = service.binary_version(config.binary_path)
        if binary_version != target.version:
            raise UpdateError(
                "Install without the Hermes managed handoff found a retained "
                f"runtime version of {binary_version or 'unknown'}; expected "
                f"{target.version}"
            )
        _assert_checkout_unchanged(config, source_commit=source_commit)
        adoption_snapshot = _snapshot_adoption(config)
        try:
            activation = service._activate_staged_product_locked(
                config,
                staged_binary=config.binary_path,
                product_version=target.version,
                source_commit=source_commit,
                binary_sha256=target.binary_sha256,
            )
            service_pid = activation.get("service_pid")
            if (
                activation.get("ok") is not True
                or type(service_pid) is not int
                or service_pid <= 0
                or activation.get("http_healthy") is not True
            ):
                raise UpdateError(
                    "current-release activation did not prove runtime, service, "
                    "and HTTP health"
                )
        except Exception as error:
            rollback = _rollback_adoption(config, adoption_snapshot)
            outcome = (
                "adoption rollback succeeded"
                if rollback["ok"]
                else "adoption rollback failed"
            )
            details = rollback.get("failures") or []
            suffix = f": {'; '.join(map(str, details))}" if details else ""
            raise UpdateError(f"{error}; {outcome}{suffix}") from error
        return {
            "ok": True,
            "action": "installed",
            "version": target.version,
            "source_commit": source_commit,
            "service_pid": service_pid,
        }
    finally:
        if target is not None:
            shutil.rmtree(target.staged_binary.parent, ignore_errors=True)


def _snapshot_adoption(config: PluginConfig) -> AdoptionSnapshot:
    service_installed = (config.service_dir / "run").is_file()
    watchdog_installed = (config.watchdog_service_dir / "run").is_file()
    if service_installed != watchdog_installed:
        raise UpdateError(
            "Install found inconsistent T3 and watchdog service slots; the "
            "current release was not adopted"
        )
    return AdoptionSnapshot(
        state_backup=(
            config.service_state_path.read_bytes()
            if config.service_state_path.is_file()
            else None
        ),
        services_installed=service_installed,
    )


def _rollback_adoption(
    config: PluginConfig,
    snapshot: AdoptionSnapshot,
) -> dict[str, object]:
    failures: list[str] = []
    try:
        service._restore_runtime_after_product_rollback(
            config,
            installed_intent=snapshot.services_installed,
        )
    except Exception as error:
        failures.append(f"runtime/service: {_redact_error(error)}")
    try:
        _restore_state(config, snapshot.state_backup)
    except Exception as error:
        failures.append(f"state: {_redact_error(error)}")
    return {"ok": not failures, "failures": failures}


def _snapshot_product(
    config: PluginConfig,
    source_commit: str,
) -> ProductSnapshot:
    transaction_root = config.runtime_root / ".product-update-snapshot"
    if transaction_root.exists():
        raise UpdateError(
            f"an incomplete product update snapshot exists at {transaction_root}"
        )
    transaction_root.mkdir(parents=True)
    binary_backup: Path | None = None
    if config.binary_path.is_file():
        binary_backup = transaction_root / "t3"
        shutil.copyfile(config.binary_path, binary_backup)
        os.chmod(binary_backup, 0o755)
    state_backup = (
        config.service_state_path.read_bytes()
        if config.service_state_path.is_file()
        else None
    )
    if state_backup is not None:
        prior_state = json.loads(state_backup)
        if (
            isinstance(prior_state, dict)
            and prior_state.get("desired_state") == "installed"
        ):
            expected_digest = prior_state.get("binary_sha256")
            if (
                binary_backup is None
                or not isinstance(expected_digest, str)
                or service._binary_sha256(binary_backup) != expected_digest
            ):
                raise UpdateError(
                    "the prior installed runtime changed before it could be "
                    "snapshotted safely"
                )
    symbolic_ref = _command(
        ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
        cwd=config.plugin_root,
        timeout=15,
        check=False,
    )
    return ProductSnapshot(
        source_commit=source_commit,
        binary_backup=binary_backup,
        state_backup=state_backup,
        source_ref=(
            symbolic_ref.stdout.strip()
            if symbolic_ref.returncode == 0
            else None
        ),
    )


def _advance_source(config: PluginConfig, target: ProductTarget) -> None:
    if _git_output(
        config,
        ["status", "--porcelain", "--untracked-files=all"],
    ):
        raise UpdateError(
            "T3 Code plugin checkout changed while Update was staging; "
            "no source cutover was performed"
        )
    _command(
        ["git", "checkout", "--detach", target.source_commit],
        cwd=config.plugin_root,
        timeout=60,
    )
    _clear_plugin_bytecode(config.plugin_root)


def _clear_plugin_bytecode(plugin_root: Path) -> None:
    for cache_dir in plugin_root.rglob("__pycache__"):
        if cache_dir.is_dir():
            shutil.rmtree(cache_dir, ignore_errors=True)


def _transaction_path(config: PluginConfig) -> Path:
    return config.runtime_root / ".product-update-transaction.json"


def _run_fresh_activation(
    config: PluginConfig,
    target: ProductTarget,
    snapshot: ProductSnapshot,
) -> dict[str, object]:
    transaction_path = _transaction_path(config)
    payload = {
        "target": target.to_dict(),
        "snapshot": snapshot.to_dict(),
    }
    transaction_path.write_text(
        json.dumps(payload, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    worker = config.plugin_root / "integrations" / "hermes_plugin" / "update_process.py"
    result = _command(
        [
            sys.executable,
            "-I",
            str(worker),
            str(config.plugin_root),
            "activate",
            str(transaction_path),
        ],
        cwd=config.runtime_root,
        timeout=180,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise UpdateError(detail or "fresh update activation failed")
    try:
        response = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise UpdateError("fresh update activation returned invalid JSON") from error
    if not isinstance(response, dict) or not response.get("ok"):
        raise UpdateError("fresh update activation did not report success")
    return response


def _restore_state(config: PluginConfig, state_backup: bytes | None) -> None:
    if state_backup is None:
        config.service_state_path.unlink(missing_ok=True)
        return
    restored = json.loads(state_backup)
    if not isinstance(restored, dict):
        raise UpdateError("prior desired state is invalid")
    service._write_service_state(config, restored)


def _rollback_product(
    config: PluginConfig,
    snapshot: ProductSnapshot,
) -> dict[str, object]:
    failures: list[str] = []
    installed_intent = False
    if snapshot.state_backup is not None:
        try:
            prior_state = json.loads(snapshot.state_backup)
            installed_intent = (
                isinstance(prior_state, dict)
                and prior_state.get("desired_state") == "installed"
            )
        except (UnicodeDecodeError, json.JSONDecodeError):
            failures.append("state: prior desired state is invalid")
    try:
        if _git_output(
            config,
            ["status", "--porcelain", "--untracked-files=all"],
        ):
            raise UpdateError(
                "plugin checkout changed during activation; refusing to "
                "overwrite concurrent Git work during rollback"
            )
        checkout_target = snapshot.source_commit
        checkout_args = ["git", "checkout", "--detach", checkout_target]
        if snapshot.source_ref is not None:
            current_ref_commit = _git_output(
                config,
                ["rev-parse", snapshot.source_ref],
            )
            if current_ref_commit != snapshot.source_commit:
                raise UpdateError(
                    "the prior source branch moved during Update; refusing to "
                    "overwrite concurrent Git work"
                )
            checkout_args = ["git", "checkout", snapshot.source_ref]
        _command(
            checkout_args,
            cwd=config.plugin_root,
            timeout=60,
        )
        _clear_plugin_bytecode(config.plugin_root)
    except Exception as error:
        failures.append(f"source: {error}")
    try:
        config.binary_path.parent.mkdir(parents=True, exist_ok=True)
        if snapshot.binary_backup is None:
            config.binary_path.unlink(missing_ok=True)
        else:
            staged = config.binary_path.with_name(
                f".{config.binary_path.name}.rollback"
            )
            shutil.copyfile(snapshot.binary_backup, staged)
            os.chmod(staged, 0o755)
            os.replace(staged, config.binary_path)
        service._restore_runtime_after_product_rollback(
            config,
            installed_intent=installed_intent,
        )
    except Exception as error:
        failures.append(f"runtime/service: {error}")
    try:
        _restore_state(config, snapshot.state_backup)
    except Exception as error:
        failures.append(f"state: {error}")
    return {"ok": not failures, "failures": failures}


def _snapshot_product_version(snapshot: ProductSnapshot) -> str | None:
    if snapshot.state_backup is None:
        return None
    try:
        state = json.loads(snapshot.state_backup)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    version = state.get("product_version") if isinstance(state, dict) else None
    return version if isinstance(version, str) else None


def _rollback_host(
    config: PluginConfig,
    host: HostUpdateContract,
    snapshot: ProductSnapshot,
) -> dict[str, object]:
    prior_version = _snapshot_product_version(snapshot)
    try:
        result = host.rollback(
            plugin_name="t3code",
            plugin_root=config.plugin_root,
            source_commit=snapshot.source_commit,
            product_version=prior_version,
        )
    except Exception as error:
        return {
            "ok": False,
            "failures": [f"host: {_redact_error(error)}"],
        }
    if (
        not result.get("reloaded")
        or result.get("loaded_source_commit") != snapshot.source_commit
        or result.get("loaded_product_version") != prior_version
    ):
        return {
            "ok": False,
            "failures": [
                "host: Hermes did not prove the prior backend was remounted"
            ],
        }
    return {"ok": True, "failures": []}


def _perform_locked(
    config: PluginConfig,
    operation: str,
) -> dict[str, object]:
    try:
        host = _load_host_contract()
    except UpdateError:
        if operation != "install":
            raise
        return _adopt_current_release_without_host(config)
    source_commit = _preflight_checkout(config, host, operation)
    target: ProductTarget | None = None
    snapshot: ProductSnapshot | None = None
    source_advanced = False
    cleanup_artifacts = True
    try:
        target = _resolve_target(config)
        snapshot = _snapshot_product(config, source_commit)
        _advance_source(config, target)
        source_advanced = True
        activation = _run_fresh_activation(config, target, snapshot)
        service_pid = activation.get("service_pid")
        if (
            activation.get("ok") is not True
            or type(service_pid) is not int
            or service_pid <= 0
            or activation.get("http_healthy") is not True
            or activation.get("host_reloaded") is not True
        ):
            raise UpdateError(
                "activation did not prove source, runtime, service, HTTP, and "
                "Hermes backend health"
            )
        result = {
            "ok": True,
            "action": "installed" if operation == "install" else "updated",
            "version": target.version,
            "source_commit": target.source_commit,
            "service_pid": activation["service_pid"],
        }
        if isinstance(activation.get("status"), dict):
            result["status"] = activation["status"]
        return result
    except Exception as error:
        if snapshot is None or not source_advanced:
            raise
        rollback = _rollback_product(config, snapshot)
        host_rollback = _rollback_host(config, host, snapshot)
        rollback_failures = [
            *list(rollback.get("failures") or []),
            *list(host_rollback.get("failures") or []),
        ]
        rollback = {
            "ok": bool(rollback["ok"]) and bool(host_rollback["ok"]),
            "failures": rollback_failures,
        }
        cleanup_artifacts = bool(rollback["ok"])
        outcome = "rollback succeeded" if rollback["ok"] else "rollback failed"
        details = rollback.get("failures") or []
        suffix = f": {'; '.join(map(str, details))}" if details else ""
        raise UpdateError(f"{error}; {outcome}{suffix}") from error
    finally:
        if cleanup_artifacts:
            _transaction_path(config).unlink(missing_ok=True)
            shutil.rmtree(
                config.runtime_root / ".product-update-snapshot",
                ignore_errors=True,
            )
            if target is not None:
                shutil.rmtree(target.staged_binary.parent, ignore_errors=True)


def _run_in_process(
    config: PluginConfig,
    operation: str,
) -> dict[str, object]:
    with service.lifecycle_lock(config):
        return _perform_locked(config, operation)


def _run_entrypoint(config: PluginConfig, operation: str) -> dict[str, object]:
    config.runtime_root.mkdir(parents=True, exist_ok=True)
    worker = Path(__file__).with_name("update_process.py")
    result = _command(
        [
            sys.executable,
            "-I",
            str(worker),
            str(config.plugin_root),
            operation,
        ],
        cwd=config.runtime_root,
        timeout=300,
        check=False,
    )
    if result.returncode != 0:
        raise UpdateError((result.stderr or result.stdout).strip() or "Update failed")
    try:
        response = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise UpdateError("Update process returned invalid JSON") from error
    if not isinstance(response, dict) or not response.get("ok"):
        raise UpdateError("Update process did not report coherent success")
    return response


def install(config: PluginConfig) -> dict[str, object]:
    return _run_entrypoint(config, "install")


def update(config: PluginConfig) -> dict[str, object]:
    return _run_entrypoint(config, "update")


def _activate_transaction(
    config: PluginConfig,
    transaction_path: Path,
) -> dict[str, object]:
    payload = json.loads(transaction_path.read_text(encoding="utf-8"))
    target = ProductTarget.from_dict(payload["target"])
    current_commit = _git_output(config, ["rev-parse", "HEAD"])
    if current_commit != target.source_commit:
        raise UpdateError("fresh activation is not running from target plugin source")
    activation = service._activate_staged_product_locked(
        config,
        staged_binary=target.staged_binary,
        product_version=target.version,
        source_commit=target.source_commit,
        binary_sha256=target.binary_sha256,
    )
    host = _load_host_contract()
    handoff = host.complete(
        plugin_name="t3code",
        plugin_root=config.plugin_root,
        source_commit=target.source_commit,
        product_version=target.version,
    )
    if (
        not handoff.get("reloaded")
        or handoff.get("loaded_source_commit") != target.source_commit
        or handoff.get("loaded_product_version") != target.version
    ):
        raise UpdateError(
            "Hermes did not prove the target plugin backend and product "
            "version were loaded"
        )
    return {
        "ok": True,
        "service_pid": activation["service_pid"],
        "http_healthy": activation["http_healthy"],
        "host_reloaded": True,
        "status": service.status(config).to_dict(),
    }


def main(argv: list[str]) -> int:
    if len(argv) not in {2, 3}:
        print("invalid coherent update invocation", file=sys.stderr)
        return 2
    plugin_root = Path(argv[0]).resolve()
    operation = argv[1]
    try:
        config = load_config(plugin_root=plugin_root)
        if operation == "activate" and len(argv) == 3:
            result = _activate_transaction(config, Path(argv[2]))
        elif operation in {"install", "update"} and len(argv) == 2:
            result = _run_in_process(config, operation)
        else:
            raise UpdateError("invalid coherent update operation")
    except Exception as error:
        print(_redact_error(error), file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0

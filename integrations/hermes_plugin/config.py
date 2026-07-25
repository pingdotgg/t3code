"""Configuration and path resolution for the Hermes plugin."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_REPOSITORY = "totalolage/t3code"
DEFAULT_PORT = 3773
DEFAULT_HOST = "0.0.0.0"
DEFAULT_WATCH_INTERVAL_SECONDS = 15 * 60
DEFAULT_WATCH_MISSES = 2


def _positive_int(name: str, default: int, *, maximum: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer") from error
    if value < 1 or value > maximum:
        raise ValueError(f"{name} must be between 1 and {maximum}")
    return value


def _port(name: str, default: int) -> int:
    return _positive_int(name, default, maximum=65535)


def _hermes_home() -> Path:
    configured = os.environ.get("HERMES_HOME", "").strip()
    return Path(configured).expanduser() if configured else Path.home() / ".hermes"


@dataclass(frozen=True)
class PluginConfig:
    plugin_root: Path
    hermes_home: Path
    runtime_root: Path
    binary_path: Path
    data_dir: Path
    service_dir: Path
    watchdog_service_dir: Path
    repository: str
    host: str
    port: int
    public_url: str | None
    watch_interval_seconds: int
    watch_misses: int

    @property
    def scan_dir(self) -> Path:
        return self.service_dir.parent


def load_config(*, plugin_root: Path | None = None) -> PluginConfig:
    root = (
        plugin_root.resolve()
        if plugin_root is not None
        else Path(__file__).resolve().parents[2]
    )
    hermes_home = _hermes_home().resolve()
    runtime_root = hermes_home / "t3code"
    service_dir = Path(
        os.environ.get("T3CODE_HERMES_SERVICE_DIR", "/run/service/t3code")
    ).resolve()
    watchdog_service_dir = Path(
        os.environ.get(
            "T3CODE_HERMES_WATCHDOG_SERVICE_DIR",
            str(service_dir.with_name(f"{service_dir.name}-plugin-watchdog")),
        )
    ).resolve()
    if service_dir.parent != watchdog_service_dir.parent:
        raise ValueError("T3 Code and watchdog services must share one s6 scan directory")

    repository = os.environ.get(
        "T3CODE_HERMES_REPOSITORY", DEFAULT_REPOSITORY
    ).strip()
    if repository.count("/") != 1 or any(
        segment in {"", ".", ".."} for segment in repository.split("/")
    ):
        raise ValueError("T3CODE_HERMES_REPOSITORY must be in owner/repository form")

    public_url = os.environ.get("T3CODE_HERMES_PUBLIC_URL", "").strip() or None
    return PluginConfig(
        plugin_root=root,
        hermes_home=hermes_home,
        runtime_root=runtime_root,
        binary_path=runtime_root / "bin" / "t3",
        data_dir=runtime_root / "data",
        service_dir=service_dir,
        watchdog_service_dir=watchdog_service_dir,
        repository=repository,
        host=os.environ.get("T3CODE_HERMES_HOST", DEFAULT_HOST).strip()
        or DEFAULT_HOST,
        port=_port("T3CODE_HERMES_PORT", DEFAULT_PORT),
        public_url=public_url,
        watch_interval_seconds=_positive_int(
            "T3CODE_HERMES_WATCH_INTERVAL_SECONDS",
            DEFAULT_WATCH_INTERVAL_SECONDS,
            maximum=7 * 24 * 60 * 60,
        ),
        watch_misses=_positive_int(
            "T3CODE_HERMES_WATCH_MISSES",
            DEFAULT_WATCH_MISSES,
            maximum=100,
        ),
    )

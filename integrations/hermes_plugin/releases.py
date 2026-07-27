"""Download and verify standalone T3 Code release binaries."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import tempfile
import urllib.request
from urllib.parse import urlsplit
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import PluginConfig

GITHUB_API = "https://api.github.com"
MAX_RELEASE_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_BINARY_BYTES = 256 * 1024 * 1024
SHA256_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")


class ReleaseError(RuntimeError):
    """Raised when a compatible, verified T3 Code release cannot be installed."""


@dataclass(frozen=True)
class ReleaseAsset:
    version: str
    tag: str
    binary_url: str
    checksum_url: str


@dataclass(frozen=True)
class CoherentRelease:
    version: str
    tag: str
    source_commit: str
    binary_sha256: str


def _target_suffix(machine: str | None = None) -> str:
    current = (machine or platform.machine()).lower()
    if current in {"x86_64", "amd64"}:
        return "linux-x64"
    raise ReleaseError(
        f"unsupported Linux architecture: {current or 'unknown'}; "
        "the T3 Code release workflow currently publishes linux-x64 only"
    )


def _request_json(url: str) -> Any:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "t3code-hermes-plugin",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        payload = response.read(MAX_RELEASE_RESPONSE_BYTES + 1)
    if len(payload) > MAX_RELEASE_RESPONSE_BYTES:
        raise ReleaseError("GitHub release response exceeded the size limit")
    return json.loads(payload)


def _release_assets(
    config: PluginConfig,
    *,
    machine: str | None = None,
) -> list[ReleaseAsset]:
    suffix = _target_suffix(machine)
    releases = _request_json(
        f"{GITHUB_API}/repos/{config.repository}/releases?per_page=30"
    )
    if not isinstance(releases, list):
        raise ReleaseError("GitHub returned an invalid release list")

    resolved: list[ReleaseAsset] = []
    for release in releases:
        if not isinstance(release, dict) or release.get("draft"):
            continue
        tag = release.get("tag_name")
        assets = release.get("assets")
        if not isinstance(tag, str) or not isinstance(assets, list):
            continue
        by_name = {
            asset.get("name"): asset.get("browser_download_url")
            for asset in assets
            if isinstance(asset, dict)
            and isinstance(asset.get("name"), str)
            and isinstance(asset.get("browser_download_url"), str)
        }
        binary_names = [
            name
            for name in by_name
            if isinstance(name, str)
            and name.endswith(f"-{suffix}")
            and not name.endswith(".sha256")
        ]
        if len(binary_names) != 1:
            continue
        binary_name = binary_names[0]
        checksum_name = f"{binary_name}.sha256"
        checksum_url = by_name.get(checksum_name)
        if not isinstance(checksum_url, str):
            continue
        resolved.append(
            ReleaseAsset(
                version=tag.removeprefix("v"),
                tag=tag,
                binary_url=by_name[binary_name],
                checksum_url=checksum_url,
            )
        )
    return resolved


def resolve_release(config: PluginConfig, *, machine: str | None = None) -> ReleaseAsset:
    releases = _release_assets(config, machine=machine)
    if releases:
        return releases[0]

    raise ReleaseError(
        f"no release for {_target_suffix(machine)} with an adjacent .sha256 "
        "asset was found"
    )


def _download(url: str, destination: Path, *, maximum_bytes: int) -> None:
    request = urllib.request.Request(
        url, headers={"User-Agent": "t3code-hermes-plugin"}
    )
    written = 0
    with urllib.request.urlopen(request, timeout=60) as response:
        with destination.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                written += len(chunk)
                if written > maximum_bytes:
                    raise ReleaseError("release asset exceeded the size limit")
                output.write(chunk)


def _read_expected_checksum(path: Path) -> str:
    first = path.read_text(encoding="utf-8").strip().split()
    if not first or not SHA256_PATTERN.fullmatch(first[0]):
        raise ReleaseError("release checksum file is malformed")
    return first[0].lower()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def binary_version(binary_path: Path) -> str | None:
    if not binary_path.is_file():
        return None
    try:
        result = subprocess.run(
            [str(binary_path), "--version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    output = (result.stdout or result.stderr).strip()
    match = re.search(
        r"(?<![0-9A-Za-z])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)"
        r"(?![0-9A-Za-z.-])",
        output,
    )
    return match.group(1) if match else output or None


def _stage_verified_binary(
    release: ReleaseAsset,
    destination: Path,
) -> str:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=".t3code-download-", dir=destination.parent
    ) as temporary:
        temp_dir = Path(temporary)
        binary = temp_dir / "t3"
        checksum = temp_dir / "t3.sha256"
        _download(release.checksum_url, checksum, maximum_bytes=4096)
        _download(release.binary_url, binary, maximum_bytes=MAX_BINARY_BYTES)
        expected = _read_expected_checksum(checksum)
        actual = _sha256(binary)
        if actual != expected:
            raise ReleaseError(
                f"release checksum mismatch: expected {expected}, received {actual}"
            )
        binary.chmod(0o755)
        reported = binary_version(binary)
        if reported is None or reported != release.version:
            raise ReleaseError(
                f"downloaded binary reported {reported or 'no version'}; "
                f"expected {release.version}"
            )
        staged = destination.with_name(f".{destination.name}.new")
        shutil.copyfile(binary, staged)
        staged.chmod(0o755)
        os.replace(staged, destination)
    return actual


def install_release(config: PluginConfig) -> ReleaseAsset:
    release = resolve_release(config)
    _stage_verified_binary(release, config.binary_path)
    return release


def _git(
    plugin_root: Path,
    args: list[str],
    *,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=plugin_root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ReleaseError(f"could not inspect plugin source: {error}") from error
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise ReleaseError(detail or "git source validation failed")
    return result


def _coherent_source_commit(
    config: PluginConfig,
    plugin_root: Path,
    release: ReleaseAsset,
) -> str:
    if not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z._+-]*", release.tag):
        raise ReleaseError("release tag is unsafe for source resolution")
    remote = _git(plugin_root, ["remote", "get-url", "origin"]).stdout.strip()
    scp_match = re.fullmatch(
        r"(?:[^@/\s]+@)?github\.com:([^/\s]+/[^/\s]+)",
        remote,
        flags=re.IGNORECASE,
    )
    if scp_match:
        remote_repository = scp_match.group(1)
    else:
        parsed = urlsplit(remote)
        if (
            parsed.scheme not in {"https", "ssh", "git"}
            or (parsed.hostname or "").lower() != "github.com"
            or parsed.query
            or parsed.fragment
        ):
            remote_repository = ""
        else:
            remote_repository = parsed.path.lstrip("/")
    remote_repository = remote_repository.removesuffix(".git")
    if remote_repository.lower() != config.repository.lower():
        raise ReleaseError(
            "plugin checkout origin does not match the configured T3 repository"
        )
    local_ref = f"refs/t3code-product-tags/{release.tag}"
    _git(
        plugin_root,
        [
            "fetch",
            "--quiet",
            "--no-tags",
            "origin",
            f"refs/tags/{release.tag}:{local_ref}",
        ],
    )
    commit = _git(
        plugin_root,
        ["rev-parse", f"{local_ref}^{{commit}}"],
    ).stdout.strip()
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ReleaseError("release tag did not resolve to a source commit")
    manifest_path = "integrations/hermes_plugin/product-release.json"
    raw_manifest = _git(
        plugin_root,
        ["show", f"{commit}:{manifest_path}"],
    ).stdout
    try:
        manifest = json.loads(raw_manifest)
    except json.JSONDecodeError as error:
        raise ReleaseError("coherent release manifest is malformed") from error
    if manifest != {
        "schema_version": 1,
        "product": "t3code-hermes",
        "version_identity": "release-tag",
    }:
        raise ReleaseError("release does not declare the Hermes product contract")
    return commit


def stage_coherent_release(
    config: PluginConfig,
    *,
    plugin_root: Path,
    destination: Path,
    machine: str | None = None,
) -> CoherentRelease:
    failures: list[str] = []
    for release in _release_assets(config, machine=machine):
        try:
            source_commit = _coherent_source_commit(config, plugin_root, release)
            binary_sha256 = _stage_verified_binary(release, destination)
            return CoherentRelease(
                version=release.version,
                tag=release.tag,
                source_commit=source_commit,
                binary_sha256=binary_sha256,
            )
        except ReleaseError as error:
            failures.append(f"{release.tag}: {error}")
    suffix = f": {'; '.join(failures)}" if failures else ""
    raise ReleaseError(
        "no release declares a compatible T3/Hermes source-and-runtime unit"
        + suffix
    )

from __future__ import annotations

import hashlib
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

from integrations.hermes_plugin.config import load_config
from integrations.hermes_plugin.releases import (
    CoherentRelease,
    ReleaseAsset,
    ReleaseError,
    install_release,
    resolve_release,
    stage_coherent_release,
)
from integrations.hermes_plugin import releases as releases_module


class ReleaseResolutionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.config = load_config(plugin_root=Path(self.temporary.name))

    def test_selects_release_with_binary_and_adjacent_checksum(self) -> None:
        releases = [
            {
                "tag_name": "v1.2.3",
                "draft": False,
                "assets": [
                    {
                        "name": "t3-1.2.3-linux-x64",
                        "browser_download_url": "https://example.test/t3",
                    },
                    {
                        "name": "t3-1.2.3-linux-x64.sha256",
                        "browser_download_url": "https://example.test/t3.sha256",
                    },
                ],
            }
        ]
        with patch(
            "integrations.hermes_plugin.releases._request_json",
            return_value=releases,
        ):
            release = resolve_release(self.config, machine="x86_64")

        self.assertEqual(release.version, "1.2.3")
        self.assertEqual(release.binary_url, "https://example.test/t3")
        self.assertEqual(release.checksum_url, "https://example.test/t3.sha256")

    def test_requires_checksum_asset(self) -> None:
        releases = [
            {
                "tag_name": "v1.2.3",
                "assets": [
                    {
                        "name": "t3-1.2.3-linux-x64",
                        "browser_download_url": "https://example.test/t3",
                    }
                ],
            }
        ]
        with patch(
            "integrations.hermes_plugin.releases._request_json",
            return_value=releases,
        ):
            with self.assertRaisesRegex(ReleaseError, "adjacent .sha256"):
                resolve_release(self.config, machine="x86_64")

    def test_rejects_unsupported_architecture(self) -> None:
        for machine in ("arm64", "riscv64"):
            with self.subTest(machine=machine):
                with self.assertRaisesRegex(
                    ReleaseError, "currently publishes linux-x64 only"
                ):
                    resolve_release(self.config, machine=machine)

    def test_installs_only_a_checksum_verified_binary_with_matching_version(
        self,
    ) -> None:
        root = Path(self.temporary.name)
        config = replace(
            self.config,
            runtime_root=root / "runtime",
            binary_path=root / "runtime" / "bin" / "t3",
            data_dir=root / "runtime" / "data",
        )
        binary = b"#!/bin/sh\necho 't3 v1.2.3-f8y.20260724.29'\n"
        checksum = hashlib.sha256(binary).hexdigest().encode()
        release = ReleaseAsset(
            version="1.2.3-f8y.20260724.29",
            tag="v1.2.3-f8y.20260724.29",
            binary_url="https://example.test/t3",
            checksum_url="https://example.test/t3.sha256",
        )

        def download(url: str, destination: Path, *, maximum_bytes: int) -> None:
            del maximum_bytes
            destination.write_bytes(checksum if url.endswith(".sha256") else binary)

        with (
            patch(
                "integrations.hermes_plugin.releases.resolve_release",
                return_value=release,
            ),
            patch(
                "integrations.hermes_plugin.releases._download",
                side_effect=download,
            ),
        ):
            installed = install_release(config)

        self.assertEqual(installed, release)
        self.assertEqual(config.binary_path.read_bytes(), binary)
        self.assertTrue(config.binary_path.stat().st_mode & 0o100)

    def test_selects_newest_release_with_matching_source_contract(self) -> None:
        newest = ReleaseAsset(
            version="1.2.4",
            tag="v1.2.4",
            binary_url="https://example.test/t3-1.2.4",
            checksum_url="https://example.test/t3-1.2.4.sha256",
        )
        compatible = ReleaseAsset(
            version="1.2.3",
            tag="v1.2.3",
            binary_url="https://example.test/t3-1.2.3",
            checksum_url="https://example.test/t3-1.2.3.sha256",
        )
        destination = Path(self.temporary.name) / "staged" / "t3"

        def source_commit(_config, _plugin_root, release):
            if release is newest:
                raise ReleaseError("missing coherent manifest")
            return "a" * 40

        with (
            patch(
                "integrations.hermes_plugin.releases._release_assets",
                return_value=[newest, compatible],
            ),
            patch(
                "integrations.hermes_plugin.releases._coherent_source_commit",
                side_effect=source_commit,
            ),
            patch(
                "integrations.hermes_plugin.releases._stage_verified_binary",
                return_value="b" * 64,
            ) as stage_binary,
        ):
            release = stage_coherent_release(
                self.config,
                plugin_root=Path(self.temporary.name),
                destination=destination,
            )

        self.assertEqual(
            release,
            CoherentRelease(
                version="1.2.3",
                tag="v1.2.3",
                source_commit="a" * 40,
                binary_sha256="b" * 64,
            ),
        )
        stage_binary.assert_called_once_with(compatible, destination)

    def test_rejects_suffix_matching_non_github_source_origin(self) -> None:
        release = ReleaseAsset(
            version="1.2.3",
            tag="v1.2.3",
            binary_url="https://example.test/t3",
            checksum_url="https://example.test/t3.sha256",
        )
        with (
            patch(
                "integrations.hermes_plugin.releases._git",
                return_value=CompletedProcess(
                    args=[],
                    returncode=0,
                    stdout="https://evil.example/x/totalolage/t3code.git\n",
                    stderr="",
                ),
            ),
            self.assertRaisesRegex(
                ReleaseError,
                "origin does not match",
            ),
        ):
            releases_module._coherent_source_commit(
                self.config,
                Path(self.temporary.name),
                release,
            )

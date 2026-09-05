"""Check source aliases and recovery from interrupted packet publication."""

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import prepare_proof_media as MEDIA


class PublicationTests(unittest.TestCase):
    def test_rejects_symlink_hardlink_and_timeline_output_aliases(self) -> None:
        with tempfile.TemporaryDirectory(prefix="proof-path-safety-") as temporary:
            root = Path(temporary)
            source = root / "raw.mp4"
            timeline = root / "timeline.json"
            source.write_bytes(b"raw")
            timeline.write_bytes(b"timeline")
            symlink = root / "clean.mp4"
            symlink.symlink_to(source)
            hardlink = root / "annotated.mp4"
            os.link(source, hardlink)
            with self.assertRaises(MEDIA.ProofMediaError):
                MEDIA.validate_packet_paths((source, timeline), (symlink,))
            with self.assertRaises(MEDIA.ProofMediaError):
                MEDIA.validate_packet_paths((source, timeline), (hardlink,))
            with self.assertRaises(MEDIA.ProofMediaError):
                MEDIA.validate_packet_paths((source, timeline), (timeline,))
    def test_packet_publish_rolls_back_if_receipt_install_fails(self) -> None:
        with tempfile.TemporaryDirectory(prefix="proof-publish-rollback-") as temporary:
            root = Path(temporary)
            stage = root / "stage"
            final = root / "final"
            stage.mkdir()
            final.mkdir()
            destinations = [final / "clean", final / "annotated", final / "receipt"]
            staged = [stage / path.name for path in destinations]
            for path, value in zip(destinations, (b"old-clean", b"old-annotated", b"old-receipt")):
                path.write_bytes(value)
            for path, value in zip(staged, (b"new-clean", b"new-annotated", b"new-receipt")):
                path.write_bytes(value)
            original_replace = Path.replace

            def fail_receipt(source: Path, target: Path) -> Path:
                if source == staged[-1] and target == destinations[-1]:
                    raise OSError("injected receipt failure")
                return original_replace(source, target)

            with mock.patch.object(Path, "replace", fail_receipt):
                with self.assertRaisesRegex(OSError, "injected receipt failure"):
                    MEDIA.publish_packet(tuple(zip(staged, destinations)), destinations[-1])

            self.assertEqual(
                [path.read_bytes() for path in destinations],
                [b"old-clean", b"old-annotated", b"old-receipt"],
            )
            self.assertEqual(list(final.glob(".prepare-proof-recovery-*")), [])
    def test_packet_publish_preserves_recovery_evidence_and_restores_other_files(self) -> None:
        with tempfile.TemporaryDirectory(prefix="proof-publish-recovery-") as temporary:
            root = Path(temporary)
            stage = root / "stage"
            final = root / "final"
            stage.mkdir()
            final.mkdir()
            destinations = [final / "clean", final / "annotated", final / "receipt"]
            staged = [stage / path.name for path in destinations]
            for path, value in zip(destinations, (b"old-clean", b"old-annotated", b"old-receipt")):
                path.write_bytes(value)
            for path, value in zip(staged, (b"new-clean", b"new-annotated", b"new-receipt")):
                path.write_bytes(value)
            original_replace = Path.replace

            def fail_receipt_and_one_restore(source: Path, target: Path) -> Path:
                if source == staged[-1] and target == destinations[-1]:
                    raise OSError("injected receipt failure")
                if (
                    source.name == "1-annotated"
                    and source.parent.name.startswith(".prepare-proof-recovery-")
                    and target == destinations[1]
                ):
                    raise OSError("injected restore failure")
                return original_replace(source, target)

            with mock.patch.object(Path, "replace", fail_receipt_and_one_restore):
                with self.assertRaisesRegex(MEDIA.ProofMediaError, "rollback was incomplete"):
                    MEDIA.publish_packet(tuple(zip(staged, destinations)), destinations[-1])

            self.assertEqual(destinations[0].read_bytes(), b"old-clean")
            self.assertFalse(destinations[1].exists())
            self.assertEqual(destinations[2].read_bytes(), b"old-receipt")
            recovery_roots = list(final.glob(".prepare-proof-recovery-*"))
            self.assertEqual(len(recovery_roots), 1)
            self.assertEqual((recovery_roots[0] / "1-annotated").read_bytes(), b"old-annotated")
            evidence = json.loads((recovery_roots[0] / "recovery.json").read_text(encoding="utf-8"))
            self.assertIn("injected receipt failure", evidence["publish_error"])
            self.assertTrue(any("injected restore failure" in item for item in evidence["recovery_errors"]))

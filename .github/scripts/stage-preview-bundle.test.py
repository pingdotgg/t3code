import importlib.util
import stat
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "stage_preview_bundle", Path(__file__).with_name("stage-preview-bundle.py")
)
staging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(staging)


class StagePreviewBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / "bundle.zip"
        self.destination = self.root / "staged"

    def bundle(self, extra=(), missing=None):
        with zipfile.ZipFile(self.archive, "w") as bundle:
            for name in sorted(staging.REQUIRED_FILES - {missing}):
                bundle.writestr(name, b"bundle data, never executed")
            for name, content in extra:
                bundle.writestr(name, content)

    def stage(self):
        staging.stage_bundle(self.archive, self.destination)

    def test_preserves_valid_bundle_layout_and_bytes(self):
        self.bundle([("server/", b""), ("server/dist/", b""),
                     ("desktop/dist-electron/chunks/helper.cjs", b"chunk")])
        self.stage()
        for name in staging.REQUIRED_FILES:
            self.assertEqual((self.destination / name).read_bytes(), b"bundle data, never executed")
        self.assertEqual((self.destination / "desktop/dist-electron/chunks/helper.cjs").read_bytes(), b"chunk")

    def test_rejects_builder_overwrite_and_unsafe_paths_before_writing(self):
        for name in [
            "desktop/node_modules/electron-builder/cli.js",
            "desktop/package.json",
            "server/dist/../../desktop/package.json",
            "../package.json",
            "/server/dist/absolute",
            "server/dist/./alias",
            "server/dist//alias",
            "server/dist/back\\slash",
            "server/dist/file:stream",
            "server/dist/BIN.MJS",
        ]:
            with self.subTest(name=name):
                self.bundle([(name, b"untrusted")])
                with self.assertRaises(ValueError):
                    self.stage()
                self.assertFalse(self.destination.exists())

    def test_rejects_links_and_special_files(self):
        for mode in [stat.S_IFLNK, stat.S_IFIFO, stat.S_IFCHR]:
            with self.subTest(mode=mode):
                entry = zipfile.ZipInfo("server/dist/link")
                entry.create_system = 3
                entry.external_attr = (mode | 0o777) << 16
                self.bundle([(entry, b"../../../desktop/node_modules")])
                with self.assertRaises(ValueError):
                    self.stage()
                self.assertFalse(self.destination.exists())

    def test_requires_entry_points(self):
        self.bundle(missing="desktop/dist-electron/main.cjs")
        with self.assertRaises(ValueError):
            self.stage()
        self.assertFalse(self.destination.exists())

    def test_bounds_archive_size_expanded_size_and_entry_count(self):
        for limit in ["MAX_ARCHIVE_BYTES", "MAX_EXPANDED_BYTES", "MAX_ENTRIES"]:
            with self.subTest(limit=limit), patch.object(staging, limit, 1):
                self.bundle()
                with self.assertRaises(ValueError):
                    self.stage()
                self.assertFalse(self.destination.exists())

    def test_refuses_existing_destination(self):
        self.bundle()
        self.destination.mkdir()
        sentinel = self.destination / "trusted"
        sentinel.write_text("untouched")
        with self.assertRaises(FileExistsError):
            self.stage()
        self.assertEqual(sentinel.read_text(), "untouched")


if __name__ == "__main__":
    unittest.main()

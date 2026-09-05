"""Exercise real PNG/GIF crops and their source/timing invariants."""

import argparse
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import detail_crop as crop


class DetailCropTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="proof-detail-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def magick(self, *args):
        return subprocess.run(["magick", *map(str, args)], check=True, capture_output=True, text=True).stdout

    def screenshot(self, name, rectangle=None, size="1000x800"):
        path = self.root / name
        command = ["-size", size, "xc:white"]
        if rectangle:
            command += ["-fill", "#2050c0", "-draw", "rectangle " + rectangle]
        self.magick(*command, path)
        return path

    def render(self, source, **overrides):
        values = dict(source=source, before=None, output_dir=self.root / "out", stem="proof",
                      region=[], reason="Show the changed control and its context", padding=0.15,
                      difference_threshold=5.0, max_width=960, overwrite=False)
        values.update(overrides)
        with contextlib.redirect_stdout(io.StringIO()):
            crop.build_detail(argparse.Namespace(**values))
        return json.loads((Path(values["output_dir"]) / "proof-detail-receipt.json").read_text())

    def test_before_after_share_context_crop_and_keep_raw_bytes(self):
        before = self.screenshot("before.png")
        after = self.screenshot("after.png", "700,600 779,639")
        original = {path: path.read_bytes() for path in (before, after)}
        receipt = self.render(after, before=before)
        self.assertEqual(receipt["method"], "detected-changes")
        self.assertEqual(receipt["crop"], dict(x=580, y=530, width=320, height=180))
        for name in ("before", "after"):
            self.assertEqual((receipt["artifacts"][name]["width"], receipt["artifacts"][name]["height"]), (320, 180))
        for path, data in original.items():
            self.assertEqual(path.read_bytes(), data)

    def test_semantic_regions_ignore_unrelated_changes_and_include_context(self):
        before = self.screenshot("before.png")
        after = self.screenshot("after.png", "0,0 999,50")
        receipt = self.render(after, before=before, region=[crop.parse_region("0.7,0.7,0.1,0.1")])
        self.assertEqual(receipt["method"], "semantic-regions")
        self.assertGreater(receipt["crop"]["y"], 400)
        self.assertGreaterEqual(receipt["crop"]["width"], 100)

    def test_detected_changes_cover_edges_and_a_fully_changed_canvas(self):
        before = self.screenshot("before.png")
        for rectangle, expected in (
            ("0,0 79,39", dict(x=0, y=0, width=320, height=180)),
            ("920,760 999,799", dict(x=680, y=620, width=320, height=180)),
            ("0,0 999,799", dict(x=0, y=0, width=1000, height=800)),
        ):
            with self.subTest(rectangle=rectangle):
                after = self.screenshot("after.png", rectangle)
                receipt = self.render(after, before=before, overwrite=True)
                self.assertEqual(receipt["crop"], expected)

    def test_cli_reports_invalid_input_without_a_traceback(self):
        command = [sys.executable, "-B", str(Path(__file__).with_name("prepare_proof_media.py")),
                   "detail", str(self.root / "missing.png"), "--reason", "Show the result",
                   "--output-dir", str(self.root / "out")]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("prepare-proof-media: Source does not exist:", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_multiple_regions_keep_trigger_and_result_at_image_edges(self):
        source = self.screenshot("source.png")
        receipt = self.render(source, region=[crop.parse_region("0,0,0.1,0.1"), crop.parse_region("0.9,0.9,0.1,0.1")], max_width=600)
        self.assertEqual(receipt["crop"], dict(x=0, y=0, width=1000, height=800))
        self.assertEqual(receipt["artifacts"]["after"]["width"], 600)

    def test_unchanged_pair_and_single_still_keep_full_context(self):
        source = self.screenshot("source.png", size="240x160")
        for before in (None, source):
            receipt = self.render(source, before=before, overwrite=True)
            self.assertEqual(receipt["method"], "full-context-no-detected-change")
            self.assertEqual(receipt["crop"], dict(x=0, y=0, width=240, height=160))
            self.assertEqual(receipt["artifacts"]["after"]["width"], 240)

    def test_gif_crop_contains_all_motion_and_preserves_timing_and_loop(self):
        frames = [self.screenshot("{}.png".format(i), rectangle) for i, rectangle in enumerate([
            None, "400,350 430,380", "50,350 80,380", "800,350 830,380",
        ])]
        source = self.root / "motion.gif"
        command = []
        delays = [7, 23, 11, 50]
        for frame, delay in zip(frames, delays):
            command += ["-delay", str(delay), frame]
        self.magick(*command, "-loop", "3", "-layers", "Optimize", source)
        raw = source.read_bytes()
        receipt = self.render(source, max_width=2000)
        box = receipt["crop"]
        self.assertLessEqual(box["x"], 50)
        self.assertGreaterEqual(box["x"] + box["width"], 831)
        self.assertLess(box["height"], 800)
        output = Path(receipt["artifacts"]["after"]["path"])
        self.assertEqual(receipt["artifacts"]["after"]["delays_centiseconds"], delays)
        self.assertEqual(crop.gif_loop(source), crop.gif_loop(output))
        self.assertEqual(source.read_bytes(), raw)
        # Compare every rendered frame to its exact source crop, including the
        # middle frame whose motion would be lost by endpoint-only sampling.
        geometry = "{width}x{height}+{x}+{y}".format(**box)
        self.magick(output, "-coalesce", self.root / "decoded-%d.png")
        self.magick(source, "-coalesce", self.root / "original-%d.png")
        for index in range(len(frames)):
            original = self.root / "original-{}.png".format(index)
            expected = self.root / "expected.png"
            actual = self.root / "decoded-{}.png".format(index)
            self.magick(original, "-crop", geometry, "+repage", expected)
            difference = self.magick(expected, actual, "-compose", "difference", "-composite", "-format", "%[fx:maxima]", "info:")
            self.assertEqual(float(difference), 0)

    def test_mismatched_canvases_fail_without_publishing(self):
        source = self.screenshot("after.png")
        before = self.screenshot("before.png", size="900x800")
        with self.assertRaisesRegex(crop.ProofMediaError, "matching oriented canvas"):
            self.render(source, before=before)
        self.assertEqual(list((self.root / "out").iterdir()), [])

    def test_output_cannot_overwrite_source_or_existing_proof(self):
        source = self.screenshot("proof-after-detail.png")
        with self.assertRaisesRegex(crop.ProofMediaError, "overwrite an input"):
            self.render(source, output_dir=self.root, overwrite=True)
        self.render(source)
        with self.assertRaisesRegex(crop.ProofMediaError, "Output exists"):
            self.render(source)

    def test_invalid_regions_fail_before_rendering(self):
        for value in ("nan,0,1,1", "0,0,0,1", "0.9,0,0.2,1", "0,0,1", "0,0,inf,1"):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                crop.parse_region(value)


if __name__ == "__main__":
    unittest.main()

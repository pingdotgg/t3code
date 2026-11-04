import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "check_runner_labels", Path(__file__).with_name("check-runner-labels.py")
)
labels = importlib.util.module_from_spec(spec)
spec.loader.exec_module(labels)


class ScanWorkflowsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.workflows = Path(self.temp.name)

    def scan(self, filename, text):
        (self.workflows / filename).write_text(text, encoding="utf-8")
        return labels.scan_workflows(self.workflows)

    def test_accepts_hosted_pools(self):
        self.assertEqual(self.scan("build.yml", """
            jobs:
              build:
                runs-on: ubuntu-24.04
              verify:
                runs-on: windows-11-arm
              lint:
                runs-on: ubuntu-24.04-arm
              mac:
                runs-on: macos-26
        """), [])

    def test_rejects_self_hosted(self):
        problems = self.scan("build.yml", "        runs-on: [self-hosted, linux]\n")
        self.assertEqual(len(problems), 1)
        self.assertIn("build.yml:1", problems[0])
        self.assertIn("self-hosted", problems[0])

    def test_rejects_private_runner_labels(self):
        for label in ("linux-runner", "windows-runner", "macos-runner", "bench-32vcpu", "blacksmith-8vcpu-ubuntu-2404"):
            with self.subTest(label=label):
                self.workflows.joinpath("build.yml").unlink(missing_ok=True)
                problems = self.scan("build.yml", f"        runs-on: {label}\n")
                self.assertEqual(len(problems), 1, problems)

    def test_rejects_matrix_values(self):
        problems = self.scan("release.yml", """
            strategy:
              matrix:
                runner: [ubuntu-24.04, bench-arm64]
            runs-on: ${{ matrix.runner }}
        """)
        self.assertEqual(len(problems), 1)
        self.assertIn("bench-arm64", problems[0])

    def test_ignores_comments_and_action_names(self):
        self.assertEqual(self.scan("notes.yml", """
            # A private runner would be self-hosted or linux-runner.
            jobs:
              emulator:
                runs-on: ubuntu-24.04
                steps:
                  - uses: reactivecircus/android-emulator-runner@v2
        """), [])

    def test_ignores_trailing_comments(self):
        self.assertEqual(self.scan("build.yml", "runs-on: ubuntu-24.04 # not self-hosted\n"), [])

    def test_strip_comment_keeps_hash_inside_quotes(self):
        self.assertEqual(
            labels.strip_comment('run: echo "a # b" # mentions linux-runner'),
            'run: echo "a # b" ',
        )


class CheckLabelsTests(unittest.TestCase):
    def test_accepts_hosted_labels(self):
        self.assertEqual(
            labels.check_labels("ubuntu-24.04", "windows-2025"), []
        )
        self.assertEqual(labels.check_labels("ubuntu-24.04-arm", ""), [])

    def test_rejects_private_labels(self):
        for label in ("self-hosted", "linux-runner", "bench-32vcpu", "macos-26-runner", "blacksmith-8vcpu-ubuntu-2404", "macos-15-large", "macos-15-xlarge"):
            with self.subTest(label=label):
                problems = labels.check_labels(label, "")
                self.assertEqual(len(problems), 1, problems)
                self.assertIn("inputs.runner", problems[0])

    def test_rejects_verify_runner_on_a_private_pool(self):
        problems = labels.check_labels("ubuntu-24.04", "linux-runner")
        self.assertEqual(len(problems), 1)
        self.assertIn("inputs.verify_runner", problems[0])

    def test_requires_runner_but_not_verify_runner(self):
        self.assertEqual(len(labels.check_labels("", "")), 1)
        self.assertIn("inputs.runner is empty", labels.check_labels("", "")[0])


class MainTests(unittest.TestCase):
    def test_scan_mode_passes_on_the_repository_workflows(self):
        self.assertEqual(labels.scan_workflows(), [])


if __name__ == "__main__":
    unittest.main()

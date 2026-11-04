"""Keep workflow runner selection on hosted pools.

This repository has no self-hosted runners. Pull requests from forks can propose
workflow changes, and a workflow that selects a private runner would put
untrusted code on hardware that holds credentials and reaches the internal
network. Every `runs-on` value must name a standard GitHub-hosted image.

Two modes:

    check-runner-labels.py
        Scan `.github/workflows/*.yml` and fail on `self-hosted` or a
        private-runner label (`linux-runner`, `windows-runner`,
        `macos-runner`, `bench-*`). Comments are ignored.

    check-runner-labels.py --runner LABEL [--verify-runner LABEL]
        Validate labels passed to a reusable workflow, where the static scan
        cannot see through `${{ inputs.runner }}`.
"""

import argparse
import os
import re
import sys
from pathlib import Path

WORKFLOWS_DIR = Path(__file__).resolve().parent.parent / "workflows"

# Excludes paid larger runners and third-party pools.
HOSTED_LABEL = re.compile(r"^(?:ubuntu-(?:latest|22\.04|24\.04|26\.04)(?:-arm)?|macos-(?:latest|14|15|26)(?:-intel)?|windows-(?:latest|2022|2025|11-arm))$")

# Runner labels that name hardware this account owns. `-runner` is a stronger
# signal than `-hosted`, so a label such as `linux-runner` is private by
# construction; `self-hosted` is GitHub's own selector.
PRIVATE_LABEL_HINT = ("self-hosted", "-runner")

# What the static scan looks for in workflow text: GitHub's self-hosted
# selector, the private labels this repository used to have, and the `bench-*`
# capacity pool. `android-emulator-runner` and other action names do not match.
FORBIDDEN_REFERENCE = re.compile(
    r"blacksmith-[a-z0-9.-]+|self-hosted|\b(?:linux|windows|macos)-runner\b|\bbench-[a-z0-9][a-z0-9.-]*"
)


def strip_comment(line):
    """Drop a trailing YAML comment without touching quoted `#` characters."""
    quote = None
    for index, char in enumerate(line):
        if quote:
            if char == quote:
                quote = None
        elif char in ("'", '"'):
            quote = char
        elif char == "#" and (index == 0 or line[index - 1] in " \t"):
            return line[:index]
    return line


def scan_workflows(workflows_dir=WORKFLOWS_DIR):
    """Return one message per workflow line that references a private runner."""
    problems = []
    paths = sorted(workflows_dir.glob("*.yml")) + sorted(workflows_dir.glob("*.yaml"))
    for path in paths:
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            code = strip_comment(line)
            match = FORBIDDEN_REFERENCE.search(code)
            if match:
                problems.append(
                    f"{path.name}:{number}: references private runner {match.group(0)!r}: "
                    f"{code.strip()}"
                )
    return problems


def check_label(name, label, required):
    """Return a message when `label` is empty-but-required or not a hosted pool."""
    if not label:
        if required:
            return f"inputs.{name} is empty; this workflow needs a hosted runner label"
        return None
    if any(hint in label for hint in PRIVATE_LABEL_HINT) or not HOSTED_LABEL.match(label):
        return (
            f"inputs.{name}={label!r} is not a hosted runner label; "
            "use a standard GitHub-hosted Ubuntu, macOS or Windows image"
        )
    return None


def check_labels(runner, verify_runner):
    """Validate the runner inputs of a reusable workflow."""
    problems = [
        message
        for message in (
            check_label("runner", runner, required=True),
            check_label("verify_runner", verify_runner, required=False),
        )
        if message
    ]
    return problems


def report(message):
    prefix = "::error::" if os.environ.get("GITHUB_ACTIONS") else "error: "
    print(f"{prefix}{message}", file=sys.stderr)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--runner",
        help="runner input of a reusable workflow; validates labels instead of scanning",
    )
    parser.add_argument(
        "--verify-runner",
        help="optional verify_runner input; empty means the workflow has no verify job",
    )
    parser.add_argument(
        "--workflows-dir",
        type=Path,
        default=WORKFLOWS_DIR,
        help=f"directory to scan (default: {WORKFLOWS_DIR})",
    )
    args = parser.parse_args(argv)

    if args.runner is None and args.verify_runner is None:
        problems = scan_workflows(args.workflows_dir)
        checked = "workflow runner references"
    else:
        # A caller may pass neither flag through the shell, so both are checked.
        problems = check_labels(args.runner or "", args.verify_runner or "")
        checked = "runner inputs"

    for problem in problems:
        report(problem)
    if problems:
        return 1
    print(f"All {checked} name hosted runner pools.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

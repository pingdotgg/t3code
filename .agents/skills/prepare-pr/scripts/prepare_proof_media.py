#!/usr/bin/env python3
"""Prepare contextual PNG/GIF evidence for pull requests."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Any, Dict, List, Sequence, Tuple


class ProofMediaError(RuntimeError):
    pass


def run(command: Sequence[str], *, capture: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(
        list(command),
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


def tool_version(executable: str) -> str:
    result = run([executable, "-version"], capture=True)
    output = result.stdout or result.stderr
    return output.splitlines()[0] if output else "unknown"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(".{0}.tmp".format(path.name))
    temporary.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def validate_packet_paths(inputs: Sequence[Path], destinations: Sequence[Path]) -> None:
    for destination in destinations:
        if destination.is_symlink():
            raise ProofMediaError("Output path must not be a symlink: {0}".format(destination))
        for source in inputs:
            if destination == source:
                raise ProofMediaError("An output path would overwrite an input: {0}".format(source))
            if destination.exists():
                try:
                    if destination.samefile(source):
                        raise ProofMediaError("An output aliases an input: {0}".format(source))
                except OSError:
                    pass


def publish_packet(staged: Sequence[Tuple[Path, Path]], receipt_destination: Path) -> None:
    ordered = [pair for pair in staged if pair[1] != receipt_destination]
    ordered.extend(pair for pair in staged if pair[1] == receipt_destination)
    if not ordered:
        return
    backups: List[Tuple[Path, Path]] = []
    installed: List[Path] = []
    backup_root = Path(
        tempfile.mkdtemp(prefix=".prepare-proof-recovery-", dir=str(receipt_destination.parent))
    )
    try:
        for index, (source, destination) in enumerate(ordered):
            if destination.exists():
                backup = backup_root / "{0}-{1}".format(index, destination.name)
                destination.replace(backup)
                backups.append((backup, destination))
            source.replace(destination)
            installed.append(destination)
    except BaseException as publish_error:
        recovery_errors: List[str] = []
        for destination in reversed(installed):
            try:
                destination.unlink(missing_ok=True)
            except BaseException as exc:
                recovery_errors.append("remove {0}: {1}".format(destination, repr(exc)))
        for backup, destination in reversed(backups):
            try:
                backup.replace(destination)
            except BaseException as exc:
                recovery_errors.append(
                    "restore {0} to {1}: {2}".format(backup, destination, repr(exc))
                )
        if recovery_errors:
            evidence_path = backup_root / "recovery.json"
            evidence = {
                "version": 1,
                "publish_error": repr(publish_error),
                "recovery_errors": recovery_errors,
                "backups": [
                    {
                        "backup": str(backup),
                        "destination": str(destination),
                        "backup_exists": backup.exists(),
                        "backup_sha256": sha256(backup) if backup.is_file() else None,
                    }
                    for backup, destination in backups
                ],
            }
            try:
                atomic_write_json(evidence_path, evidence)
            except BaseException as evidence_error:
                recovery_errors.append(
                    "write recovery evidence {0}: {1}".format(
                        evidence_path, repr(evidence_error)
                    )
                )
            raise ProofMediaError(
                "Packet publication failed and rollback was incomplete. "
                "Recovery files remain at {0}: {1}".format(
                    backup_root, "; ".join(recovery_errors)
                )
            ) from publish_error
        shutil.rmtree(backup_root, ignore_errors=True)
        raise
    shutil.rmtree(backup_root, ignore_errors=True)


def safe_stem(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", value):
        raise ProofMediaError("Output stem must contain only letters, digits, dot, underscore, or hyphen")
    return value


def parser() -> argparse.ArgumentParser:
    from detail_crop import build_detail, parse_region

    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    detail_parser = commands.add_parser("detail", help="crop PNG/GIF evidence around semantic regions or detected changes")
    detail_parser.add_argument("source")
    detail_parser.add_argument("--before", help="matching baseline; both captures receive the same crop")
    detail_parser.add_argument("--region", type=parse_region, action="append", default=[], help="repeatable normalized x,y,width,height; overrides pixel-change detection")
    detail_parser.add_argument("--reason", required=True, help="what the reviewer must see and why this framing proves it")
    detail_parser.add_argument("--padding", type=float, default=0.15)
    detail_parser.add_argument("--difference-threshold", type=float, default=5.0, help="percent channel difference used only without --region")
    detail_parser.add_argument("--max-width", type=int, default=960, help="maximum output width; never enlarges pixels")
    detail_parser.add_argument("--output-dir", required=True)
    detail_parser.add_argument("--stem")
    detail_parser.add_argument("--overwrite", action="store_true")
    detail_parser.set_defaults(handler=build_detail)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        args.handler(args)
    except (ProofMediaError, subprocess.CalledProcessError) as exc:
        print("prepare-proof-media: {0}".format(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    # The detail subcommand imports shared helpers from this module. Reuse the
    # CLI module so its ProofMediaError has the identity caught by main().
    sys.modules["prepare_proof_media"] = sys.modules[__name__]
    sys.exit(main())
